import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash} from './security.mjs';
const uuid=z.string().uuid();
const policySchema=z.object({days:z.number().int().min(0).max(30),maxReasonChars:z.number().int().min(0).max(2000)}).strict();
const packSchema=z.object({title:z.string().trim().min(2).max(100),days:z.number().int().min(1).max(30),claims:z.array(z.object({claim:z.string().trim().min(2).max(500),call:uuid}).strict()).min(1).max(20)}).strict();
export async function installEvidencePacks(app,{db,storage,authenticated,bearer,grantSelect,sourceAvailable}){
 await db.query('CREATE TABLE IF NOT EXISTS evidence_policies(grant_id TEXT PRIMARY KEY,days INTEGER NOT NULL,max_reason_chars INTEGER NOT NULL)');
 await db.query('CREATE TABLE IF NOT EXISTS evidence_packs(id TEXT PRIMARY KEY,buyer TEXT NOT NULL,object_id TEXT NOT NULL,created BIGINT NOT NULL,expires BIGINT NOT NULL)');
 const access=(req,res,next)=>req.get('authorization')?.startsWith('Bearer loom_agent_')?bearer(req,res,next):authenticated(req,res,next);
 const buyer=req=>req.grant?.buyer||req.wallet;
 async function resolve(req,callId,created,expires){
  const call=await db.one('SELECT * FROM agent_calls WHERE id=? AND signature IS NOT NULL',[callId]);
  const g=call&&await db.one(grantSelect+' WHERE g.id=? AND g.buyer=? AND g.revoked=0',[call.grant_id,buyer(req)]);
  if(!g||(req.grant&&g.id!==req.grant.id)||!await sourceAvailable(g))throw Error('Active licensed source and paid call required');
  const p=await db.one('SELECT * FROM evidence_policies WHERE grant_id=?',[g.id]);
  if(!p?.days||created+Number(p.days)*86400000<Date.now()||expires>created+Number(p.days)*86400000)throw Error('Contributor evidence permission is missing, shortened or expired');
  const q=JSON.parse(call.quote),result=await storage.get(call.id);
  const checks=result.evidence?.checks||[];
  if(q.batch||q.dataRequest||result.source?.commitment!==g.commitment||!result.evidence?.receiptId||!['receipt-1','receipt-2','receipt-3','receipt-4','upstream-1','upstream-2'].every(id=>checks.some(c=>c.id===id&&c.status==='pass')))throw Error('Version-bound verified individual inference required');
  return {call:call.id,grant:g.id,contributor:g.owner,source:result.source,decision:result.output.decision,...(p.max_reason_chars?{reason:String(result.output.reason||'').slice(0,Number(p.max_reason_chars))}:{}),paymentSignature:call.signature,inferenceReceipt:result.evidence,disclosure:{days:Number(p.days),maxReasonChars:Number(p.max_reason_chars)}};
 }
 app.get('/api/evidence-packs/status',(req,res)=>res.json({enabled:true,path:'/api/agent/v1/evidence-packs',maxClaims:20,requiresPaidVerifiedCalls:true,publicSharing:false}));
 app.post('/api/my/agent-grants/:id/evidence-policy',authenticated,async(req,res)=>{
  const p=policySchema.parse(req.body),id=uuid.parse(req.params.id);
  if(!await db.one(grantSelect+' WHERE g.id=? AND t.owner=? AND g.revoked=0',[id,req.wallet]))return res.status(404).json({error:'Active contributor grant required'});
  await db.query('INSERT INTO evidence_policies VALUES(?,?,?) ON CONFLICT(grant_id) DO UPDATE SET days=excluded.days,max_reason_chars=excluded.max_reason_chars',[id,p.days,p.maxReasonChars]);
  res.json(p);
 });
 app.post('/api/agent/v1/evidence-packs',access,async(req,res)=>{
  const b=packSchema.parse(req.body),now=Date.now(),expires=now+b.days*86400000;
  try{for(const c of b.claims)await resolve(req,c.call,now,expires);}catch(e){return res.status(403).json({error:e.message});}
  const id=randomUUID(),object=randomUUID();
  await storage.put(object,{title:b.title,claims:b.claims});
  try{await db.query('INSERT INTO evidence_packs VALUES(?,?,?,?,?)',[id,buyer(req),object,now,expires]);}catch(e){await storage.remove(object);throw e;}
  res.status(201).json({id,expires,path:'/api/agent/v1/evidence-packs/'+id});
 });
 app.get('/api/agent/v1/evidence-packs/:id',access,async(req,res)=>{
  const row=await db.one('SELECT * FROM evidence_packs WHERE id=? AND buyer=? AND expires>?',[uuid.parse(req.params.id),buyer(req),Date.now()]);
  if(!row)return res.status(404).json({error:'Evidence pack unavailable'});
  const stored=await storage.get(row.object_id),claims=[];
  try{for(const c of stored.claims)claims.push({claim:c.claim,relationship:'Buyer-supplied claim; inference does not independently validate this relationship',evidence:await resolve(req,c.call,Number(row.created),Number(row.expires))});}catch(e){return res.status(403).json({error:e.message});}
  const manifest={schema:'data-loom-evidence-pack-v1',id:row.id,title:stored.title,created:Number(row.created),expires:Number(row.expires),claims,terms:'Private inspection only. No publication, resale or training rights. Permissions are checked on each download; downloaded copies cannot be recalled. Manifest digest is not a hardware attestation or signature.'};
  res.set('Cache-Control','no-store');res.json({...manifest,manifestSha256:hash(JSON.stringify(manifest))});
 });
}
