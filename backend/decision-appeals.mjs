import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {validatePhalaReceipt} from './phala-inference.mjs';

const uuid = z.string().uuid();
const note = z.string().trim().min(3).max(2000);
const actions = z.discriminatedUnion('action', [
  z.object({action: z.literal('request-evidence'), note}).strict(),
  z.object({action: z.literal('submit-evidence'), note}).strict(),
  z.object({action: z.literal('resolve'), note}).strict()
]);

export async function installDecisionAppeals(app, {db, storage, authenticated, grantSelect, sourceAvailable}) {
  await db.query(`CREATE TABLE IF NOT EXISTS decision_appeals(
    id TEXT PRIMARY KEY, call_id TEXT NOT NULL UNIQUE, grant_id TEXT NOT NULL,
    buyer TEXT NOT NULL, reviewer TEXT NOT NULL, state TEXT NOT NULL,
    issue TEXT NOT NULL, question TEXT, evidence TEXT, resolution TEXT, created BIGINT NOT NULL)`);
  const base = '/api/my/decision-appeals';

  async function verifiedCall(id) {
    const call = await db.one('SELECT * FROM agent_calls WHERE id=? AND signature IS NOT NULL AND signature<>?', [id, '']);
    if (!call) return null;
    const quote = JSON.parse(call.quote);
    if (quote.batch || quote.dataRequest || !quote.inputHash) return null;
    const grant = await db.one(grantSelect + ' WHERE g.id=? AND g.revoked=0', [call.grant_id]);
    if (!grant || !await sourceAvailable(grant)) return null;
    const result = await storage.get(id);
    const evidence = result.evidence;
    if (result.source?.id !== grant.dataset || result.source?.commitment !== grant.commitment || evidence?.provider !== 'phala' ||
        !evidence.receiptId || typeof result.output?.decision !== 'string') return null;
    try {
      validatePhalaReceipt({receipt_id: evidence.receiptId, verdict: {verified: true}, checks: evidence.checks}, evidence.receiptId);
    } catch {
      return null;
    }
    return {call, quote, grant, result};
  }

  async function view(row, wallet) {
    const objects = await Promise.all(['issue','question','evidence','resolution'].map(key =>
      row[key] ? storage.get(row[key]) : null));
    const [issue, question, evidence, resolution] = objects.map(object => object?.note ?? null);
    return {id: row.id, call: row.call_id, role: row.buyer === wallet ? 'buyer' : 'reviewer',
      state: row.state, issue, question, evidence, resolution, created: Number(row.created)};
  }

  app.get('/api/decision-appeals/status', (_req, res) => res.json({enabled: true, path: base, requiresPaidVerifiedCall: true}));

  app.get(base, authenticated, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const {rows} = await db.query(`SELECT * FROM decision_appeals
      WHERE buyer=? OR reviewer=? ORDER BY created DESC LIMIT 40`, [req.wallet, req.wallet]);
    res.json({appeals: await Promise.all(rows.map(row => view(row, req.wallet)))});
  });

  app.post(base, authenticated, async (req, res) => {
    const body = z.object({call: uuid, note, consent: z.literal(true)}).strict().parse(req.body);
    const paid = await db.one(`SELECT c.id FROM agent_calls c JOIN agent_grants g ON g.id=c.grant_id
      WHERE c.id=? AND g.buyer=?`, [body.call, req.wallet]);
    const source = paid && await verifiedCall(body.call);
    if (!source || source.grant.buyer !== req.wallet || source.grant.owner === req.wallet) {
      return res.status(404).json({error: 'Eligible paid decision with a separate contributor required.'});
    }
    const id = randomUUID();
    const issue = randomUUID();
    await storage.put(issue, {note: body.note});
    try {
      const {rows} = await db.query(`INSERT INTO decision_appeals
        (id,call_id,grant_id,buyer,reviewer,state,issue,created)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM agent_grants WHERE id=? AND revoked=0)
        ON CONFLICT(call_id) DO NOTHING RETURNING id`,
        [id, body.call, source.grant.id, req.wallet, source.grant.owner, 'open', issue, Date.now(), source.grant.id]);
      if (rows.length) return res.status(201).json({id});
    } catch (error) {
      await storage.remove(issue).catch(() => {});
      throw error;
    }
    await storage.remove(issue);
    res.status(409).json({error: 'An appeal already exists or the grant was revoked.'});
  });

  app.post(base + '/:id/action', authenticated, async (req, res) => {
    const {action, note: text} = actions.parse(req.body);
    const id = uuid.parse(req.params.id);
    const row = await db.one('SELECT * FROM decision_appeals WHERE id=? AND (buyer=? OR reviewer=?)', [id, req.wallet, req.wallet]);
    if (!row) return res.status(404).json({error: 'Appeal unavailable.'});
    const transition = {
      'request-evidence': {who: row.reviewer, from: ['open'], to: 'evidence-requested', field: 'question'},
      'submit-evidence': {who: row.buyer, from: ['evidence-requested'], to: 'evidence-submitted', field: 'evidence'},
      resolve: {who: row.reviewer, from: ['open','evidence-submitted'], to: 'resolved', field: 'resolution'}
    }[action];
    if (req.wallet !== transition.who || !transition.from.includes(row.state)) {
      return res.status(409).json({error: 'This action is unavailable for the current appeal.'});
    }
    const object = randomUUID();
    await storage.put(object, {note: text});
    try {
      const {rows} = await db.query(`UPDATE decision_appeals SET state=?, ${transition.field}=?
        WHERE id=? AND state=? RETURNING id`, [transition.to, object, id, row.state]);
      if (rows.length) return res.json({state: transition.to});
    } catch (error) {
      await storage.remove(object).catch(() => {});
      throw error;
    }
    await storage.remove(object);
    res.status(409).json({error: 'Another action updated this appeal.'});
  });

  app.post(base + '/:id/compare', authenticated, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const {call} = z.object({call: uuid}).strict().parse(req.body);
    const row = await db.one('SELECT * FROM decision_appeals WHERE id=? AND buyer=?', [uuid.parse(req.params.id), req.wallet]);
    if (!row) return res.status(404).json({error: 'Appeal unavailable.'});
    const matched = await db.one('SELECT id FROM agent_calls WHERE id=? AND grant_id=?', [call, row.grant_id]);
    if (!matched || call === row.call_id) return res.status(422).json({error: 'Choose a distinct paid call under the same grant.'});
    const [original, rerun] = await Promise.all([verifiedCall(row.call_id), verifiedCall(call)]);
    if (!original || !rerun || original.quote.inputHash !== rerun.quote.inputHash ||
        original.result.source.commitment !== rerun.result.source.commitment ||
        Number(rerun.call.created) <= Number(original.call.created)) {
      return res.status(422).json({error: 'A later verified decision for the same input and dataset version is required.'});
    }
    const summarize = ({result}) => ({decision: result.output.decision, receipt: result.evidence.receiptId});
    res.json({original: summarize(original), rerun: summarize(rerun),
      changed: original.result.output.decision !== rerun.result.output.decision});
  });
}
