import {randomInt, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {unpaused} from './consent-ledger.mjs';
import {hash, validWallet} from './security.mjs';
import {buildPayment, verifyPayment} from './settlement.mjs';
import {reservePrivateSqlBudget} from './private-sql-budget.mjs';

const uuid = z.string().uuid();
const column = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
const filter = z.object({column, equals: z.string().max(120)}).strict();
const specification = z.discriminatedUnion('statistic', [
  z.object({statistic: z.literal('count'), filter: filter.optional()}).strict(),
  z.object({statistic: z.literal('median'), filter: filter.optional(), column,
    lower: z.number().finite().min(-1e9).max(1e9), upper: z.number().finite().min(-1e9).max(1e9)}).strict(),
  z.object({statistic: z.literal('trend'), column, earlier: z.string().max(120), later: z.string().max(120)}).strict()
]).refine(s => s.statistic === 'median' ? s.upper - s.lower >= 0.001 :
  s.statistic !== 'trend' || s.earlier !== s.later, 'Invalid bounds or overlapping trend cohorts');
const createOffer = z.object({dataset: uuid, title: z.string().trim().min(3).max(100),
  price: z.number().int().min(10000).max(1e9), specification, consent: z.literal(true)}).strict();
const checkout = z.object({requestId: uuid, accept: z.literal(true),
  version: z.union([z.literal(0), z.literal(1)]).default(0)}).strict();
const confirmation = z.object({signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/)}).strict();
const jsonRows = z.array(z.record(z.string(), z.json())).max(10000);
const minimum = 30;
const noisyMinimum = 60;
const epsilon = 0.25;
const terms = 'Private Aggregate v1. One fixed, noisy result for internal use. A result may be suppressed and still costs the displayed price. No dataset download, publication, redistribution or training rights. Solana mainnet USDC: 70% contributor, 30% platform. Network fees and applicable token account rent are separate.';

function perturb(count) {
  const u = (randomInt(2 ** 47) + 0.5) / (2 ** 47) - 0.5;
  return Math.round(count - Math.sign(u) * Math.log1p(-2 * Math.abs(u)) / epsilon);
}

export function computeAggregate(rows, spec, noise = perturb) {
  const matches = (row, key, value) => Object.hasOwn(row, key) && row[key] === value;
  const enough = (exact, noisy) => exact >= minimum && noisy >= noisyMinimum;
  const suppressed = {status: 'suppressed'};
  if (spec.statistic === 'trend') {
    const earlier = rows.filter(row => matches(row, spec.column, spec.earlier)).length;
    const later = rows.filter(row => matches(row, spec.column, spec.later)).length;
    const a = noise(earlier), b = noise(later);
    return enough(earlier, a) && enough(later, b)
      ? {status: 'available', earlier: a, later: b, change: b - a} : suppressed;
  }
  const cohort = spec.filter ? rows.filter(row => matches(row, spec.filter.column, spec.filter.equals)) : rows;
  if (spec.statistic === 'count') {
    const count = noise(cohort.length);
    return enough(cohort.length, count) ? {status: 'available', count} : suppressed;
  }
  const values = cohort.filter(row => Object.hasOwn(row, spec.column) && typeof row[spec.column] === 'number');
  if (!enough(values.length, noise(values.length))) return suppressed;
  const width = (spec.upper - spec.lower) / 16;
  const bins = Array(16).fill(0);
  for (const row of values) {
    const clamped = Math.min(spec.upper, Math.max(spec.lower, row[spec.column]));
    bins[Math.min(15, Math.floor((clamped - spec.lower) / width))]++;
  }
  const weights = bins.map(count => Math.max(0, noise(count)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!total) return suppressed;
  let accumulated = 0;
  const index = weights.findIndex(weight => (accumulated += weight) >= total / 2);
  return {status: 'available', median: spec.lower + width * (index + 0.5), binWidth: width};
}

export async function installPrivateAggregate(app, {db, storage, authenticated, env, protectedRuntime,
  build = buildPayment, verify = verifyPayment}) {
  const enabled = protectedRuntime && env.CONFIDENTIAL_READY === 'true';
  const payments = enabled && env.ENABLE_QUERY_PAYMENTS === 'true' &&
    validWallet(env.PLATFORM_WALLET || '') && !!env.SOLANA_RPC_URL;
  const base = '/api/private-aggregates';
  app.get(base + '/status', (_req, res) => res.json({enabled, payments, statistics: ['count','median','trend'],
    minimumGroupSize: minimum, noisyMinimumGroupSize: noisyMinimum, fixedOffers: true}));
  if (!protectedRuntime) return;
  await db.query(`CREATE TABLE IF NOT EXISTS private_aggregate_releases (
    id TEXT PRIMARY KEY, release_key TEXT NOT NULL UNIQUE, result_object TEXT NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS private_aggregate_offers (
    id TEXT PRIMARY KEY, dataset TEXT NOT NULL, commitment TEXT NOT NULL, owner TEXT NOT NULL,
    title TEXT NOT NULL, price BIGINT NOT NULL, spec TEXT NOT NULL, release_id TEXT NOT NULL,
    active INTEGER NOT NULL, created BIGINT NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS private_aggregate_orders (
    id TEXT PRIMARY KEY, offer TEXT NOT NULL, buyer TEXT NOT NULL, request_id TEXT NOT NULL,
    quote TEXT NOT NULL, signature TEXT UNIQUE, created BIGINT NOT NULL, UNIQUE(buyer,request_id))`);

  const activeOffers = `SELECT o.* FROM private_aggregate_offers o JOIN datasets d ON d.id=o.dataset
    WHERE o.active=1 AND d.state<>'published' AND d.owner=o.owner
    AND d.commitment=o.commitment AND ${unpaused}`;
  const describe = o => ({id: o.id, title: o.title, dataset: o.dataset, commitment: o.commitment,
    owner: o.owner, price: String(o.price), specification: JSON.parse(o.spec), active: Boolean(o.active)});
  const getOrder = (id, buyer) => db.one('SELECT * FROM private_aggregate_orders WHERE id=? AND buyer=?', [id,buyer]);
  const quoteView = row => {
    const {message, ...quote} = JSON.parse(row.quote);
    return {id: row.id, offer: row.offer, terms, signature: row.signature, ...quote};
  };
  const requireReady = (_req, res, next) => enabled ? next() : res.status(503).json({error:'Verified confidential runtime unavailable.'});
  const requirePayments = (_req, res, next) => payments ? next() : res.status(503).json({error:'Aggregate checkout unavailable.'});

  app.get(base + '/offers', authenticated, requireReady, async (_req, res) => {
    const {rows} = await db.query(activeOffers + ' ORDER BY o.created DESC LIMIT 100');
    res.json({offers: rows.map(describe), terms});
  });
  app.get(base + '/my-offers', authenticated, requireReady, async (req, res) => {
    const {rows} = await db.query('SELECT * FROM private_aggregate_offers WHERE owner=? ORDER BY created DESC LIMIT 100', [req.wallet]);
    res.json({offers: rows.map(describe)});
  });
  app.post(base + '/offers', authenticated, requireReady, async (req, res) => {
    const body = createOffer.parse(req.body);
    const d = await db.one(`SELECT d.id,d.commitment FROM datasets d
      WHERE d.id=? AND d.owner=? AND d.state<>'published' AND ${unpaused}`, [body.dataset, req.wallet]);
    if (!d) return res.status(404).json({error:'Active private dataset unavailable.'});
    const object = await storage.get(d.id);
    if (!object.salt || hash(object.salt + '\n' + object.content) !== d.commitment) {
      return res.status(409).json({error:'Dataset commitment verification failed.'});
    }
    let rows;
    try { rows = jsonRows.parse(JSON.parse(object.content)); }
    catch { return res.status(422).json({error:'The dataset must contain up to 10,000 JSON row objects.'}); }
    const spec = JSON.stringify(body.specification);
    const key = hash(JSON.stringify([d.commitment, body.specification]));
    const releaseId = randomUUID(), objectId = randomUUID(), id = randomUUID();
    let writeAttempted = false;
    try {
      const created = await db.transaction(async tx => {
        const current = await tx.one(`SELECT d.id FROM datasets d WHERE d.id=? AND d.owner=? AND
          d.commitment=? AND d.state<>'published' AND ${unpaused}`, [d.id,req.wallet,d.commitment]);
        if (!current) return 'unavailable';
        const release = await tx.one(`INSERT INTO private_aggregate_releases VALUES (?,?,?)
          ON CONFLICT(release_key) DO NOTHING RETURNING id`, [releaseId,key,objectId]);
        let linked = releaseId;
        if (release) {
          if (!await reservePrivateSqlBudget(tx, body.specification.statistic === 'median' ? 500 : 250)) throw budgetExhausted;
          writeAttempted = true;
          await storage.put(objectId, computeAggregate(rows, body.specification));
        } else {
          linked = (await tx.one('SELECT id FROM private_aggregate_releases WHERE release_key=?', [key])).id;
        }
        await tx.query('INSERT INTO private_aggregate_offers VALUES(?,?,?,?,?,?,?,?,?,?)',
          [id,d.id,d.commitment,req.wallet,body.title,body.price,spec,linked,1,Date.now()]);
        return 'created';
      });
      if (created !== 'created') return res.status(409).json({error:'Dataset access changed.'});
    } catch (error) {
      if (writeAttempted && !await db.one('SELECT id FROM private_aggregate_releases WHERE id=?', [releaseId])) {
        await storage.remove(objectId).catch(() => {});
      }
      if (error === budgetExhausted) return res.status(429).json({error:'The shared privacy budget is exhausted.'});
      throw error;
    }
    res.status(201).json({id});
  });
  app.post(base + '/offers/:id/retire', authenticated, requireReady, async (req, res) => {
    const retired = await db.one('UPDATE private_aggregate_offers SET active=0 WHERE id=? AND owner=? RETURNING id',
      [uuid.parse(req.params.id),req.wallet]);
    if (!retired) return res.status(404).json({error:'Offer not found.'});
    res.json({active:false});
  });
  app.post(base + '/offers/:id/checkout', authenticated, requirePayments, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const body = checkout.parse(req.body);
    const existing = () => db.one('SELECT * FROM private_aggregate_orders WHERE buyer=? AND request_id=?', [req.wallet,body.requestId]);
    const reply = row => row.offer === id ? res.json(quoteView(row)) :
      res.status(409).json({error:'Request ID is already associated with another offer.'});
    const prior = await existing();
    if (prior) return reply(prior);
    const offer = await db.one(activeOffers + ' AND o.id=?', [id]);
    if (!offer || offer.owner === req.wallet) return res.status(404).json({error:'Purchasable offer unavailable.'});
    const orderId = randomUUID();
    const quote = await build({buyer:req.wallet,seller:offer.owner,platform:env.PLATFORM_WALLET,price:offer.price,
      id:orderId,commitment:hash(JSON.stringify([id,offer.commitment,offer.spec])),license:terms,
      version:body.version,rpcUrl:env.SOLANA_RPC_URL});
    const order = await db.one(`INSERT INTO private_aggregate_orders(id,offer,buyer,request_id,quote,created)
      SELECT ?,?,?,?,?,? WHERE EXISTS (${activeOffers} AND o.id=?)
      ON CONFLICT(buyer,request_id) DO NOTHING RETURNING *`,
      [orderId,id,req.wallet,body.requestId,JSON.stringify(quote),Date.now(),id]);
    if (order) return res.status(201).json(quoteView(order));
    const concurrent = await existing();
    if (concurrent) return reply(concurrent);
    res.status(409).json({error:'Offer was retired or dataset access changed.'});
  });
  app.post(base + '/orders/:id/confirm', authenticated, requireReady, async (req, res) => {
    const {signature} = confirmation.parse(req.body);
    const order = await getOrder(uuid.parse(req.params.id),req.wallet);
    if (!order) return res.status(404).json({error:'Order unavailable.'});
    if (order.signature && order.signature !== signature) return res.status(409).json({error:'Order already settled.'});
    if (!order.signature) {
      await verify(signature,JSON.parse(order.quote).message,env.SOLANA_RPC_URL);
      const changed = await db.one(`UPDATE private_aggregate_orders SET signature=?
        WHERE id=? AND (signature IS NULL OR signature=?) RETURNING id`, [signature,order.id,signature]);
      if (!changed) return res.status(409).json({error:'Order already settled.'});
    }
    res.json({order: order.id, signature, resultPath: base + '/orders/' + order.id + '/result'});
  });
  app.get(base + '/orders/:id/result', authenticated, requireReady, async (req, res) => {
    const order = await getOrder(uuid.parse(req.params.id),req.wallet);
    if (!order?.signature) return res.status(404).json({error:'Paid aggregate unavailable.'});
    const row = await db.one(`SELECT o.*,r.result_object FROM private_aggregate_offers o
      JOIN private_aggregate_releases r ON r.id=o.release_id WHERE o.id=?`, [order.offer]);
    const result = await storage.get(row.result_object);
    res.json({offer: describe(row), result, signature: order.signature, terms});
  });
}

const budgetExhausted = new Error('The shared privacy budget is exhausted');
