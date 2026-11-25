import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {normalizeAnswer,parseBenchmark} from './blind-trials.mjs';
import {unpaused} from './consent-ledger.mjs';
import {hash,validWallet} from './security.mjs';

const base = '/api/data-ablation';
const uuid = z.string().uuid();
const maxTrainingRows = 1000;
const minCases = 10;
const studySchema = z.object({
  benchmark:uuid,
  sources:z.array(uuid).min(2).max(5)
}).strict().refine(({benchmark,sources}) => new Set([benchmark,...sources]).size === sources.length+1,
  'Use a separate benchmark and distinct training dataset versions.');
const trainingSchema = z.array(z.object({
  text:z.string().trim().min(3).max(1000),
  label:z.string().trim().min(1).max(80)
}).strict()).min(2).max(maxTrainingRows);

const tokens = text => normalizeAnswer(text).match(/[\p{L}\p{N}]+/gu) ?? [];
const textKey = text => tokens(text).join(' ');

export function measureAblation(cases,sources) {
  const benchmarkKeys = new Set(cases.map(item => textKey(item.prompt)));
  if (benchmarkKeys.has('') || benchmarkKeys.size !== cases.length ||
      sources.some(rows => rows.some(row => benchmarkKeys.has(textKey(row.text))))) {
    throw new Error('The holdout and training inputs do not satisfy study requirements.');
  }

  // Only the evaluation depends on benchmark text. Each training fold has its own vocabulary.
  const evaluation = cases.map(item => ({
    words:tokens(item.prompt),
    expected:normalizeAnswer(item.expectedAnswer)
  }));
  const summaries = sources.map(rows => {
    const classes = new Map();
    for (const row of rows) {
      const label = normalizeAnswer(row.label);
      if (!classes.has(label)) classes.set(label,{documents:0,total:0,words:new Map()});
      const stats = classes.get(label);
      stats.documents++;
      for (const word of tokens(row.text)) {
        stats.words.set(word,(stats.words.get(word) ?? 0)+1);
        stats.total++;
      }
    }
    return classes;
  });

  function score(excluded) {
    const classes = new Map();
    const vocabulary = new Set();
    const included = summaries.filter((_,index) => index !== excluded);
    let documents = 0;
    for (const summary of included) {
      for (const [label,source] of summary) {
        if (!classes.has(label)) classes.set(label,{documents:0,total:0,words:new Map()});
        const target = classes.get(label);
        target.documents += source.documents;
        target.total += source.total;
        documents += source.documents;
        for (const [word,count] of source.words) {
          vocabulary.add(word);
          target.words.set(word,(target.words.get(word) ?? 0)+count);
        }
      }
    }
    if (classes.size < 2 || classes.size > 32 || vocabulary.size === 0) {
      throw new Error('Each training fold needs 2–32 labels and nonempty vocabulary.');
    }
    const ordered = [...classes.keys()].sort();
    let correct = 0;
    for (const {words,expected} of evaluation) {
      let best = -Infinity, prediction;
      for (const label of ordered) {
        const stats = classes.get(label);
        let likelihood = Math.log(stats.documents/documents);
        for (const word of words) {
          if (vocabulary.has(word)) likelihood += Math.log(((stats.words.get(word) ?? 0)+1)/(stats.total+vocabulary.size));
        }
        if (likelihood > best) {
          best = likelihood;
          prediction = label;
        }
      }
      correct += Number(prediction === expected);
    }
    return correct;
  }

  const full = score(-1);
  return sources.map((_,index) => {
    const difference = full-score(index);
    return Math.sign(difference)*Math.round(Math.abs(difference)*5/cases.length)*20 || 0;
  });
}

export async function installDataAblation(app,{db,storage,authenticated,env,attestationClient}) {
  const enabled = Boolean(attestationClient && env.CONFIDENTIAL_RUNTIME === 'phala' &&
    env.CONFIDENTIAL_READY === 'true');
  app.get(base+'/status',(_req,res) => res.json({enabled,minCases,maxTrainingRows,maxSources:5}));
  if (!attestationClient) return;
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS ablation_studies (id TEXT PRIMARY KEY, buyer TEXT NOT NULL, manifest TEXT NOT NULL, created BIGINT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS ablation_permissions (study TEXT NOT NULL, dataset TEXT NOT NULL, commitment TEXT NOT NULL, approval TEXT NOT NULL, PRIMARY KEY(study,dataset))',
    'CREATE TABLE IF NOT EXISTS ablation_results (benchmark_fingerprint TEXT PRIMARY KEY, study TEXT UNIQUE NOT NULL, document TEXT NOT NULL)'
  ]) await db.query(sql);

  const ready = (_req,res,next) => {
    res.set('Cache-Control','no-store');
    return enabled ? next() : res.status(503).json({error:'Attested ablation runtime unavailable.'});
  };
  const findStudy = id => db.one('SELECT buyer,manifest FROM ablation_studies WHERE id=?',[id]);
  const active = `d.state<>'published' AND ${unpaused}`;
  const permissionJoin = `FROM ablation_permissions p JOIN datasets d ON d.id=p.dataset AND d.commitment=p.commitment`;
  const approvals = async study => (await db.query(`SELECT d.id,d.commitment,d.fingerprint,p.approval ${permissionJoin}
    WHERE p.study=? AND ${active}`,[study])).rows;
  const saved = study => db.one('SELECT document FROM ablation_results WHERE study=?',[study]);

  app.post(base+'/studies',authenticated,ready,async(req,res) => {
    const manifest = studySchema.parse(req.body);
    const id = randomUUID();
    await db.query('INSERT INTO ablation_studies VALUES (?,?,?,?)',[id,req.wallet,JSON.stringify(manifest),Date.now()]);
    res.status(201).json({id});
  });

  app.post(base+'/studies/:id/permission',authenticated,ready,async(req,res) => {
    const id = uuid.parse(req.params.id);
    const {dataset,buyer,role,approve} = z.object({dataset:uuid,buyer:z.string().refine(validWallet),
      role:z.enum(['benchmark','training']),approve:z.boolean()}).strict().parse(req.body);
    const study = await findStudy(id);
    const manifest = study && JSON.parse(study.manifest);
    if (!study || study.buyer !== buyer || !(role === 'benchmark' ? manifest.benchmark === dataset : manifest.sources.includes(dataset))) {
      return res.status(404).json({error:'Study or dataset unavailable.'});
    }
    if (!approve) {
      await db.query(`DELETE FROM ablation_permissions WHERE study=? AND dataset IN
        (SELECT id FROM datasets WHERE id=? AND owner=?)`,[id,dataset,req.wallet]);
      return res.sendStatus(204);
    }
    const result = await db.one(`INSERT INTO ablation_permissions(study,dataset,commitment,approval)
      SELECT ?,d.id,d.commitment,? FROM datasets d WHERE d.id=? AND d.owner=? AND ${active}
      ON CONFLICT(study,dataset) DO UPDATE SET commitment=excluded.commitment,approval=excluded.approval RETURNING dataset`,
      [id,randomUUID(),dataset,req.wallet]);
    if (!result) return res.status(404).json({error:'Study or dataset unavailable.'});
    res.sendStatus(204);
  });

  app.post(base+'/studies/:id/run',authenticated,ready,async(req,res) => {
    const id = uuid.parse(req.params.id);
    const study = await findStudy(id);
    if (!study || study.buyer !== req.wallet) return res.status(404).json({error:'Study unavailable.'});
    const previous = await saved(id);
    if (previous) return res.json(JSON.parse(previous.document));

    const {benchmark,sources} = JSON.parse(study.manifest);
    const granted = new Map((await approvals(id)).map(dataset => [dataset.id,dataset]));
    const inputs = [benchmark,...sources].map(dataset => granted.get(dataset));
    if (inputs.some(dataset => !dataset)) return res.status(409).json({error:'Every dataset owner must approve this study.'});
    const budgetKey = inputs[0].fingerprint || inputs[0].commitment;
    if (await db.one('SELECT study FROM ablation_results WHERE benchmark_fingerprint=?',[budgetKey])) {
      return res.status(409).json({error:'This benchmark already released a study report.'});
    }

    const contents = await Promise.all(inputs.map(dataset => storage.get(dataset.id)));
    if (contents.some((object,index) => !object.salt || hash(object.salt+'\n'+object.content) !== inputs[index].commitment)) {
      return res.status(409).json({error:'A dataset version could not be verified.'});
    }
    let differences;
    try {
      const cases = parseBenchmark(contents[0].content);
      if (cases.length < minCases) throw new Error('Too few benchmark cases.');
      const training = contents.slice(1).map(object => trainingSchema.parse(JSON.parse(object.content)));
      differences = measureAblation(cases,training);
    } catch {
      return res.status(422).json({error:'The approved inputs do not meet the format or holdout requirements.'});
    }

    const report = {
      format:'dataloom-data-ablation-v1',
      study:id,
      benchmarkCommitment:inputs[0].commitment,
      method:'multinomial-naive-bayes-leave-one-source-out',
      roundingPercentagePoints:20,
      differences:sources.map((dataset,index) => ({
        dataset,commitment:inputs[index+1].commitment,accuracyDeltaPoints:differences[index]
      }))
    };
    const reportData = hash(JSON.stringify(report));
    const quote = await attestationClient.getQuote(Buffer.from(reportData,'hex'));
    if (!quote?.quote) return res.status(503).json({error:'Study attestation unavailable.'});
    const document = JSON.stringify({report,attestation:{reportData,quote}});
    const placeholders = inputs.map(() => '?').join(',');
    const result = await db.one(`INSERT INTO ablation_results(benchmark_fingerprint,study,document)
      SELECT ?,?,? WHERE (SELECT COUNT(*) ${permissionJoin} WHERE p.study=? AND ${active}
        AND p.approval IN (${placeholders}))=?
      ON CONFLICT DO NOTHING RETURNING document`,
      [budgetKey,id,document,id,...inputs.map(dataset => dataset.approval),inputs.length]);
    if (result) return res.status(201).json(JSON.parse(result.document));
    const concurrent = await saved(id);
    if (concurrent) return res.json(JSON.parse(concurrent.document));
    res.status(409).json({error:'Study permissions changed or the benchmark already released a report.'});
  });
}
