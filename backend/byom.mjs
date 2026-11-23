import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {parseBenchmark, normalizeAnswer} from './blind-trials.mjs';
import {unpaused} from './consent-ledger.mjs';
import {hash, validWallet} from './security.mjs';

const uuid = z.string().uuid();
const format = 'linear-text-v1';
const minimumCases = 10;
const maximumRuns = 5;
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const weight = z.number().finite().min(-10000).max(10000);
const modelSchema = z.object({
  format: z.literal(format),
  vocabulary: z.array(z.string().regex(/^[a-z0-9]{1,40}$/)).min(1).max(512),
  classes: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    bias: weight,
    weights: z.array(weight).max(512)
  }).strict()).min(2).max(12)
}).strict().refine(model =>
  new Set(model.vocabulary).size === model.vocabulary.length &&
  new Set(model.classes.map(c => normalizeAnswer(c.label))).size === model.classes.length &&
  model.classes.every(c => c.weights.length === model.vocabulary.length),
  'Vocabulary and labels must be distinct and each weight vector must match the vocabulary.');

export function scoreLinearModel(cases, model) {
  const indices = new Map(model.vocabulary.map((word,i) => [word,i]));
  let correct = 0;
  for (const {prompt,expectedAnswer} of cases) {
    const counts = Array(model.vocabulary.length).fill(0);
    for (const token of normalizeAnswer(prompt).match(/[a-z0-9]+/g) ?? []) {
      const index = indices.get(token);
      if (index !== undefined) counts[index]++;
    }
    let best = -Infinity, prediction;
    for (const {label,bias,weights} of model.classes) {
      const value = weights.reduce((sum,w,i) => sum + w * counts[i],bias);
      if (value > best) { best = value; prediction = label; }
    }
    if (normalizeAnswer(prediction) === normalizeAnswer(expectedAnswer)) correct++;
  }
  const lower = Math.min(80, Math.floor(correct * 5 / cases.length) * 20);
  return {lower, upper: lower + 20, upperInclusive: lower === 80};
}

export async function installByom(app, {db,storage,authenticated,env,attestationClient}) {
  const base = '/api/byom';
  const enabled = Boolean(attestationClient && env.CONFIDENTIAL_RUNTIME === 'phala' && env.CONFIDENTIAL_READY === 'true');
  app.get(base + '/status', (_req,res) => res.json({enabled,modelFormats:[format],minimumCases,maximumRunsPerDatasetVersion:maximumRuns}));
  if (!attestationClient) return;
  await db.query(`CREATE TABLE IF NOT EXISTS byom_grants (
    dataset TEXT NOT NULL, buyer TEXT NOT NULL, commitment TEXT NOT NULL, active INTEGER NOT NULL,
    PRIMARY KEY(dataset,buyer))`);
  await db.query(`CREATE TABLE IF NOT EXISTS byom_limits (
    dataset TEXT PRIMARY KEY, used INTEGER NOT NULL CHECK(used>=0))`);
  await db.query(`CREATE TABLE IF NOT EXISTS byom_runs (
    dataset TEXT NOT NULL, buyer TEXT NOT NULL, id TEXT NOT NULL UNIQUE, model_hash TEXT NOT NULL,
    PRIMARY KEY(dataset,buyer))`);
  const ready = (_req,res,next) => enabled ? next() : res.status(503).json({error:'Attested benchmark runtime unavailable.'});
  const available = `SELECT d.id,d.commitment FROM datasets d WHERE d.id=? AND d.state<>'published' AND ${unpaused}`;
  const access = `SELECT d.id,d.commitment FROM datasets d JOIN byom_grants g
    ON g.dataset=d.id AND g.commitment=d.commitment WHERE d.id=? AND g.buyer=? AND g.active=1
    AND d.state<>'published' AND ${unpaused}`;
  const findRun = (tx,dataset,buyer) => tx.one('SELECT id,model_hash FROM byom_runs WHERE dataset=? AND buyer=?',[dataset,buyer]);
  const reply = async (id,res) => res.json(await storage.get(id));
  const loadCases = async dataset => {
    const object = await storage.get(dataset.id);
    if (!object.salt || hash(object.salt+'\n'+object.content) !== dataset.commitment) return null;
    const cases = parseBenchmark(object.content);
    const distinct = new Set(cases.map(item => (normalizeAnswer(item.prompt).match(/[a-z0-9]+/g) ?? []).join(' ')));
    return cases.length >= minimumCases && !distinct.has('') && distinct.size === cases.length ? cases : null;
  };

  app.post(base + '/grants',authenticated,ready,async(req,res) => {
    const {dataset,buyer,enabled:active} = z.object({dataset:uuid,buyer:z.string().refine(validWallet),
      enabled:z.boolean(),consent:z.literal(true)}).strict().parse(req.body);
    const source = await db.one((active ? available : 'SELECT d.id,d.commitment FROM datasets d WHERE d.id=?') + ' AND d.owner=?',
      [dataset,req.wallet]);
    if (!source) return res.status(404).json({error:'Dataset unavailable.'});
    if (active) {
      let cases;
      try { cases = await loadCases(source); } catch (error) {
        if (!(error instanceof z.ZodError) && !error.message.startsWith('Benchmark must') &&
            !error.message.startsWith('Every public category')) throw error;
      }
      if (!cases) return res.status(422).json({error:'An intact private benchmark with 10–20 distinct prompts is required.'});
    }
    await db.query(`INSERT INTO byom_grants VALUES(?,?,?,?) ON CONFLICT(dataset,buyer)
      DO UPDATE SET commitment=excluded.commitment,active=excluded.active`,[dataset,buyer,source.commitment,Number(active)]);
    res.json({enabled:active});
  });

  app.get(base + '/benchmarks',authenticated,ready,async(req,res) => {
    const {rows} = await db.query(`SELECT d.id,d.title,d.commitment FROM datasets d
      JOIN byom_grants g ON g.dataset=d.id AND g.commitment=d.commitment
      WHERE g.buyer=? AND g.active=1 AND d.state<>'published' AND ${unpaused}
      ORDER BY d.created DESC LIMIT 100`,[req.wallet]);
    res.json({benchmarks:rows});
  });

  app.get(base + '/scorecards/:dataset',authenticated,ready,async(req,res) => {
    const run = await findRun(db,uuid.parse(req.params.dataset),req.wallet);
    if (!run) return res.status(404).json({error:'Scorecard unavailable.'});
    await reply(run.id,res);
  });

  app.post(base + '/runs',authenticated,ready,async(req,res) => {
    const {dataset,model,nonce,consent} = z.object({dataset:uuid,model:modelSchema,nonce:hex,
      consent:z.literal(true)}).strict().parse(req.body);
    const modelHash = hash(JSON.stringify(model));
    const previous = await findRun(db,dataset,req.wallet);
    if (previous) return previous.model_hash === modelHash ? reply(previous.id,res) :
      res.status(409).json({error:'This wallet already used its run for this benchmark version.'});
    const source = await db.one(access,[dataset,req.wallet]);
    if (!source) return res.status(404).json({error:'An active contributor grant is required.'});
    const cases = await loadCases(source);
    if (!cases) return res.status(409).json({error:'The approved benchmark is unavailable.'});
    const id = randomUUID();
    let writeAttempted = false;
    try {
      const run = await db.transaction(async tx => {
        await tx.query('INSERT INTO byom_limits VALUES (?,0) ON CONFLICT(dataset) DO NOTHING',[dataset]);
        const slot = await tx.one('UPDATE byom_limits SET used=used+1 WHERE dataset=? AND used<? RETURNING used',[dataset,maximumRuns]);
        const existing = await findRun(tx,dataset,req.wallet);
        if (existing) throw {existing};
        if (!slot) throw exhausted;
        if (!(await tx.one(access,[dataset,req.wallet]))) throw revoked;
        const scorecard = {id,dataset,sourceCommitment:source.commitment,modelHash,modelFormat:format,
          scoring:'normalized-exact-match-20-point-band-v1',accuracyPercent:scoreLinearModel(cases,model),nonce};
        const reportData = hash(JSON.stringify(scorecard));
        const quote = await attestationClient.getQuote(Buffer.from(reportData,'hex'));
        if (!(await tx.one(access,[dataset,req.wallet]))) throw revoked;
        writeAttempted = true;
        await storage.put(id,{scorecard,attestation:{reportData,quote}});
        await tx.query('INSERT INTO byom_runs VALUES (?,?,?,?)',[dataset,req.wallet,id,modelHash]);
        return id;
      });
      await reply(run,res.status(201));
    } catch (error) {
      if (writeAttempted && !(await findRun(db,dataset,req.wallet))) await storage.remove(id).catch(()=>{});
      if (error.existing) return error.existing.model_hash === modelHash ? reply(error.existing.id,res) :
        res.status(409).json({error:'This wallet already used its run for this benchmark version.'});
      if (error === exhausted) return res.status(429).json({error:'This benchmark version reached its scorecard limit.'});
      if (error === revoked) return res.status(409).json({error:'Benchmark permission changed.'});
      throw error;
    }
  });
}

const exhausted = new Error('Scorecard limit reached');
const revoked = new Error('Benchmark permission changed');
