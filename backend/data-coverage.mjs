import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {unpaused} from './consent-ledger.mjs';
import {hash} from './security.mjs';

const base = '/api/data-coverage';
const manage = '/api/my/data-coverage';
const uuid = z.string().uuid();
const maxRows = 10000;
const rowsSchema = z.array(z.record(z.string(),z.json())).min(1).max(maxRows);
const threshold = z.number().int().min(1).max(maxRows);
const request = z.object({
  dataset:uuid,
  minRecords:threshold,
  categoryField:z.string().trim().min(1).max(100),
  minCategories:threshold,
  consent:z.literal(true)
}).strict();

export function meetsCoverage(rows,{minRecords,categoryField,minCategories}) {
  let records = 0;
  const categories = new Set();
  for (const row of rows) {
    if (!Object.hasOwn(row,categoryField)) continue;
    const value = row[categoryField];
    if (typeof value !== 'string' || !value.trim()) continue;
    records++;
    categories.add(value.normalize('NFC').trim().toLowerCase());
  }
  return records >= minRecords && categories.size >= minCategories;
}

export async function installDataCoverage(app,{db,storage,authenticated,env,attestationClient}) {
  const enabled = Boolean(attestationClient && env.CONFIDENTIAL_RUNTIME === 'phala' &&
    env.CONFIDENTIAL_READY === 'true');
  const eligible = `d.state<>'published' AND ${unpaused}`;
  await db.query(`CREATE TABLE IF NOT EXISTS data_coverage_proofs (
    dataset TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, commitment TEXT NOT NULL, document TEXT NOT NULL
  )`);

  app.get(base+'/status',(_req,res) => res.json({enabled,maxRows}));
  app.get(base+'/proofs/:token',async(req,res) => {
    res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, noarchive','Referrer-Policy':'no-referrer'});
    if (!uuid.safeParse(req.params.token).success) return res.sendStatus(404);
    const proof = await db.one(`SELECT p.document FROM data_coverage_proofs p
      JOIN datasets d ON d.id=p.dataset AND d.commitment=p.commitment
      WHERE p.token=? AND ${eligible}`,[req.params.token]);
    if (!proof) return res.status(404).json({error:'Coverage proof unavailable.'});
    res.json(JSON.parse(proof.document));
  });

  app.post(manage,authenticated,async(req,res) => {
    res.set('Cache-Control','no-store');
    if (!enabled) return res.status(503).json({error:'Attested coverage runtime unavailable.'});
    const {dataset,consent,...claim} = request.parse(req.body);
    const source = await db.one(`SELECT d.id,d.commitment FROM datasets d
      WHERE d.id=? AND d.owner=? AND ${eligible}`,[dataset,req.wallet]);
    if (!source) return res.status(404).json({error:'Active private dataset unavailable.'});
    const object = await storage.get(source.id);
    if (!object.salt || hash(object.salt+'\n'+object.content) !== source.commitment) {
      return res.status(409).json({error:'Dataset commitment verification failed.'});
    }

    let rows;
    try {
      rows = rowsSchema.parse(JSON.parse(object.content));
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      return res.status(422).json({error:'Use a JSON array containing 1–10,000 row objects.'});
    }
    if (!meetsCoverage(rows,claim)) {
      return res.status(422).json({error:'The dataset does not meet both coverage thresholds.'});
    }

    const token = randomUUID();
    const report = {
      format:'dataloom-data-coverage-v1',
      proofId:token,
      datasetVersion:source.id,
      sourceCommitment:source.commitment,
      claim,
      evaluatedAt:new Date().toISOString()
    };
    const reportData = hash(JSON.stringify(report));
    const quote = await attestationClient.getQuote(Buffer.from(reportData,'hex'));
    if (!quote?.quote) return res.status(503).json({error:'Coverage attestation unavailable.'});
    const document = JSON.stringify({report,attestation:{reportData,quote}});
    const result = await db.query(`INSERT INTO data_coverage_proofs(dataset,token,commitment,document)
      SELECT d.id,?,d.commitment,? FROM datasets d WHERE d.id=? AND d.owner=? AND d.commitment=? AND ${eligible}
      ON CONFLICT(dataset) DO UPDATE SET token=excluded.token,commitment=excluded.commitment,document=excluded.document
      RETURNING token`,[token,document,dataset,req.wallet,source.commitment]);
    if (!result.rows.length) return res.status(409).json({error:'Dataset access changed during attestation.'});
    res.status(201).json({path:base+'/proofs/'+token});
  });

  app.delete(manage+'/:dataset',authenticated,async(req,res) => {
    await db.query(`DELETE FROM data_coverage_proofs WHERE dataset IN
      (SELECT id FROM datasets WHERE id=? AND owner=?)`,[uuid.parse(req.params.dataset),req.wallet]);
    res.sendStatus(204);
  });
}
