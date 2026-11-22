import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {installAgentTools} from '../backend/agent-tools.mjs';
import {openDb} from '../backend/db.mjs';
import {openStorage} from '../backend/storage.mjs';

test('agent keys are scoped, caps survive retries, and only verified payments unlock typed decisions',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'loom-agents-'));
 const env={DATA_DIR:dir,CONFIDENTIAL_READY:'true',CONFIDENTIAL_RUNTIME:'phala',ENABLE_QUERY_PAYMENTS:'true',
  PHALA_AI_API_KEY:'test',PHALA_MODEL:'test',SOLANA_RPC_URL:'test',PLATFORM_WALLET:'GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5'};
 const db=await openDb(env),storage=await openStorage(env);
 t.after(async()=>{await db.close();await fs.rm(dir,{recursive:true,force:true})});
 await db.query('CREATE TABLE query_quota(slot TEXT PRIMARY KEY,created BIGINT)');
 await db.query('CREATE TABLE trial_policies(dataset TEXT PRIMARY KEY,enabled INTEGER)');
 const dataset=randomUUID(),owner='owner',buyer='9zzN2FkbG2AwHZCH1cnH6Wxo4V7YzFoKKqJXRvLATohJ';
 await db.query('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  [dataset,owner,'Refund policy','General','Test description','Public preview','key','commitment','fp',10000,'research-v1','draft',Date.now(),'{}']);
 await storage.put(dataset,{content:'This is a synthetic confidential policy. Refunds are considered within 30 days.'});
 const app=express();
 app.use(express.json());
 const auth=(req,res,next)=>{req.wallet=req.get('x-test-wallet');return req.wallet?next():res.sendStatus(401)};
 const checks=['receipt-1','receipt-2','receipt-3','receipt-4','upstream-1','upstream-2'].map(id=>({id,status:'pass'}));
 let inferred=0,broken=false,built=0;
 await installAgentTools(app,{db,storage,env,authenticated:auth,
  complete:async()=>{inferred++;return {answer:'{"decision":"eligible","reason":"The order is within the eligible window."}',
   evidence:{provider:'phala',receiptId:'test-receipt',verifiedAt:'2026-11-10',checks:broken?[]:checks}}},
  build:async ({id,price,license,buyer:payingWallet})=>{
   built++;
   assert.equal(payingWallet,buyer);
   assert.equal(Number(price),license.includes('Batch')?2000000:10000);
   return {transaction:'transaction',message:id,summary:{price:String(price)},quoteSlot:5,lastValidBlockHeight:30};
  },
  verify:async(signature,message)=>{assert.match(message,/^[a-f0-9-]{36}$/);if(!['1'.repeat(88),'3'.repeat(88),'4'.repeat(88),'5'.repeat(88)].includes(signature))throw Error('Not finalized')},
  rpc:async method=>({getBlockHeight:31,getFirstAvailableBlock:1,getSignaturesForAddress:[]})[method]
 });
 app.use((error,req,res,next)=>res.status(400).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 async function request(route,{wallet,key,body}={}){
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api'+route,{
   method:body===undefined?'GET':'POST',
   headers:{'content-type':'application/json',...(wallet?{'x-test-wallet':wallet}:{}),...(key?{authorization:'Bearer '+key}:{})},
   body:body===undefined?undefined:JSON.stringify(body)
  });
  return {status:response.status,data:await response.json()};
 }
 try{
  const tool={dataset,name:'refund_check',purpose:'Check eligibility for a refund.',fields:[{name:'age',type:'number'}],decisions:['eligible','unknown'],price:10000,consent:true};
  assert.equal((await request('/my/agent-tools',{wallet:buyer,body:tool})).status,409);
  const {data:{id:toolId}}=await request('/my/agent-tools',{wallet:owner,body:tool});
  const {data:{id:grant}}=await request('/my/agent-tools/'+toolId+'/grants',{wallet:owner,body:{buyer,label:'Support agent',cap:10000}});
  const keyPath='/my/agent-grants/'+grant+'/key';
  assert.equal((await request(keyPath,{wallet:owner,body:{}})).status,404);
  const {data:{key}}=await request(keyPath,{wallet:buyer,body:{}});
  const {data:{key:rotated}}=await request(keyPath,{wallet:buyer,body:{}});
  assert.equal((await request('/agent/v1/tool',{key})).status,401);
  assert.equal((await request('/agent/v1/tool',{key:rotated})).data.inputSchema.properties.age.type,'number');
  const calls='/agent/v1/calls',body={requestId:randomUUID(),input:{age:14}};
  assert.equal((await request(calls,{key:rotated,body:{...body,input:{age:'14'}}})).status,400);
  broken=true;
  assert.equal((await request(calls,{key:rotated,body})).status,400);
  broken=false;
  const prepared=await request(calls,{key:rotated,body});
  assert.equal(prepared.status,201);
  assert.equal(prepared.data.output,undefined);
  assert.equal(prepared.data.evidence,undefined);
  assert.equal((await request(calls,{key:rotated,body})).data.id,prepared.data.id);
  assert.equal((await request(calls,{key:rotated,body:{...body,input:{age:60}}})).status,409);
  assert.equal((await request(calls,{key:rotated,body:{...body,requestId:randomUUID()}})).status,409);
  const call=calls+'/'+prepared.data.id;
  assert.equal((await request(call+'/confirm',{key:rotated,body:{signature:'2'.repeat(88)}})).status,400);
  assert.equal((await request(call,{key:rotated})).data.output,undefined);
  assert.equal((await request(call+'/recover',{key:rotated,body:{}})).data.state,'expired');
  const next=await request(calls,{key:rotated,body:{...body,requestId:randomUUID()}});
  assert.equal(next.status,201);
  assert.equal(inferred,3);
  await request('/my/agent-grants/'+grant+'/revoke',{wallet:owner,body:{}});
  const paidPath=calls+'/'+next.data.id;
  assert.equal((await request(paidPath,{key:rotated})).status,401);
  assert.equal((await request(paidPath,{wallet:owner})).status,404);
  const paid=await request(paidPath+'/confirm',{wallet:buyer,body:{signature:'1'.repeat(88)}});
  assert.equal(paid.data.output.decision,'eligible');
  assert.equal(paid.data.evidence.receiptId,'test-receipt');
  assert.equal((await request(paidPath,{wallet:buyer})).data.state,'paid');
  assert.equal((await request('/my/agent-tools',{wallet:buyer})).data.grants[0].reservedOrSpent,'10000');
  // Re-enable this test grant to exercise paid-memory access independently.
  await db.query('UPDATE agent_grants SET revoked=0,token_hash=? WHERE id=?',[(await import('../backend/security.mjs')).hash(rotated),grant]);
  const memories='/agent/v1/memories', memoryBody={call:next.data.id,days:3};
  assert.equal((await request(memories,{key:rotated,body:memoryBody})).status,403);
  const policy='/my/agent-grants/'+grant+'/memory-policy';
  assert.equal((await request(policy,{wallet:buyer,body:{days:3}})).status,404);
  assert.equal((await request(policy,{wallet:owner,body:{days:3}})).status,200);
  assert.equal((await request(memories,{key:rotated,body:{...memoryBody,days:4}})).status,403);
  assert.equal((await request(memories,{key:rotated,body:memoryBody})).status,201);
  assert.equal((await request(memories,{key:rotated})).data.memories[0].output.decision,'eligible');
  const evidenceBody={title:'Refund evidence',days:2,claims:[{claim:'Refund decision supports review',call:next.data.id}]};
  const evidencePolicy='/my/agent-grants/'+grant+'/evidence-policy';
  assert.equal((await request('/agent/v1/evidence-packs',{wallet:buyer,body:evidenceBody})).status,403);
  assert.equal((await request(evidencePolicy,{wallet:buyer,body:{days:3,maxReasonChars:10}})).status,404);
  assert.equal((await request(evidencePolicy,{wallet:owner,body:{days:3,maxReasonChars:10}})).status,200);
  assert.equal((await request('/agent/v1/evidence-packs',{wallet:buyer,body:{...evidenceBody,claims:[{claim:'Unpaid proof',call:prepared.data.id}]}})).status,403);
  const evidencePack=await request('/agent/v1/evidence-packs',{wallet:buyer,body:evidenceBody});
  assert.equal(evidencePack.status,201);
  const evidencePath='/agent/v1/evidence-packs/'+evidencePack.data.id;
  assert.equal((await request(evidencePath,{wallet:owner})).status,404);
  const exported=(await request(evidencePath,{key:rotated})).data;
  assert.equal(exported.claims[0].evidence.reason.length,10);
  assert.equal(exported.claims[0].evidence.inferenceReceipt.receiptId,'test-receipt');
  assert.equal(JSON.stringify(exported).includes('synthetic confidential policy'),false);
  assert.match(exported.manifestSha256,/^[a-f0-9]{64}$/);
  await request(evidencePolicy,{wallet:owner,body:{days:3,maxReasonChars:0}});
  assert.equal((await request(evidencePath,{wallet:buyer})).data.claims[0].evidence.reason,undefined);
  await request(evidencePolicy,{wallet:owner,body:{days:0,maxReasonChars:0}});
  assert.equal((await request(evidencePath,{wallet:buyer})).status,403);
  await request(evidencePolicy,{wallet:owner,body:{days:3,maxReasonChars:10}});
  await db.query('UPDATE evidence_packs SET expires=0 WHERE id=?',[evidencePack.data.id]);
  assert.equal((await request(evidencePath,{wallet:buyer})).status,404);
  await db.query('UPDATE consent_state SET paused=1 WHERE dataset=?',[dataset]);
  await db.query('INSERT INTO consent_state VALUES(?,1,?) ON CONFLICT(dataset) DO UPDATE SET paused=1',[dataset,Date.now()]);
  assert.equal((await request(memories,{key:rotated})).status,403);
  await db.query('UPDATE consent_state SET paused=0 WHERE dataset=?',[dataset]);
  await request(policy,{wallet:owner,body:{days:0}});
  assert.equal((await request(memories,{key:rotated})).status,403);
  await request(policy,{wallet:owner,body:{days:3}});
  await db.query('UPDATE agent_memories SET expires=0 WHERE grant_id=?',[grant]);
  assert.equal((await request(memories,{key:rotated})).data.memories.length,0);
  await request('/my/agent-grants/'+grant+'/revoke',{wallet:owner,body:{}});
  assert.equal((await request(memories,{key:rotated})).status,401);
  const requestGrant=(await request('/my/agent-tools/'+toolId+'/grants',{wallet:owner,body:{buyer,label:'Research agent',cap:10000}})).data.id;
  const requestKey=(await request('/my/agent-grants/'+requestGrant+'/key',{wallet:buyer,body:{}})).data.key;
  const requests='/agent/v1/data-requests';
  const question={requestId:randomUUID(),question:'What additional evidence is required?',task:'Review this specific refund case for support.'};
  const submitted=await request(requests,{key:requestKey,body:question});
  assert.equal(submitted.status,201);
  assert.equal((await request(requests,{key:requestKey,body:question})).data.id,submitted.data.id);
  assert.equal((await request(requests,{key:requestKey,body:{...question,task:'Different stated task in the same request'}})).status,409);
  const reply='/my/data-requests/'+submitted.data.id+'/respond';
  assert.equal((await request(reply,{wallet:buyer,body:{response:'Private information',consent:true}})).status,404);
  assert.equal((await request(reply,{wallet:owner,body:{response:'Ask for the original order receipt.',consent:true}})).status,200);
  assert.equal((await request(reply,{wallet:owner,body:{response:'Overwrite',consent:true}})).status,409);
  const pending=await request(requests+'/'+submitted.data.id,{key:requestKey});
  assert.equal(pending.data.response,undefined);
  const acceptedRequest=await request(requests+'/'+submitted.data.id+'/accept',{key:requestKey,body:{accept:true}});
  assert.equal(acceptedRequest.status,201);
  const responseCall='/agent/v1/calls/'+submitted.data.id;
  assert.equal((await request(responseCall,{key:requestKey})).data.output,undefined);
  const delivered=await request(responseCall+'/confirm',{key:requestKey,body:{signature:'4'.repeat(88)}});
  assert.equal(delivered.data.output.response,'Ask for the original order receipt.');
  assert.equal(delivered.data.evidence,undefined);
  assert.equal(delivered.data.provenance.kind,'contributor-response');
  assert.equal((await request(requests+'/'+submitted.data.id,{key:requestKey})).data.state,'paid');
  const batchGrant=(await request('/my/agent-tools/'+toolId+'/grants',{wallet:owner,
   body:{buyer,label:'Batch agent',cap:2000000,batch:true}})).data.id;
  const batchKey=(await request('/my/agent-grants/'+batchGrant+'/key',{wallet:buyer,body:{}})).data.key;
  const batches='/agent/v1/batches',batchBody={requestId:randomUUID(),cases:Array.from({length:200},(_,age)=>({age}))};
  assert.equal((await request(batches,{key:batchKey,body:{...batchBody,cases:[...batchBody.cases,{age:201}]}})).status,400);
  const {status:accepted,data:batch}=await request(batches,{key:batchKey,body:batchBody});
  assert.equal(accepted,202);
  const route=batches+'/'+batch.id;
  const order=calls+'/'+batch.id;
  let state;
  for(let attempt=0;attempt<100;attempt++){
   state=(await request(route,{key:batchKey})).data;
   if(state.state!=='running')break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(state.state,'ready');
  assert.equal(state.results,undefined);
  assert.equal(inferred,203);
  assert.equal(built,3);
  assert.equal((await request(batches,{key:batchKey,body:batchBody})).data.id,batch.id);
  assert.equal((await request(batches,{key:batchKey,body:{...batchBody,cases:[{age:1},{age:2}]}})).status,409);
  assert.equal((await request(route,{wallet:owner})).status,404);
  const quote=await request(route+'/checkout',{wallet:buyer,body:{}});
  assert.equal(quote.data.state,'prepared');
  assert.equal(quote.data.caseCount,200);
  assert.equal(quote.data.summary.price,'2000000');
  assert.equal(quote.data.results,undefined);
  assert.equal((await request(route+'/cancel',{wallet:buyer,body:{}})).status,409);
  assert.equal((await request(order+'/recover',{key:batchKey,body:{}})).data.state,'ready');
  assert.equal((await request(route+'/checkout',{key:batchKey,body:{}})).data.state,'prepared');
  assert.equal(inferred,203);
  const batchPaid=await request(order+'/confirm',{key:batchKey,body:{signature:'3'.repeat(88)}});
  assert.equal(batchPaid.data.results.length,200);
  assert.deepEqual(batchPaid.data.results.map(row=>row.row),Array.from({length:200},(_,i)=>i+1));
  assert(batchPaid.data.results.every(row=>row.evidence.receiptId==='test-receipt'&&row.output.decision==='eligible'));
  assert.equal((await request(route,{wallet:buyer})).data.state,'paid');
  assert.equal((await request('/my/agent-tools',{wallet:buyer})).data.grants.find(g=>g.id===batchGrant).reservedOrSpent,'2000000');

  const secondDataset=randomUUID();
  await db.query('INSERT INTO datasets SELECT ?,owner,title,category,description,preview,object_key,commitment,fingerprint,price,license,state,created,analysis FROM datasets WHERE id=?',[secondDataset,dataset]);
  await storage.put(secondDataset,{content:'Synthetic second dataset for room checks.'});
  const secondTool=(await request('/my/agent-tools',{wallet:owner,body:{...tool,dataset:secondDataset,name:'second_refund_check'}})).data.id;
  const roomGrants=[];
  for(const id of [toolId,secondTool])roomGrants.push((await request('/my/agent-tools/'+id+'/grants',{wallet:owner,body:{buyer,label:'Room agent',cap:10000}})).data.id);
  const roomBody={name:'Support project',grants:roomGrants,tasks:[tool.purpose],cap:10000,days:7};
  assert.equal((await request('/my/agent-rooms',{wallet:owner,body:roomBody})).status,409);
  const createdRoom=await request('/my/agent-rooms',{wallet:buyer,body:roomBody});
  assert.equal(createdRoom.status,201);
  const roomId=createdRoom.data.id;
  const roomKey=(await request('/my/agent-rooms/'+roomId+'/key',{wallet:buyer,body:{}})).data.key;
  assert.equal((await request('/agent/v1/rooms',{key:roomKey})).data.tools.length,2);
  const roomCall={grant:roomGrants[0],task:tool.purpose,requestId:randomUUID(),input:{age:14}};
  assert.equal((await request('/agent/v1/rooms/calls',{key:roomKey,body:{...roomCall,task:'Unapproved analysis'}})).status,403);
  const concurrent=await Promise.all(roomGrants.map(grant=>request('/agent/v1/rooms/calls',{key:roomKey,body:{...roomCall,grant,requestId:randomUUID()}})));
  assert.equal(concurrent.filter(r=>r.status===201).length,1);
  assert.equal(concurrent.filter(r=>r.status===409).length,1);
  const roomState=(await request('/my/agent-rooms',{wallet:buyer})).data.rooms.find(r=>r.id===roomId);
  assert.equal(roomState.reservedOrSpent,'10000');
  const preparedRoomCall=concurrent.find(r=>r.status===201).data;
  const roomRead='/agent/v1/rooms/calls/'+preparedRoomCall.id;
  assert.equal((await request(roomRead,{key:roomKey})).data.output,undefined);
  const roomPaid=await request(roomRead+'/confirm',{key:roomKey,body:{signature:'5'.repeat(88)}});
  assert.equal(roomPaid.data.output.decision,'eligible');
  await request('/my/agent-grants/'+roomGrants[concurrent.findIndex(r=>r.status===201)]+'/revoke',{wallet:owner,body:{}});
  assert.equal((await request(roomRead,{key:roomKey})).status,403);
  await db.query('UPDATE agent_rooms SET expires=0 WHERE id=?',[roomId]);
  assert.equal((await request('/agent/v1/rooms',{key:roomKey})).status,401);

 }finally{await new Promise(resolve=>server.close(resolve))}
});
