import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash} from './security.mjs';

const uuid=z.string().uuid();
const requestSchema=z.object({
 requestId:uuid,
 question:z.string().trim().min(10).max(2000),
 task:z.string().trim().min(10).max(500),
}).strict();
const responseSchema=z.object({
 response:z.string().trim().min(1).max(6000),
 consent:z.literal(true),
}).strict();
export const DATA_REQUEST_TERMS='Private Data Request v1. Contributor authorizes this response only for the stated task. No training, publication or resale rights. Buyer explicitly accepts and signs the mainnet USDC checkout. 70% contributor, 30% platform. This is a human-supplied response with no inference receipt.';

export async function installDataRequests(app,{db,storage,env,bearer,authenticated,sourceAvailable,grantSelect,build,release}){
 await db.query('CREATE TABLE IF NOT EXISTS agent_data_requests(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,object_id TEXT NOT NULL,response_id TEXT,state TEXT NOT NULL,created BIGINT NOT NULL,expires BIGINT NOT NULL,UNIQUE(grant_id,request_id))');
 const active=async g=>await db.one('SELECT id FROM agent_grants WHERE id=? AND revoked=0',[g.id])&&await sourceAvailable(g);
 const describe=async row=>{
  const question=await storage.get(row.object_id);
  const call=await db.one('SELECT signature,quote FROM agent_calls WHERE id=?',[row.id]);
  return {id:row.id,grant:row.grant_id,state:call?.signature?'paid':call?'checkout':row.state,
   question:question.question,task:question.task,source:question.source,expires:Number(row.expires),
   price:question.price,terms:DATA_REQUEST_TERMS,signature:call?.signature||null};
 };
 app.get('/api/data-requests/status',(req,res)=>res.json({enabled:true,payments:env.ENABLE_QUERY_PAYMENTS==='true',terms:DATA_REQUEST_TERMS,path:'/api/agent/v1/data-requests'}));
 app.post('/api/agent/v1/data-requests',bearer,async(req,res)=>{
  const body=requestSchema.parse(req.body),g=req.grant;
  if(!await active(g))return res.status(409).json({error:'Active contributor grant and source required'});
  const digest=hash(JSON.stringify({question:body.question,task:body.task}));
  const old=await db.one('SELECT * FROM agent_data_requests WHERE grant_id=? AND request_id=?',[g.id,body.requestId]);
  if(old){
   if(old.input_hash!==digest)return res.status(409).json({error:'Request ID already used for different input'});
   return res.json(await describe(old));
  }
  const {rows}=await db.query('SELECT id FROM agent_data_requests WHERE grant_id=? AND created>?',[g.id,Date.now()-86400000]);
  if(rows.length>=10)return res.status(429).json({error:'Daily request limit reached'});
  const id=randomUUID(),object=randomUUID(),now=Date.now();
  await storage.put(object,{question:body.question,task:body.task,price:String(g.price),source:{id:g.dataset,commitment:g.commitment}});
  try{
   const inserted=await db.query('INSERT INTO agent_data_requests VALUES(?,?,?,?,?,NULL,?,?,?) ON CONFLICT(grant_id,request_id) DO NOTHING RETURNING id',[id,g.id,body.requestId,digest,object,'requested',now,now+7*86400000]);
   if(!inserted.rows.length){
    await storage.remove(object);
    const existing=await db.one('SELECT * FROM agent_data_requests WHERE grant_id=? AND request_id=?',[g.id,body.requestId]);
    if(existing.input_hash!==digest)return res.status(409).json({error:'Request ID already used for different input'});
    return res.json(await describe(existing));
   }
  }catch(error){await storage.remove(object).catch(()=>{});throw error;}
  res.status(201).json(await describe(await db.one('SELECT * FROM agent_data_requests WHERE id=?',[id])));
 });
 app.get('/api/my/data-requests',authenticated,async(req,res)=>{
  const {rows}=await db.query('SELECT r.*,t.name,t.owner,g.buyer,g.revoked FROM agent_data_requests r JOIN agent_grants g ON g.id=r.grant_id JOIN agent_tools t ON t.id=g.tool WHERE t.owner=? OR g.buyer=? ORDER BY r.created DESC LIMIT 100',[req.wallet,req.wallet]);
  const requests=[];
  for(const row of rows)requests.push({...await describe(row),owner:row.owner,buyer:row.buyer,name:row.name,revoked:Boolean(row.revoked)});
  res.json({requests});
 });
 app.post('/api/my/data-requests/:id/respond',authenticated,async(req,res)=>{
  const body=responseSchema.parse(req.body),id=uuid.parse(req.params.id);
  const row=await db.one('SELECT * FROM agent_data_requests WHERE id=?',[id]);
  const g=row&&await db.one(grantSelect+' WHERE g.id=? AND t.owner=?',[row.grant_id,req.wallet]);
  if(!g)return res.status(404).json({error:'Contributor request not found'});
  if(row.state!=='requested'||Number(row.expires)<=Date.now()||!await active(g))return res.status(409).json({error:'Request is closed or permission changed'});
  const responseId=randomUUID();
  await storage.put(responseId,{response:body.response,task:(await storage.get(row.object_id)).task,source:{id:g.dataset,commitment:g.commitment},terms:DATA_REQUEST_TERMS});
  try{
   const changed=await db.query("UPDATE agent_data_requests SET response_id=?,state='responded' WHERE id=? AND state='requested' AND expires>? RETURNING id",[responseId,id,Date.now()]);
   if(!changed.rows.length){await storage.remove(responseId);return res.status(409).json({error:'Another response was already submitted'});}
  }catch(error){await storage.remove(responseId).catch(()=>{});throw error;}
  res.json({ok:true});
 });
 app.get('/api/agent/v1/data-requests/:id',bearer,async(req,res)=>{
  const row=await db.one('SELECT * FROM agent_data_requests WHERE id=? AND grant_id=?',[uuid.parse(req.params.id),req.grant.id]);
  if(!row)return res.status(404).json({error:'Request not found'});
  res.json(await describe(row));
 });
 app.post('/api/agent/v1/data-requests/:id/accept',bearer,async(req,res)=>{
  z.object({accept:z.literal(true),version:z.union([z.literal(0),z.literal(1)]).default(0)}).strict().parse(req.body);
  if(env.ENABLE_QUERY_PAYMENTS!=='true')return res.status(503).json({error:'Payments unavailable'});
  const id=uuid.parse(req.params.id),g=req.grant;
  const row=await db.one('SELECT * FROM agent_data_requests WHERE id=? AND grant_id=?',[id,g.id]);
  if(!row)return res.status(404).json({error:'Request not found'});
  if(row.state!=='responded'||Number(row.expires)<=Date.now()||!await active(g))return res.status(409).json({error:'Response unavailable or permission changed'});
  const existing=await db.one('SELECT * FROM agent_calls WHERE id=? AND grant_id=?',[id,g.id]);
  if(existing)return res.json({call:id,paymentPath:'/api/agent/v1/calls/'+id});
  const {rows}=await db.query('UPDATE agent_grants SET pending=?,spent=spent+? WHERE id=? AND token_hash=? AND revoked=0 AND pending IS NULL AND spent+?<=cap RETURNING id',[id,g.price,g.id,g.token_hash,g.price]);
  if(!rows.length)return res.status(409).json({error:'Grant budget exhausted or another checkout pending'});
  try{
   const response=await storage.get(row.response_id);
   const question=await storage.get(row.object_id);
   const commitment=hash(JSON.stringify({request:id,task:question.task,source:response.source,response:hash(response.response)}));
   const quote=await build({id,buyer:g.buyer,seller:g.owner,platform:env.PLATFORM_WALLET,price:g.price,commitment,license:DATA_REQUEST_TERMS,version:req.body.version||0,rpcUrl:env.SOLANA_RPC_URL});
   quote.dataRequest=true;
   await storage.put(id,{output:{response:response.response,task:response.task},source:response.source,terms:DATA_REQUEST_TERMS,provenance:{kind:'contributor-response',contributor:g.owner,commitment}});
   if(!await active(g))throw Error('Contributor permission changed');
   await db.query('INSERT INTO agent_calls(id,grant_id,request_id,quote,created) VALUES(?,?,?,?,?)',[id,g.id,'data-request:'+row.request_id,JSON.stringify(quote),Date.now()]);
   res.status(201).json({call:id,paymentPath:'/api/agent/v1/calls/'+id,transaction:quote.transaction,summary:quote.summary,lastValidBlockHeight:quote.lastValidBlockHeight,simulation:true,terms:DATA_REQUEST_TERMS});
  }finally{
   if(!await db.one('SELECT id FROM agent_calls WHERE id=?',[id])){
    await storage.remove(id).catch(()=>{});
    await release(g,id,g.price);
   }
  }
 });
}
