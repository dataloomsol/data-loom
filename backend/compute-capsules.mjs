import {createPublicKey,diffieHellman,generateKeyPairSync,hkdfSync,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash,validWallet} from './security.mjs';
import {seal} from './storage.mjs';
import {unpaused} from './consent-ledger.mjs';

const base = '/api/compute-capsules';
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const policy = z.object({appId:z.string().regex(/^[a-f0-9]{40}$/),composeHash:digest,osImageHash:digest}).strict();
const protocol = 'dataloom-compute-capsule-v1';
const ttl = 5 * 60 * 1000;

export function capsuleBinding(challenge, publicKey) {
  return JSON.stringify([protocol,challenge.id,challenge.nonce,challenge.grant,
    challenge.buyer,challenge.commitment,challenge.appId,challenge.composeHash,challenge.osImageHash,publicKey]);
}

export function verifiedCapsuleQuote(report, challenge, bindingDigest) {
  const d = report?.details;
  return report?.is_valid === true && d?.quote_verified === true && d.event_log_verified === true &&
    d.os_image_hash_verified === true && d.acpi_tables_verified === true && d.os_image_is_dev === false &&
    d.tcb_status === 'UpToDate' && Array.isArray(d.advisory_ids) && d.advisory_ids.length === 0 &&
    d.report_data === bindingDigest + '0'.repeat(64) && d.app_info?.app_id === challenge.appId &&
    d.app_info.compose_hash === challenge.composeHash && d.app_info.os_image_hash === challenge.osImageHash;
}

function verifierUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/verify' || url.username || url.password || url.search || url.hash) {
    throw Error('Capsule verifier must be a protected loopback /verify endpoint.');
  }
  return url;
}

function encrypt(content, keyHex, binding) {
  const receiver = createPublicKey({key:Buffer.from('302a300506032b656e032100'+keyHex,'hex'),type:'spki',format:'der'});
  const {privateKey,publicKey} = generateKeyPairSync('x25519');
  const shared = diffieHellman({privateKey,publicKey:receiver});
  const key = new Uint8Array(hkdfSync('sha256',shared,Buffer.from(hash(binding),'hex'),protocol,32));
  try {
    return {protocol,senderKey:publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex'),
      binding,ciphertext:seal(Buffer.from(content),key,binding).toString('base64')};
  } finally { key.fill(0);shared.fill(0); }
}

export async function installComputeCapsules(app,{db,storage,authenticated,env,protectedRuntime,hostAppId,fetchImpl=fetch}) {
  const verifier = protectedRuntime ? verifierUrl(env.CAPSULE_VERIFIER_URL) : null;
  const enabled = Boolean(verifier && env.CONFIDENTIAL_RUNTIME === 'phala' && env.CONFIDENTIAL_READY === 'true');
  app.get(base+'/status',async(_req,res)=>{
    let verifierReady = false;
    if (enabled) {
      try {
        const response = await fetchImpl(new URL('/health',verifier),{signal:AbortSignal.timeout(2000),redirect:'error'});
        verifierReady = response.ok;
        await response.body?.cancel();
      } catch {}
    }
    res.json({enabled:enabled&&verifierReady,verifierReady,protocol,challengeLifetimeSeconds:ttl/1000});
  });
  if (!enabled) return;

  await db.query(`CREATE TABLE IF NOT EXISTS capsule_grants(
    id TEXT PRIMARY KEY,dataset TEXT NOT NULL,owner TEXT NOT NULL,buyer TEXT NOT NULL,
    commitment TEXT NOT NULL,policy TEXT NOT NULL,active INTEGER NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS capsule_challenges(
    id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,buyer TEXT NOT NULL, nonce TEXT NOT NULL,
    expires BIGINT NOT NULL,used INTEGER NOT NULL)`);
  const active = `SELECT g.* FROM capsule_grants g JOIN datasets d ON d.id=g.dataset
    WHERE g.id=? AND g.buyer=? AND g.active=1 AND d.owner=g.owner AND d.state<>'published'
    AND d.commitment=g.commitment AND ${unpaused}`;

  app.post(base+'/grants',authenticated,async(req,res)=>{
    const {dataset,buyer,workload} = z.object({dataset:uuid,buyer:z.string().refine(validWallet),
      workload:policy,consent:z.literal(true)}).strict().parse(req.body);
    if (workload.appId === hostAppId) return res.status(400).json({error:"Approve a separate recipient workload."});
    const source = await db.one(`SELECT d.commitment FROM datasets d WHERE d.id=? AND d.owner=?
      AND d.state<>'published' AND ${unpaused}`,[dataset,req.wallet]);
    if (!source) return res.status(404).json({error:'Active private dataset unavailable.'});
    const id = randomUUID();
    await db.query('INSERT INTO capsule_grants VALUES(?,?,?,?,?,?,1)',
      [id,dataset,req.wallet,buyer,source.commitment,JSON.stringify(workload)]);
    res.status(201).json({id,buyer,sourceCommitment:source.commitment,workload});
  });

  app.post(base+'/grants/:id/revoke',authenticated,async(req,res)=>{
    const row = await db.one('UPDATE capsule_grants SET active=0 WHERE id=? AND owner=? RETURNING id',
      [uuid.parse(req.params.id),req.wallet]);
    if (!row) return res.status(404).json({error:'Grant unavailable.'});
    res.json({active:false});
  });

  app.post(base+'/grants/:id/challenge',authenticated,async(req,res)=>{
    const grant = await db.one(active,[uuid.parse(req.params.id),req.wallet]);
    if (!grant) return res.status(404).json({error:'Grant unavailable.'});
    const challenge = {id:randomUUID(),nonce:randomBytes(32).toString('hex'),grant:grant.id,
      buyer:grant.buyer,commitment:grant.commitment,...JSON.parse(grant.policy),expires:Date.now()+ttl};
    await db.query('DELETE FROM capsule_challenges WHERE expires<=?',[Date.now()]);
    await db.query('INSERT INTO capsule_challenges VALUES(?,?,?,?,?,0)',
      [challenge.id,grant.id,grant.buyer,challenge.nonce,challenge.expires]);
    res.status(201).json(challenge);
  });

  app.post(base+'/release',authenticated,async(req,res)=>{
    const body = z.object({challenge:uuid,publicKey:digest,quote:z.record(z.string(),z.json())}).strict().parse(req.body);
    const now = Date.now();
    const row = await db.one('SELECT * FROM capsule_challenges WHERE id=? AND buyer=? AND expires>? AND used=0',
      [body.challenge,req.wallet,now]);
    const grant = row && await db.one(active,[row.grant_id,req.wallet]);
    if (!grant) return res.status(404).json({error:'Challenge unavailable.'});
    const challenge = {id:row.id,nonce:row.nonce,grant:grant.id,buyer:grant.buyer,commitment:grant.commitment,
      ...JSON.parse(grant.policy)};
    const binding = capsuleBinding(challenge,body.publicKey);
    // Consume on attempt. This bounds verifier work and prevents concurrent reuse of a quote.
    const consumed = await db.one(`UPDATE capsule_challenges SET used=1 WHERE id=? AND buyer=?
      AND expires>? AND used=0 RETURNING id`,[row.id,req.wallet,now]);
    if (!consumed) return res.status(409).json({error:'Challenge was already used.'});

    let verification;
    try {
      const result = await fetchImpl(verifier,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body.quote),signal:AbortSignal.timeout(120000),redirect:'error'});
      if (!result.ok) throw Error('Verifier failed');
      verification = await result.json();
    } catch {
      return res.status(503).json({error:'Independent quote verifier unavailable. Request a new challenge to retry.'});
    }
    if (!verifiedCapsuleQuote(verification,challenge,hash(binding))) {
      return res.status(403).json({error:'Quote did not establish the approved workload and recipient key.'});
    }
    const source = await storage.get(grant.dataset);
    if (!source.salt || hash(source.salt+'\n'+source.content) !== grant.commitment) {
      return res.status(409).json({error:'Dataset commitment verification failed.'});
    }
    let capsule;
    try { capsule = encrypt(JSON.stringify({content:source.content,salt:source.salt}),body.publicKey,binding); }
    catch { return res.status(422).json({error:'Invalid workload public key.'}); }
    if (!await db.one(active,[grant.id,req.wallet]) || Number(row.expires)<=Date.now()) {
      return res.status(409).json({error:'Permission changed or the challenge expired.'});
    }
    res.json(capsule);
  });
}
