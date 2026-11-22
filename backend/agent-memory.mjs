import {randomUUID} from 'node:crypto';
import {z} from 'zod';

const retention = z.object({days:z.number().int().min(0).max(30)}).strict();
const remember = z.object({call:z.string().uuid(),days:z.number().int().min(1).max(30)}).strict();

export async function installAgentMemory(app,{db,storage,bearer,authenticated,sourceAvailable,grantSelect}) {
 await db.query('CREATE TABLE IF NOT EXISTS agent_memory_policies(grant_id TEXT PRIMARY KEY,days INTEGER NOT NULL)');
 await db.query('CREATE TABLE IF NOT EXISTS agent_memories(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,call_id TEXT NOT NULL,commitment TEXT NOT NULL,created BIGINT NOT NULL,expires BIGINT NOT NULL,UNIQUE(grant_id,call_id))');

 app.post('/api/my/agent-grants/:id/memory-policy',authenticated,async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id);
  const {days}=retention.parse(req.body);
  const grant=await db.one(grantSelect+' WHERE g.id=? AND t.owner=? AND g.revoked=0',[id,req.wallet]);
  if(!grant)return res.status(404).json({error:'Active contributor grant required'});
  await db.query('INSERT INTO agent_memory_policies(grant_id,days) VALUES(?,?) ON CONFLICT(grant_id) DO UPDATE SET days=excluded.days',[id,days]);
  res.json({days});
 });

 const allowed=async(grant)=>{
  const policy=await db.one('SELECT p.days FROM agent_memory_policies p JOIN agent_grants g ON g.id=p.grant_id WHERE p.grant_id=? AND g.revoked=0',[grant.id]);
  return policy?.days>0&&await sourceAvailable(grant)?Number(policy.days):0;
 };
 app.get('/api/agent/v1/memories',bearer,async(req,res)=>{
  const days=await allowed(req.grant);
  if(!days)return res.status(403).json({error:'Contributor memory permission and active source required'});
  const {rows}=await db.query('SELECT * FROM agent_memories WHERE grant_id=? AND commitment=? AND expires>? ORDER BY created DESC LIMIT 100',[req.grant.id,req.grant.commitment,Date.now()]);
  const memories=[];
  for(const row of rows){
   if(Number(row.created)+days*86400000<=Date.now())continue;
   const call=await db.one('SELECT signature FROM agent_calls WHERE id=? AND grant_id=?',[row.call_id,req.grant.id]);
   if(!call?.signature)continue;
   const result=await storage.get(row.call_id);
   if(result.source?.commitment!==row.commitment||!result.evidence?.receiptId)continue;
   memories.push({id:row.id,call:row.call_id,source:result.source,output:result.output,evidence:result.evidence,
    expires:Math.min(Number(row.expires),Number(row.created)+days*86400000)});
  }
  if(!await allowed(req.grant))return res.status(403).json({error:'Source permission changed'});
  res.json({memories});
 });
 app.post('/api/agent/v1/memories',bearer,async(req,res)=>{
  const body=remember.parse(req.body),days=await allowed(req.grant);
  if(!days||body.days>days)return res.status(403).json({error:'Requested retention exceeds contributor permission'});
  const call=await db.one('SELECT * FROM agent_calls WHERE id=? AND grant_id=? AND signature IS NOT NULL',[body.call,req.grant.id]);
  if(!call||JSON.parse(call.quote).batch)return res.status(404).json({error:'Paid individual call required'});
  const result=await storage.get(call.id);
  if(result.source?.commitment!==req.grant.commitment||!result.output||!result.evidence?.receiptId)return res.status(409).json({error:'Version-bound verified decision required'});
  const now=Date.now();
  await db.query('INSERT INTO agent_memories VALUES(?,?,?,?,?,?) ON CONFLICT(grant_id,call_id) DO NOTHING',[randomUUID(),req.grant.id,call.id,req.grant.commitment,now,now+body.days*86400000]);
  const memory=await db.one('SELECT id,expires FROM agent_memories WHERE grant_id=? AND call_id=?',[req.grant.id,call.id]);
  res.status(201).json(memory);
 });
 app.delete('/api/agent/v1/memories/:id',bearer,async(req,res)=>{
  await db.query('DELETE FROM agent_memories WHERE id=? AND grant_id=?',[z.string().uuid().parse(req.params.id),req.grant.id]);
  res.json({ok:true});
 });
}
