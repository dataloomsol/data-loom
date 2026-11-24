import {z} from 'zod';
import {unpaused} from './consent-ledger.mjs';
import {hash} from './security.mjs';

const field = z.string().trim().min(1).max(100);
const date = z.iso.date();
const rule = z.discriminatedUnion('type', [
  z.object({type:z.literal('required-field'),field}).strict(),
  z.object({type:z.literal('date-range'),field,from:date,to:date}).strict()
]).refine(rule => rule.type !== 'date-range' || rule.from <= rule.to, 'Start date must precede or equal end date.');
const request = z.object({dataset:z.string().uuid(),rule,nonce:z.string().regex(/^[a-f0-9]{64}$/),
  consent:z.literal(true)}).strict();
const datasetRows = z.array(z.record(z.string(),z.json())).min(1).max(10000);

export function validatePrivateRows(rows, rule) {
  return rows.length > 0 && rows.every(row => {
    if (!Object.hasOwn(row,rule.field)) return false;
    const value = row[rule.field];
    if (rule.type === 'date-range') return date.safeParse(value).success && rule.from <= value && value <= rule.to;
    return typeof value === 'string' ? Boolean(value.trim()) :
      typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  });
}

export function installPrivateValidation(app,{db,storage,authenticated,env,attestationClient}) {
  const enabled = Boolean(attestationClient && env.CONFIDENTIAL_RUNTIME === 'phala' &&
    env.CONFIDENTIAL_READY === 'true');
  app.get('/api/private-validation/status',(_req,res) => res.json({
    enabled,rules:['required-field','date-range'],maxRows:10000
  }));

  app.post('/api/my/private-validation',authenticated,async (req,res) => {
    res.set('Cache-Control','no-store');
    if (!enabled) return res.status(503).json({error:'Attested validation runtime unavailable.'});
    const body = request.parse(req.body);
    const loadSource = () => db.one(`SELECT d.id,d.commitment FROM datasets d
      WHERE d.id=? AND d.owner=? AND d.state<>'published' AND ${unpaused}`,[body.dataset,req.wallet]);
    const source = await loadSource();
    if (!source) return res.status(404).json({error:'Active private dataset unavailable.'});

    const object = await storage.get(source.id);
    if (!object.salt || hash(object.salt+'\n'+object.content) !== source.commitment) {
      return res.status(409).json({error:'Dataset commitment verification failed.'});
    }
    let rows;
    try {
      rows = datasetRows.parse(JSON.parse(object.content));
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      return res.status(422).json({error:'Use a JSON array containing 1–10,000 row objects.'});
    }

    const report = {
      format:'dataloom-private-validation-v1',
      sourceCommitment:source.commitment,
      rule:body.rule,
      passed:validatePrivateRows(rows,body.rule),
      nonce:body.nonce,
      evaluatedAt:new Date().toISOString()
    };
    const reportData = hash(JSON.stringify(report));
    const quote = await attestationClient.getQuote(Buffer.from(reportData,'hex'));
    if (!quote?.quote) return res.status(503).json({error:'Validation attestation unavailable.'});
    if ((await loadSource())?.commitment !== source.commitment) {
      return res.status(409).json({error:'Dataset access changed during validation.'});
    }
    res.json({report,attestation:{reportData,quote}});
  });
}
