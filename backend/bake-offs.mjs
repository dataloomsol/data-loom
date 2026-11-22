import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validWallet } from './security.mjs';
import { unpaused } from './consent-ledger.mjs';

const uuid = z.string().uuid();
const campaignInput = z.object({
  dataset: uuid,
  title: z.string().trim().min(3).max(100),
  vendors: z.array(z.string().refine(validWallet)).min(2).max(5)
    .refine(wallets => new Set(wallets).size === wallets.length),
}).strict();
const entryInput = z.object({
  label: z.string().trim().min(1).max(60),
  model: z.string().min(1).max(200),
  prompt: z.string().max(4000).optional(),
  consentToPublish: z.literal(true),
}).strict();

export async function installBakeOffs(app, {db, storage, authenticated, models, parseBenchmark, evaluateBenchmark, env, infer}) {
  await db.query(`CREATE TABLE IF NOT EXISTS bake_offs (
    id TEXT PRIMARY KEY, sponsor TEXT NOT NULL, day BIGINT NOT NULL, dataset TEXT NOT NULL,
    commitment TEXT NOT NULL, title TEXT NOT NULL, vendors TEXT NOT NULL, created BIGINT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0, UNIQUE(sponsor,day)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS bake_off_entries (
    id TEXT PRIMARY KEY, campaign TEXT NOT NULL, vendor TEXT NOT NULL, model TEXT NOT NULL,
    label TEXT NOT NULL, state TEXT NOT NULL, started BIGINT, result TEXT, UNIQUE(campaign,vendor)
  )`);
  const available = models.length > 0;
  const getCampaign = id => db.one('SELECT * FROM bake_offs WHERE id=?', [uuid.parse(id)]);
  async function entries(id) {
    await db.query("UPDATE bake_off_entries SET state='failed' WHERE campaign=? AND state='running' AND started<?",
      [id, Date.now()-50*60000]);
    return (await db.query('SELECT * FROM bake_off_entries WHERE campaign=? ORDER BY id', [id])).rows;
  }
  const source = (id, owner) => db.one(`SELECT d.id,d.commitment,d.title FROM datasets d JOIN trial_policies p ON p.dataset=d.id AND p.enabled=1
    WHERE d.id=? AND d.owner=? AND d.state='draft' AND ${unpaused}`, [id, owner]);
  const metric = row => ({
    label: row.label, model: row.model, state: row.state,
    ...(row.result ? JSON.parse(row.result) : {}),
  });
  function rankings(rows) {
    const sorted = rows.filter(row => row.state === 'complete').map(metric)
      .sort((a,b) => b.correct-a.correct || a.averageLatencyMs-b.averageLatencyMs);
    return sorted.map((row,index) => ({ rank:index+1, ...row }));
  }

  app.get('/api/bake-offs/status', (_req,res) => res.json({available, models}));
  app.get('/api/bake-offs/datasets', authenticated, async (req,res) => {
    const result = await db.query(`SELECT d.id,d.title FROM datasets d JOIN trial_policies p ON p.dataset=d.id
      WHERE d.owner=? AND d.state='draft' AND p.enabled=1 AND ${unpaused} ORDER BY d.created DESC LIMIT 100`, [req.wallet]);
    res.json(result.rows);
  });
  app.post('/api/bake-offs', authenticated, async (req,res) => {
    if (!available) return res.status(503).json({error:'Verified confidential benchmarks are unavailable'});
    const input = campaignInput.parse(req.body);
    if (input.vendors.includes(req.wallet)) return res.status(400).json({error:'Invite wallets other than the sponsor'});
    const dataset = await source(input.dataset, req.wallet);
    if (!dataset) return res.status(404).json({error:'Choose your own private, unpaused benchmark'});
    parseBenchmark((await storage.get(dataset.id)).content);
    const id = randomUUID();
    const now = Date.now();
    const created = await db.query(`INSERT INTO bake_offs(id,sponsor,day,dataset,commitment,title,vendors,created)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(sponsor,day) DO NOTHING RETURNING id`,
      [id,req.wallet,Math.floor(now/86400000),dataset.id,dataset.commitment,input.title,JSON.stringify(input.vendors),now]);
    if (!created.rows.length) return res.status(429).json({error:'One bake-off per sponsor per UTC day'});
    res.status(201).json({id});
  });
  app.get('/api/bake-offs/:id', async (req,res) => {
    res.set('Cache-Control','no-store');
    const campaign = await getCampaign(req.params.id);
    if (!campaign) return res.sendStatus(404);
    const sponsor = campaign.sponsor === req.wallet;
    const invited = JSON.parse(campaign.vendors).includes(req.wallet);
    if (!sponsor && !invited && !campaign.published) return res.sendStatus(404);
    const rows = await entries(campaign.id);
    res.json({
      id:campaign.id, title:campaign.title, commitment:campaign.commitment,
      role:sponsor?'sponsor':invited?'vendor':'viewer', published:!!campaign.published,
      ...(sponsor ? { entries:rows.map(row => ({id:row.id,vendor:row.vendor,...metric(row)})) } : {}),
      ...(invited ? { own:rows.filter(row => row.vendor === req.wallet).map(metric)[0] ?? null } : {}),
      ...(sponsor || campaign.published ? { rankings:rankings(rows) } : {}),
    });
  });
  app.post('/api/bake-offs/:id/entries', authenticated, async (req,res) => {
    if (!available) return res.status(503).json({error:'Verified confidential benchmarks are unavailable'});
    const campaign = await getCampaign(req.params.id);
    if (!campaign || !JSON.parse(campaign.vendors).includes(req.wallet)) return res.sendStatus(404);
    const input = entryInput.parse(req.body);
    if (!models.includes(input.model)) return res.status(400).json({error:'Choose a currently verified model'});
    const id = randomUUID();
    await storage.put(id, {prompt:input.prompt ?? ''});
    let result;
    try {
      result = await db.query(`INSERT INTO bake_off_entries(id,campaign,vendor,model,label,state)
        SELECT ?,id,?,?,?,'submitted' FROM bake_offs WHERE id=? AND published=0
        ON CONFLICT(campaign,vendor) DO NOTHING RETURNING id`,
        [id,req.wallet,input.model,input.label,campaign.id]);
    } catch (error) {
      await storage.remove(id);
      throw error;
    }
    if (!result.rows.length) {
      await storage.remove(id);
      return res.status(409).json({error:'An entry already exists or rankings are published'});
    }
    res.status(201).json({id});
  });
  app.post('/api/bake-offs/:id/evaluate/:entry', authenticated, async (req,res) => {
    if (!available) return res.status(503).json({error:'Verified confidential benchmarks are unavailable'});
    const campaign = await getCampaign(req.params.id);
    if (!campaign || campaign.sponsor !== req.wallet) return res.sendStatus(404);
    const entry = await db.one('SELECT * FROM bake_off_entries WHERE id=? AND campaign=?',[uuid.parse(req.params.entry),campaign.id]);
    if (!entry || !models.includes(entry.model)) return res.status(409).json({error:'Entry model is unavailable'});
    const checkConsent = async () => {
      const dataset = await source(campaign.dataset,campaign.sponsor);
      if (!dataset || dataset.commitment !== campaign.commitment) throw Error('Benchmark availability changed');
    };
    await checkConsent();
    const claimed = await db.query(`UPDATE bake_off_entries SET state='running',started=? WHERE id=? AND state='submitted'
      AND EXISTS (SELECT 1 FROM bake_offs WHERE id=? AND published=0) RETURNING id`, [Date.now(),entry.id,campaign.id]);
    if (!claimed.rows.length) return res.status(409).json({error:'Entry already evaluated or rankings published'});
    res.status(202).json({state:'running'});
    void (async () => {
      try {
        const cases = parseBenchmark((await storage.get(campaign.dataset)).content);
        const {prompt} = await storage.get(entry.id);
        const {models:[score]} = await evaluateBenchmark({
          cases, models:[entry.model], env, infer, beforeCase:checkConsent, benchmarkPrompt:prompt,
        });
        await checkConsent();
        const result = {correct:score.correct,total:score.total,averageLatencyMs:score.averageLatencyMs,
          reportedCostUsd:score.reportedCostUsd, verifiedReceipts:score.receipts.length};
        await db.query("UPDATE bake_off_entries SET state='complete',result=? WHERE id=? AND state='running'", [JSON.stringify(result),entry.id]);
      } catch {
        await db.query("UPDATE bake_off_entries SET state='failed' WHERE id=? AND state='running'", [entry.id]);
      }
    })().catch(() => {});
  });
  app.post('/api/bake-offs/:id/publication', authenticated, async (req,res) => {
    const id = uuid.parse(req.params.id);
    const { published } = z.object({published:z.boolean()}).strict().parse(req.body);
    const campaign = await getCampaign(id);
    if (!campaign || campaign.sponsor !== req.wallet) return res.sendStatus(404);
    await entries(id);
    const changed = await db.query(`UPDATE bake_offs SET published=? WHERE id=? AND sponsor=?
      AND (?=0 OR ((SELECT COUNT(*) FROM bake_off_entries WHERE campaign=bake_offs.id AND state='complete')>=2
        AND (SELECT COUNT(*) FROM bake_off_entries WHERE campaign=bake_offs.id AND state IN ('complete','failed'))=?))
      RETURNING id`, [Number(published),id,req.wallet,Number(published),JSON.parse(campaign.vendors).length]);
    if (!changed.rows.length) return res.status(409).json({error:'Only the sponsor can publish after all submissions finish and at least two complete'});
    res.json({published});
  });
}
