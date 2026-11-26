import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {unpaused} from './consent-ledger.mjs';
import {hash,validWallet} from './security.mjs';

const base = '/api/data-delivery';
const uuid = z.string().uuid();
const checksSchema = z.object({
  minimumRows:z.number().int().min(1).max(10000),
  requiredField:z.string().trim().min(1).max(100).optional()
}).strict();
const approvedDestinations = z.record(z.string().refine(validWallet),z.object({
  url:z.url().max(2048),
  secret:z.string().min(32).max(256)
}).strict());

export function deliveryChecks(content,checks) {
  let rows;
  try { rows = JSON.parse(content); } catch { return null; }
  if (!Array.isArray(rows) || rows.length < checks.minimumRows ||
      !rows.every(row => row && typeof row === 'object' && !Array.isArray(row))) return null;
  if (checks.requiredField && !rows.every(row => Object.hasOwn(row,checks.requiredField) &&
      row[checks.requiredField] !== null &&
      (typeof row[checks.requiredField] !== 'string' || Boolean(row[checks.requiredField].trim())))) return null;
  return {minimumRows:{threshold:checks.minimumRows,passed:true},
    ...(checks.requiredField ? {requiredField:{name:checks.requiredField,passed:true}} : {})};
}

export async function installDataDelivery(app,{db,storage,authenticated,protectedRuntime,env,send=fetch}) {
  const enabled = Boolean(protectedRuntime && env.CONFIDENTIAL_READY === 'true' && env.DATA_DELIVERY_DESTINATIONS);
  app.get(base+'/status',(_req,res) => res.json({enabled}));
  if (!enabled) return;
  const destinations = new Map(Object.entries(approvedDestinations.parse(JSON.parse(env.DATA_DELIVERY_DESTINATIONS))));
  for (const {url} of destinations.values()) {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash ||
        endpoint.port || !endpoint.hostname.includes('.')) throw Error('Invalid approved delivery endpoint');
  }
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS delivery_subscriptions (id TEXT PRIMARY KEY,buyer TEXT NOT NULL,parent TEXT NOT NULL,checks TEXT NOT NULL,UNIQUE(buyer,parent))',
    'CREATE TABLE IF NOT EXISTS delivery_releases (version TEXT PRIMARY KEY,created BIGINT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS delivery_outbox (id TEXT PRIMARY KEY,subscription TEXT NOT NULL,version TEXT NOT NULL,body TEXT NOT NULL,attempts INTEGER NOT NULL,retry_at BIGINT NOT NULL,delivered INTEGER NOT NULL)'
  ]) await db.query(sql);

  const inboxWallet = env.PLATFORM_WALLET;
  const inbox = destinations.get(inboxWallet);
  if (inbox?.url === (env.APP_ORIGIN || '')+'/webhooks/dataloom') {
    await db.query('CREATE TABLE IF NOT EXISTS delivery_inbox (id TEXT PRIMARY KEY,body TEXT NOT NULL,received BIGINT NOT NULL)');
    app.post('/webhooks/dataloom',async(req,res) => {
      res.set('Cache-Control','no-store');
      const timestamp = req.get('X-Data-Loom-Timestamp') || '';
      const signature = req.get('X-Data-Loom-Signature') || '';
      if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp))>300 ||
          !/^sha256=[a-f0-9]{64}$/.test(signature) || !req.deliveryRawBody) return res.sendStatus(401);
      const expected = createHmac('sha256',inbox.secret).update(timestamp+'.').update(req.deliveryRawBody).digest();
      if (!timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'))) return res.sendStatus(401);
      const {eventId,type} = req.body || {};
      if (type !== 'dataloom.dataset.version.ready.v1' || !uuid.safeParse(eventId).success ||
          eventId !== req.get('Idempotency-Key')) return res.sendStatus(400);
      await db.query('INSERT INTO delivery_inbox VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
        [eventId,req.deliveryRawBody.toString('utf8'),Date.now()]);
      res.sendStatus(204);
    });
    app.get(base+'/inbox',authenticated,async(req,res) => {
      if (req.wallet !== inboxWallet) return res.sendStatus(403);
      const {rows} = await db.query('SELECT body,received FROM delivery_inbox ORDER BY received DESC LIMIT 100');
      res.json({events:rows.map(row => ({...JSON.parse(row.body),received:Number(row.received)}))});
    });
  }

  app.get(base+'/subscriptions',authenticated,async(req,res) => {
    const {rows} = await db.query('SELECT id,parent,checks FROM delivery_subscriptions WHERE buyer=? ORDER BY parent',[req.wallet]);
    res.json({destinationConfigured:destinations.has(req.wallet),
      subscriptions:rows.map(row => ({...row,checks:JSON.parse(row.checks)}))});
  });

  app.post(base+'/subscriptions',authenticated,async(req,res) => {
    const {parent,checks} = z.object({parent:uuid,checks:checksSchema}).strict().parse(req.body);
    if (!destinations.has(req.wallet)) return res.status(409).json({error:'No approved webhook endpoint is configured for this wallet.'});
    const result = await db.one(`INSERT INTO delivery_subscriptions(id,buyer,parent,checks)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM licenses WHERE buyer=? AND dataset=?)
      ON CONFLICT(buyer,parent) DO UPDATE SET id=excluded.id,checks=excluded.checks RETURNING id`,
      [randomUUID(),req.wallet,parent,JSON.stringify(checks),req.wallet,parent]);
    if (!result) return res.status(403).json({error:'A license for the parent version is required.'});
    res.status(201).json(result);
  });

  app.delete(base+'/subscriptions/:id',authenticated,async(req,res) => {
    await db.query('DELETE FROM delivery_subscriptions WHERE id=? AND buyer=?',[uuid.parse(req.params.id),req.wallet]);
    res.sendStatus(204);
  });

  app.post(base+'/releases',authenticated,async(req,res) => {
    const {version} = z.object({version:uuid,consent:z.literal(true)}).strict().parse(req.body);
    const source = await db.one(`SELECT d.id,d.commitment,d.license,d.created,d.analysis FROM datasets d
      WHERE d.id=? AND d.owner=? AND ${unpaused}`,[version,req.wallet]);
    if (!source) return res.status(404).json({error:'Active dataset version unavailable.'});
    const lineage = JSON.parse(source.analysis).lineage;
    if (!lineage) return res.status(422).json({error:'Save a derived version with a licensed parent first.'});
    const parent = await db.one(`SELECT d.id FROM datasets d WHERE d.id=? AND d.owner=? AND d.commitment=?
      AND d.license=? AND ${unpaused}`,[lineage.parentId,req.wallet,lineage.parentCommitment,source.license]);
    if (!parent) return res.status(409).json({error:'Active parent version unavailable.'});
    const object = await storage.get(version);
    if (!object.salt || hash(object.salt+'\n'+object.content) !== source.commitment) {
      return res.status(409).json({error:'Dataset commitment verification failed.'});
    }
    await db.transaction(async tx => {
      const release = await tx.one('INSERT INTO delivery_releases VALUES(?,?) ON CONFLICT(version) DO NOTHING RETURNING version',
        [version,Date.now()]);
      if (!release) return;
      const {rows} = await tx.query(`SELECT s.id,s.buyer,s.checks FROM delivery_subscriptions s WHERE s.parent=?
        AND EXISTS(SELECT 1 FROM licenses l WHERE l.dataset=s.parent AND l.buyer=s.buyer)`,[parent.id]);
      for (const subscription of rows) {
        if (!destinations.has(subscription.buyer)) continue;
        const checks = deliveryChecks(object.content,JSON.parse(subscription.checks));
        if (!checks) continue;
        const eventId = randomUUID();
        const body = JSON.stringify({type:'dataloom.dataset.version.ready.v1',eventId,
          version:{id:version,commitment:source.commitment,license:source.license,created:Number(source.created)},
          parent:{id:parent.id,commitment:lineage.parentCommitment},checks});
        await tx.query('INSERT INTO delivery_outbox VALUES(?,?,?,?,0,?,0)',[eventId,subscription.id,version,body,Date.now()]);
      }
    });
    res.status(202).json({accepted:true});
  });

  let running = false;
  async function deliver() {
    if (running) return;
    running = true;
    try {
      const eligible = `FROM delivery_outbox o JOIN delivery_subscriptions s ON s.id=o.subscription
        JOIN datasets d ON d.id=o.version
        WHERE o.delivered=0 AND o.attempts<6 AND ${unpaused}
        AND EXISTS (SELECT 1 FROM datasets d WHERE d.id=s.parent AND ${unpaused})
        AND EXISTS (SELECT 1 FROM licenses l WHERE l.dataset=s.parent AND l.buyer=s.buyer)`;
      const {rows} = await db.query(`SELECT o.id ${eligible} AND o.retry_at<=? ORDER BY o.retry_at LIMIT 20`,[Date.now()]);
      for (const {id} of rows) {
        const now = Date.now();
        const event = await db.one(`UPDATE delivery_outbox SET attempts=attempts+1,retry_at=CAST(? AS BIGINT)+
          (CASE attempts WHEN 0 THEN 30000 WHEN 1 THEN 60000 WHEN 2 THEN 120000 ELSE 300000 END)
          WHERE id=(SELECT o.id ${eligible} AND o.id=? AND o.retry_at<=?) RETURNING subscription,body`,[now,id,now]);
        if (!event) continue;
        const subscription = await db.one('SELECT buyer FROM delivery_subscriptions WHERE id=?',[event.subscription]);
        const destination = destinations.get(subscription?.buyer);
        if (!destination) continue;
        const timestamp = String(Math.floor(now/1000));
        const signature = createHmac('sha256',destination.secret).update(timestamp+'.'+event.body).digest('hex');
        try {
          const response = await send(destination.url,{
            method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),body:event.body,
            headers:{'Content-Type':'application/json','X-Data-Loom-Timestamp':timestamp,
              'X-Data-Loom-Signature':'sha256='+signature,'Idempotency-Key':id}
          });
          if (response.ok) await db.query('UPDATE delivery_outbox SET delivered=1 WHERE id=?',[id]);
          await response.body?.cancel();
        } catch {
          // The durable retry schedule survives network errors and restarts.
        }
      }
    } finally {
      running = false;
    }
  }

  const tick = () => void deliver().catch(() => console.error('Data delivery scan failed'));
  const timer = setInterval(tick,15000);
  timer.unref();
  app.once('loom-close',() => clearInterval(timer));
  tick();
  return deliver;
}
