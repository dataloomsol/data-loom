import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash,validWallet} from './security.mjs';
import {unpaused} from './consent-ledger.mjs';

const base = '/api/exclusivity';
const uuid = z.string().uuid();
const day = 86400000;
const offerInput = z.object({
  dataset:uuid,
  buyer:z.string().refine(validWallet),
  use:z.enum(['research','commercial-analysis','model-evaluation','model-training']),
  market:z.string().trim().min(2).max(80).regex(/^[\p{L}\p{N} ,&()./-]+$/u),
  startsAt:z.number().int(),
  endsAt:z.number().int(),
  consent:z.literal(true)
}).strict();

export function exclusiveTerms(baseTerms,s) {
  const original = baseTerms.replace('non-exclusive access','access');
  return `${original} Exclusive through Data Loom for ${s.use_case} in ${s.market}, from ${new Date(Number(s.starts_at)).toISOString()} until ${new Date(Number(s.ends_at)).toISOString()} (end excluded). This scope limits permitted use. Off-platform licenses are outside this guarantee.`;
}

export async function installExclusivity(app,{db,authenticated,protectedRuntime,attestationClient,env,payments,licenses}) {
  const enabled = Boolean(protectedRuntime && attestationClient && env.CONFIDENTIAL_READY==='true');
  await db.query(`CREATE TABLE IF NOT EXISTS exclusive_offers (
    id TEXT PRIMARY KEY, dataset TEXT UNIQUE NOT NULL, commitment TEXT NOT NULL,
    seller TEXT NOT NULL, buyer TEXT NOT NULL, use_case TEXT NOT NULL, market TEXT NOT NULL,
    starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL, order_id TEXT UNIQUE, terms TEXT NOT NULL
  )`);

  const find = (id,client=db) => client.one('SELECT * FROM exclusive_offers WHERE id=?',[id]);
  const describe = row => ({
    id:row.id,dataset:row.dataset,commitment:row.commitment,
    use:row.use_case,market:row.market,startsAt:Number(row.starts_at),endsAt:Number(row.ends_at)
  });
  app.get(base+'/status',(_req,res)=>res.json({enabled,checkout:enabled&&payments}));

  app.post(base,authenticated,async(req,res)=>{
    if (!enabled || !payments) return res.status(503).json({error:'Attested exclusive checkout is unavailable.'});
    const {dataset,buyer,use,market,startsAt,endsAt} = offerInput.parse(req.body);
    const now = Date.now();
    if (buyer===req.wallet || startsAt<now+300000 || startsAt>now+30*day ||
        endsAt<=startsAt || endsAt>startsAt+365*day) {
      return res.status(422).json({error:'Use a different buyer, a start 5 minutes to 30 days ahead, and a window of up to 365 days.'});
    }
    const result = await db.transaction(async tx=>{
      const d = await tx.one("UPDATE datasets SET state=state WHERE id=? AND owner=? AND state='draft' RETURNING *",[dataset,req.wallet]);
      if (!d || await tx.one('SELECT id FROM orders WHERE dataset=? LIMIT 1',[dataset]) ||
          await tx.one('SELECT id FROM licenses WHERE dataset=? LIMIT 1',[dataset]) ||
          await tx.one('SELECT dataset FROM consent_state WHERE dataset=? AND paused=1',[dataset])) return null;
      if (d.license==='research-v1' && !['research','model-evaluation'].includes(use)) return null;
      const id = randomUUID();
      const terms = exclusiveTerms(licenses[d.license],{use_case:use,market,starts_at:startsAt,ends_at:endsAt});
      await tx.query('UPDATE datasets SET state=? WHERE id=?',['exclusive',dataset]);
      await tx.query(`INSERT INTO exclusive_offers
        (id,dataset,commitment,seller,buyer,use_case,market,starts_at,ends_at,terms)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,[id,dataset,d.commitment,req.wallet,buyer,use,market,startsAt,endsAt,terms]);
      return id;
    });
    if (!result) return res.status(409).json({error:'Choose an active draft with no prior checkouts or licenses and a use permitted by its base license.'});
    res.status(201).json({id:result});
  });

  app.get(base+'/:id',authenticated,async(req,res)=>{
    res.set('Cache-Control','no-store');
    const o = await find(uuid.parse(req.params.id));
    if (!o || ![o.seller,o.buyer].includes(req.wallet)) return res.sendStatus(404);
    const d = await db.one('SELECT title,price,license FROM datasets WHERE id=?',[o.dataset]);
    const paid = Boolean(o.order_id && await db.one('SELECT id FROM licenses WHERE order_id=?',[o.order_id]));
    res.json({...describe(o),title:d.title,price:String(d.price),license:d.license,terms:o.terms,paid,
      canBuy:enabled&&payments&&req.wallet===o.buyer&&!o.order_id&&Date.now()+120000<=Number(o.starts_at)});
  });

  app.get(base+'/:id/proof',async(req,res)=>{
    res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, noarchive'});
    if (!enabled) return res.status(503).json({error:'Attested exclusivity runtime unavailable.'});
    const o = await find(uuid.parse(req.params.id));
    if (!o?.order_id) return res.sendStatus(404);
    const rows = (await db.query(`SELECT l.order_id,l.buyer,l.terms,d.commitment,d.state
      FROM licenses l JOIN datasets d ON d.id=l.dataset WHERE l.dataset=?`,[o.dataset])).rows;
    if (rows.length!==1 || rows[0].order_id!==o.order_id || rows[0].buyer!==o.buyer ||
        rows[0].terms!==o.terms || rows[0].commitment!==o.commitment || rows[0].state!=='exclusive') {
      return res.status(409).json({error:'The ledger does not support this exclusivity claim.'});
    }
    const report = {format:'dataloom-exclusivity-v1',...describe(o),termsDigest:hash(o.terms),
      claim:'Data Loom issued exactly one dataset download license for this reserved version.',
      coverage:'Data Loom dataset download licenses for this version only',checkedAt:new Date().toISOString()};
    const reportData = hash(JSON.stringify(report));
    const quote = await attestationClient.getQuote(Buffer.from(reportData,'hex'));
    if (!quote?.quote) return res.status(503).json({error:'Exclusivity attestation unavailable.'});
    res.json({report,attestation:{reportData,quote}});
  });

  async function checkout(id,dataset,buyer) {
    if (!enabled || !payments) return null;
    return db.one(`SELECT d.*,e.terms,e.starts_at FROM exclusive_offers e JOIN datasets d
      ON d.id=e.dataset AND d.commitment=e.commitment WHERE e.id=? AND e.dataset=? AND e.buyer=?
      AND e.order_id IS NULL AND e.starts_at>=? AND d.state='exclusive' AND ${unpaused}`,
      [id,dataset,buyer,Date.now()+120000]);
  }
  async function reserveCheckout(tx,{id,dataset,buyer,orderId,expires}) {
    return tx.one(`UPDATE exclusive_offers SET order_id=? WHERE id=? AND dataset=? AND buyer=?
      AND order_id IS NULL AND starts_at>=? AND EXISTS (SELECT 1 FROM datasets d WHERE
        d.id=exclusive_offers.dataset AND d.commitment=exclusive_offers.commitment AND d.state='exclusive' AND ${unpaused})
      RETURNING id`,[orderId,id,dataset,buyer,expires]);
  }
  async function confirm(tx,dataset,buyer,order) {
    return tx.one('SELECT terms FROM exclusive_offers WHERE dataset=? AND buyer=? AND order_id=?',[dataset,buyer,order]);
  }
  async function allowsDownload(dataset,buyer) {
    const o = await db.one('SELECT buyer,starts_at,ends_at FROM exclusive_offers WHERE dataset=?',[dataset]);
    const now = Date.now();
    return Boolean(o && o.buyer===buyer && Number(o.starts_at)<=now && now<Number(o.ends_at));
  }
  return {checkout,reserveCheckout,confirm,allowsDownload};
}
