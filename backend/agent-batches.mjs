import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash} from './security.mjs';
import {unpaused} from './consent-ledger.mjs';

export const MAX_BATCH_CASES=200;
export const BATCH_TERMS='Data Loom Private Batch Inference v1. Each typed case requires its own verified Phala inference receipt. One USDC payment covers the batch, with 70% to the contributor and 30% to Data Loom. No source files or training rights. Results may be inaccurate. Prepared transactions remain valid after revocation.';

export async function installBatchTables(db){
 await db.query('CREATE TABLE IF NOT EXISTS agent_batch_grants(grant_id TEXT PRIMARY KEY)');
 await db.query(`CREATE TABLE IF NOT EXISTS agent_batches(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,case_count INTEGER NOT NULL,price BIGINT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,
  created BIGINT NOT NULL,UNIQUE(grant_id,request_id))`);
 await db.query("UPDATE agent_batches SET state='failed' WHERE state='running'");
}

export function installAgentBatches(app,{db,storage,env,enabled,grantSelect,bearer,authenticated,sourceAvailable,validateInput,inferDecision,complete,build,callInfo,release}){
 const uuid=z.string().uuid();
 const inputSchema=z.object({grant:uuid.optional(),requestId:uuid,
  cases:z.array(z.record(z.string(),z.unknown())).min(2).max(MAX_BATCH_CASES),
  version:z.union([z.literal(0),z.literal(1)]).default(0)}).strict();
 const quotes=new Set();
 let processing=false;
 const eligible=g=>db.one('SELECT grant_id FROM agent_batch_grants WHERE grant_id=?',[g.id]);
 const permitted=g=>db.one('SELECT id FROM agent_grants WHERE id=? AND revoked=0 AND (token_hash=? OR ?=1)',
  [g.id,g.token_hash,Number(Boolean(g.browser))]);
 const quoteFor=id=>db.one('SELECT * FROM agent_calls WHERE id=?',[id]);
 const batchInfo=async batch=>{
  const call=await quoteFor(batch.id);
  if(call&&(!JSON.parse(call.quote).expired||call.signature))return callInfo(call);
  return {id:batch.id,state:batch.state,caseCount:Number(batch.case_count),price:String(batch.price),terms:BATCH_TERMS};
 };
 const authorize=async(req,res,next)=>{
  if(req.get('authorization'))return bearer(req,res,next);
  return authenticated(req,res,async()=>{
   const id=req.params.id?await db.one('SELECT grant_id FROM agent_batches WHERE id=?',[uuid.parse(req.params.id)]):null;
   const grantId=req.params.id?id?.grant_id:uuid.parse(req.body.grant);
   const grant=grantId&&await db.one(grantSelect+' WHERE g.id=? AND g.buyer=?',[grantId,req.wallet]);
   if(!grant)return res.status(404).json({error:'Batch or grant not found'});
   req.grant={...grant,browser:true};next();
  });
 };
 const findBatch=(req)=>db.one('SELECT * FROM agent_batches WHERE id=? AND grant_id=?',[uuid.parse(req.params.id),req.grant.id]);
 const available=async g=>Boolean(await permitted(g)&&await sourceAvailable(g));
 const releaseFailed=async(g,batch)=>{
  await db.query("UPDATE agent_batches SET state='failed' WHERE id=? AND state='running'",[batch.id]);
  await release(g,batch.id,batch.price);
 };
 app.post('/api/agent/v1/batches',authorize,async(req,res)=>{
  if(!enabled)return res.status(503).json({error:'Verified confidential inference and payments must be ready'});
  const g=req.grant,body=inputSchema.parse(req.body);
  const cases=body.cases.map(input=>validateInput(JSON.parse(g.fields),input));
  const inputHash=hash(JSON.stringify(cases));
  const existing=await db.one('SELECT * FROM agent_batches WHERE grant_id=? AND request_id=?',[g.id,body.requestId]);
  if(existing){
   if(existing.input_hash!==inputHash)return res.status(409).json({error:'Request ID was already used for different cases'});
   return res.json(await batchInfo(existing));
  }
  if(!await eligible(g)||!await available(g))return res.status(409).json({error:'Batch access or dataset permission unavailable'});
  if(processing)return res.status(429).json({error:'Another batch is running. Retry shortly.'});
  const price=Number(g.price)*cases.length;
  if(price>1e9||price>Number(g.cap)-Number(g.spent))return res.status(409).json({error:'The batch exceeds the grant balance or 1,000 USDC checkout limit'});
  const batch={id:randomUUID(),grant_id:g.id,request_id:body.requestId,input_hash:inputHash,case_count:cases.length,price,version:body.version,state:'running',created:Date.now()};
  processing=true;
  let queued=false,created=false;
  try{
   const job=await db.query(`INSERT INTO agent_batches(id,grant_id,request_id,input_hash,case_count,price,version,state,created)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(grant_id,request_id) DO NOTHING RETURNING id`,
    [batch.id,batch.grant_id,batch.request_id,batch.input_hash,batch.case_count,batch.price,batch.version,batch.state,batch.created]);
   if(!job.rows.length)return res.status(409).json({error:'This batch request is already preparing'});
   created=true;
   const reservation=await db.query(`UPDATE agent_grants SET pending=?,spent=spent+? WHERE id=? AND revoked=0
    AND (token_hash=? OR ?=1) AND pending IS NULL AND spent+?<=cap RETURNING id`,
    [batch.id,price,g.id,g.token_hash,Number(Boolean(g.browser)),price]);
   if(!reservation.rows.length)return res.status(409).json({error:'Another checkout is pending or the grant changed'});
   const day=Math.floor(Date.now()/86400000),slot=hash('agent-batch:'+g.buyer+':'+g.dataset+':'+day);
   const capacity=await db.query('INSERT INTO query_quota(slot,created) VALUES(?,?) ON CONFLICT(slot) DO NOTHING RETURNING slot',[slot,Date.now()]);
   if(!capacity.rows.length)return res.status(429).json({error:'One batch preparation per buyer and dataset per day'});
   queued=true;
   void (async()=>{
    let stored=false;
    try{
     if(!await available(g))throw Error('Batch permission changed');
     const source=(await storage.get(g.dataset)).content;
     const results=[];
     for(let start=0;start<cases.length;start+=3){
      if(!await available(g))throw Error('Batch permission changed');
      const group=await Promise.allSettled(cases.slice(start,start+3).map(async(input,index)=>({
       row:start+index+1,...await inferDecision({tool:g,input,source,env,complete})
      })));
      if(group.some(result=>result.status==='rejected'))throw Error('Batch inference failed verification');
      results.push(...group.map(result=>result.value));
     }
     if(!await available(g))throw Error('Batch permission changed');
     await storage.put(batch.id,{caseCount:cases.length,results,source:{id:g.dataset,commitment:g.commitment}});
     stored=true;
     await db.query("UPDATE agent_batches SET state='ready' WHERE id=? AND state='running'",[batch.id]);
    }catch{
     if(stored)await storage.remove(batch.id).catch(()=>{});
     await releaseFailed(g,batch);
    }finally{processing=false}
   })().catch(error=>console.error('Batch cleanup failed:',error.name));
   res.status(202).json({id:batch.id,state:'running',caseCount:cases.length,price:String(price),terms:BATCH_TERMS});
  }finally{
   if(!queued){
    processing=false;
    if(created)await releaseFailed(g,batch);
   }
  }
 });
 app.get('/api/agent/v1/batches/:id',authorize,async(req,res)=>{
  const batch=await findBatch(req);
  if(!batch)return res.status(404).json({error:'Batch not found'});
  res.json(await batchInfo(batch));
 });
 app.post('/api/agent/v1/batches/:id/checkout',authorize,async(req,res)=>{
  const g=req.grant,batch=await findBatch(req);
  if(!batch)return res.status(404).json({error:'Batch not found'});
  const previous=await quoteFor(batch.id);
  if(previous&&(!JSON.parse(previous.quote).expired||previous.signature))return res.json(await callInfo(previous));
  if(!enabled||batch.state!=='ready'||!await available(g))return res.status(409).json({error:'Batch checkout unavailable'});
  if(quotes.has(batch.id))return res.status(409).json({error:'Checkout already preparing'});
  quotes.add(batch.id);
  try{
   const held=await db.one('SELECT id FROM agent_grants WHERE id=? AND pending=?',[g.id,batch.id]);
   if(!held)return res.status(409).json({error:'Another checkout is pending or the grant cap is exhausted'});
   const output=await storage.get(batch.id);
   const commitment=hash(g.commitment+'\n'+batch.input_hash+'\n'+hash(JSON.stringify(output.results)));
   const q=await build({id:batch.id,buyer:g.buyer,seller:g.owner,platform:env.PLATFORM_WALLET,price:batch.price,
    commitment,license:BATCH_TERMS,version:Number(batch.version),rpcUrl:env.SOLANA_RPC_URL});
   q.batch=true;q.caseCount=Number(batch.case_count);q.price=String(batch.price);
   const valid=`EXISTS (SELECT 1 FROM agent_grants WHERE id=? AND pending=? AND revoked=0 AND (token_hash=? OR ?=1))
    AND EXISTS (SELECT 1 FROM agent_batches WHERE id=? AND state='ready')
    AND EXISTS (SELECT 1 FROM datasets d WHERE d.id=? AND d.commitment=? AND d.state<>'published' AND ${unpaused}
      AND NOT EXISTS (SELECT 1 FROM trial_policies t WHERE t.dataset=d.id AND t.enabled=1))`;
   const values=[g.id,batch.id,g.token_hash,Number(Boolean(g.browser)),batch.id,g.dataset,g.commitment];
   const quote=JSON.stringify(q);
   const written=previous?
    await db.query('UPDATE agent_calls SET quote=? WHERE id=? AND quote=? AND signature IS NULL AND '+valid+' RETURNING id',[quote,batch.id,previous.quote,...values]):
    await db.query('INSERT INTO agent_calls(id,grant_id,request_id,quote,created) SELECT ?,?,?,?,? WHERE '+valid+' RETURNING id',
     [batch.id,g.id,'batch:'+batch.request_id,quote,Date.now(),...values]);
   if(!written.rows.length)return res.status(409).json({error:'Batch permission or checkout changed'});
   res.json(await callInfo({id:batch.id,quote}));
  }finally{quotes.delete(batch.id)}
 });
 app.post('/api/agent/v1/batches/:id/cancel',authorize,async(req,res)=>{
  const g=req.grant,batch=await findBatch(req);
  if(!batch)return res.status(404).json({error:'Batch not found'});
  if(quotes.has(batch.id))return res.status(409).json({error:'Checkout is still preparing'});
  const previous=await quoteFor(batch.id);
  if(previous&&(previous.signature||!JSON.parse(previous.quote).expired))return res.status(409).json({error:'Recover an existing checkout before releasing its allowance'});
  const cancelled=await db.query(`UPDATE agent_batches SET state='cancelled' WHERE id=? AND state='ready'
   AND NOT EXISTS (SELECT 1 FROM agent_calls WHERE id=agent_batches.id AND (signature IS NOT NULL OR quote<>?)) RETURNING id`,
   [batch.id,previous?.quote||'']);
  if(!cancelled.rows.length)return res.status(409).json({error:'Recover an existing checkout before releasing its allowance'});
  await release(g,batch.id,batch.price);
  await storage.remove(batch.id).catch(()=>{});
  res.json({id:batch.id,state:'cancelled'});
 });
}
