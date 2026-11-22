import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash,token} from './security.mjs';

const uuid=z.string().uuid();
const roomSchema=z.object({
 name:z.string().trim().min(2).max(80),
 grants:z.array(uuid).min(2).max(10),
 tasks:z.array(z.string().trim().min(10).max(300)).min(1).max(10),
 cap:z.number().int().min(10000).max(1000000000),
 days:z.number().int().min(1).max(30),
}).strict().refine(x=>new Set(x.grants).size===x.grants.length&&new Set(x.tasks).size===x.tasks.length);
const callSchema=z.object({grant:uuid,task:z.string(),requestId:uuid,input:z.record(z.string(),z.unknown()),version:z.union([z.literal(0),z.literal(1)]).default(0)}).strict();

export async function installAgentRooms(app,{db,env,authenticated,grantSelect,sourceAvailable,prepareCall,callInfo,settle}){
 await db.query('CREATE TABLE IF NOT EXISTS agent_rooms(id TEXT PRIMARY KEY,buyer TEXT NOT NULL,name TEXT NOT NULL,tasks TEXT NOT NULL,cap BIGINT NOT NULL,spent BIGINT NOT NULL,expires BIGINT NOT NULL,revoked INTEGER NOT NULL,token_hash TEXT UNIQUE,created BIGINT NOT NULL)');
 await db.query('CREATE TABLE IF NOT EXISTS agent_room_grants(room TEXT NOT NULL,grant_id TEXT NOT NULL,PRIMARY KEY(room,grant_id))');
 await db.query('CREATE TABLE IF NOT EXISTS agent_room_calls(room TEXT NOT NULL,request_id TEXT NOT NULL,grant_id TEXT NOT NULL,input_hash TEXT NOT NULL,price BIGINT NOT NULL,state TEXT NOT NULL,call_id TEXT UNIQUE,created BIGINT NOT NULL,PRIMARY KEY(room,request_id))');
 // Only startup releases reservations interrupted before a durable checkout existed.
 await db.transaction(async tx=>{
 const {rows:interrupted}=await tx.query("SELECT * FROM agent_room_calls rc WHERE rc.state='reserved' AND NOT EXISTS(SELECT 1 FROM agent_calls c WHERE c.grant_id=rc.grant_id AND c.request_id=rc.request_id)");
 for(const row of interrupted){
  const changed=await tx.query("UPDATE agent_room_calls SET state='released' WHERE room=? AND request_id=? AND state='reserved' RETURNING price",[row.room,row.request_id]);
  if(changed.rows.length)await tx.query('UPDATE agent_rooms SET spent=spent-? WHERE id=?',[row.price,row.room]);
 }
 });
 await db.query("UPDATE agent_room_calls SET call_id=(SELECT c.id FROM agent_calls c WHERE c.grant_id=agent_room_calls.grant_id AND c.request_id=agent_room_calls.request_id),state='prepared' WHERE state='reserved' AND EXISTS(SELECT 1 FROM agent_calls c WHERE c.grant_id=agent_room_calls.grant_id AND c.request_id=agent_room_calls.request_id)");
 const view=r=>({id:r.id,name:r.name,buyer:r.buyer,tasks:JSON.parse(r.tasks),cap:String(r.cap),reservedOrSpent:String(r.spent),expires:Number(r.expires),revoked:Boolean(r.revoked)});
 const members=async(room,buyer)=>(await db.query(grantSelect+' JOIN agent_room_grants rg ON rg.grant_id=g.id WHERE rg.room=? AND g.buyer=?',[room,buyer])).rows;
 app.get('/api/agent-rooms/status',(req,res)=>res.json({enabled:true,callsEnabled:env.CONFIDENTIAL_READY==='true'&&env.ENABLE_QUERY_PAYMENTS==='true',maxDatasets:10,maxDays:30,path:'/api/agent/v1/rooms'}));
 app.post('/api/my/agent-rooms',authenticated,async(req,res)=>{
  const body=roomSchema.parse(req.body),grants=[];
  for(const id of body.grants){
   const g=await db.one(grantSelect+' WHERE g.id=? AND g.buyer=? AND g.revoked=0',[id,req.wallet]);
   if(!g||!await sourceAvailable(g))return res.status(409).json({error:'Every dataset needs your active contributor grant'});
   grants.push(g);
  }
  if(new Set(grants.map(g=>g.dataset)).size<2)return res.status(400).json({error:'Choose at least two distinct datasets'});
  const id=randomUUID(),now=Date.now();
  await db.transaction(async tx=>{
   await tx.query('INSERT INTO agent_rooms VALUES(?,?,?,?,?,0,?,0,NULL,?)',[id,req.wallet,body.name,JSON.stringify(body.tasks),body.cap,now+body.days*86400000,now]);
   for(const g of grants)await tx.query('INSERT INTO agent_room_grants VALUES(?,?)',[id,g.id]);
  });
  res.status(201).json({id});
 });
 app.get('/api/my/agent-rooms',authenticated,async(req,res)=>{
  const {rows}=await db.query('SELECT * FROM agent_rooms WHERE buyer=? ORDER BY created DESC LIMIT 100',[req.wallet]);
  const rooms=[];
  for(const room of rows){
   const grants=await members(room.id,room.buyer);
   rooms.push({...view(room),grants:grants.map(g=>({id:g.id,dataset:g.dataset,name:g.name,price:String(g.price),revoked:Boolean(g.revoked)}))});
  }
  res.json({rooms});
 });
 app.post('/api/my/agent-rooms/:id/key',authenticated,async(req,res)=>{
  const key='loom_room_'+token();
  const {rows}=await db.query('UPDATE agent_rooms SET token_hash=? WHERE id=? AND buyer=? AND revoked=0 AND expires>? RETURNING id',[hash(key),uuid.parse(req.params.id),req.wallet,Date.now()]);
  if(!rows.length)return res.status(404).json({error:'Active room not found'});
  res.json({key});
 });
 app.post('/api/my/agent-rooms/:id/revoke',authenticated,async(req,res)=>{
  const {rows}=await db.query('UPDATE agent_rooms SET revoked=1,token_hash=NULL WHERE id=? AND buyer=? RETURNING id',[uuid.parse(req.params.id),req.wallet]);
  if(!rows.length)return res.status(404).json({error:'Room not found'});
  res.json({ok:true});
 });
 const roomAuth=async(req,res,next)=>{
  const match=req.get('authorization')?.match(/^Bearer (loom_room_[a-f0-9]{64})$/);
  const room=match&&await db.one('SELECT * FROM agent_rooms WHERE token_hash=? AND revoked=0 AND expires>?',[hash(match[1]),Date.now()]);
  if(!room)return res.status(401).json({error:'Active room key required'});
  req.room=room;next();
 };
 app.get('/api/agent/v1/rooms',roomAuth,async(req,res)=>{
  const grants=await members(req.room.id,req.room.buyer);
  const tools=[];
  for(const g of grants)if(!g.revoked&&await sourceAvailable(g))tools.push({grant:g.id,dataset:g.dataset,commitment:g.commitment,name:g.name,purpose:g.purpose,fields:JSON.parse(g.fields),price:String(g.price)});
  res.json({...view(req.room),tools});
 });
 const release=(room,request,price)=>db.transaction(async tx=>{
  const {rows}=await tx.query("UPDATE agent_room_calls SET state='released' WHERE room=? AND request_id=? AND state<>'released' RETURNING price",[room,request]);
  if(rows.length)await tx.query('UPDATE agent_rooms SET spent=spent-? WHERE id=?',[price,room]);
 });
 app.post('/api/agent/v1/rooms/calls',roomAuth,async(req,res)=>{
  const body=callSchema.parse(req.body),room=req.room;
  if(!JSON.parse(room.tasks).includes(body.task))return res.status(403).json({error:'Task is outside room permission'});
  const g=await db.one(grantSelect+' JOIN agent_room_grants rg ON rg.grant_id=g.id WHERE rg.room=? AND g.id=? AND g.buyer=? AND g.revoked=0',[room.id,body.grant,room.buyer]);
  if(!g||!await sourceAvailable(g))return res.status(403).json({error:'Contributor grant or dataset is unavailable'});
  // Room task must match a contributor-defined tool purpose, not a caller-invented instruction.
  if(body.task!==g.purpose)return res.status(403).json({error:'Task must match the contributor-approved tool purpose'});
  const digest=hash(JSON.stringify({grant:body.grant,task:body.task,input:body.input}));
  const old=await db.one('SELECT * FROM agent_room_calls WHERE room=? AND request_id=?',[room.id,body.requestId]);
  if(old){
   if(old.input_hash!==digest)return res.status(409).json({error:'Request ID already used for a different room call'});
   const call=await db.one('SELECT * FROM agent_calls WHERE grant_id=? AND request_id=?',[g.id,body.requestId]);
   if(!call)return res.status(409).json({error:'Call is processing or released; use a new request ID after a failed preparation'});
   return res.json(await callInfo(call));
  }
  if(await db.one('SELECT id FROM agent_calls WHERE grant_id=? AND request_id=?',[g.id,body.requestId]))return res.status(409).json({error:'Request ID already belongs to an existing call'});
  const reserved=await db.transaction(async tx=>{
   const changed=await tx.query('UPDATE agent_rooms SET spent=spent+? WHERE id=? AND token_hash=? AND revoked=0 AND expires>? AND spent+?<=cap RETURNING id',[g.price,room.id,room.token_hash,Date.now(),g.price]);
   if(!changed.rows.length)return false;
   const inserted=await tx.query("INSERT INTO agent_room_calls VALUES(?,?,?,?,?,'reserved',NULL,?) ON CONFLICT(room,request_id) DO NOTHING RETURNING room",[room.id,body.requestId,g.id,digest,g.price,Date.now()]);
   if(!inserted.rows.length){
    await tx.query('UPDATE agent_rooms SET spent=spent-? WHERE id=?',[g.price,room.id]);
    return false;
   }
   return true;
  });
  if(!reserved)return res.status(409).json({error:'Shared room budget exhausted, request processing, or room expired'});
  let result,code=200;
  try{
   const live=await db.one('SELECT id FROM agent_rooms WHERE id=? AND revoked=0 AND expires>?',[room.id,Date.now()]);
   if(!live)throw Error('Room permission changed');
   req.grant=g;req.body={requestId:body.requestId,input:body.input,version:body.version};
   await prepareCall(false)(req,{status(value){code=value;return this;},json(value){result=value;return this;}});
   const call=await db.one('SELECT * FROM agent_calls WHERE grant_id=? AND request_id=?',[g.id,body.requestId]);
   if(call)await db.query("UPDATE agent_room_calls SET call_id=?,state='prepared' WHERE room=? AND request_id=?",[call.id,room.id,body.requestId]);
   else await release(room.id,body.requestId,g.price);
   res.status(code).json(result);
  }catch(error){
   if(!await db.one('SELECT id FROM agent_calls WHERE grant_id=? AND request_id=?',[g.id,body.requestId]))await release(room.id,body.requestId,g.price);
   throw error;
  }
 });
 app.post('/api/agent/v1/rooms/calls/:id/confirm',roomAuth,async(req,res)=>{
  const {signature}=z.object({signature:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/)}).strict().parse(req.body);
  const entry=await db.one('SELECT * FROM agent_room_calls WHERE room=? AND call_id=?',[req.room.id,uuid.parse(req.params.id)]);
  if(!entry)return res.status(404).json({error:'Room call not found'});
  const g=await db.one(grantSelect+' WHERE g.id=? AND g.revoked=0',[entry.grant_id]);
  if(!g||!await sourceAvailable(g))return res.status(403).json({error:'Contributor permission changed'});
  const call=await db.one('SELECT * FROM agent_calls WHERE id=?',[entry.call_id]);
  const result=call&&await settle(g,call,signature);
  if(!result)return res.status(409).json({error:'Checkout unavailable'});
  res.json(result);
 });
 app.get('/api/agent/v1/rooms/calls/:id',roomAuth,async(req,res)=>{
  const entry=await db.one('SELECT * FROM agent_room_calls WHERE room=? AND call_id=?',[req.room.id,uuid.parse(req.params.id)]);
  if(!entry)return res.status(404).json({error:'Room call not found'});
  const g=await db.one(grantSelect+' WHERE g.id=? AND g.revoked=0',[entry.grant_id]);
  if(!g||!await sourceAvailable(g))return res.status(403).json({error:'Contributor permission changed'});
  const call=await db.one('SELECT * FROM agent_calls WHERE id=?',[entry.call_id]);
  if(!call)return res.status(404).json({error:'Call not found'});
  if(JSON.parse(call.quote).expired)await release(req.room.id,entry.request_id,entry.price);
  res.json(await callInfo(call));
 });
}
