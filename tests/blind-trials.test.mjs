import {spawnSync} from 'node:child_process';
import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {openDb} from '../backend/db.mjs';import {openStorage} from '../backend/storage.mjs';import {installBlindTrials,parseBenchmark,evaluateBenchmark} from '../backend/blind-trials.mjs';
const checks=['receipt-1','receipt-2','receipt-3','receipt-4','upstream-1','upstream-2'].map(id=>({id,status:'pass'}));
const evidence={provider:'phala',receiptId:'synthetic-test-receipt',verifiedAt:new Date().toISOString(),checks};
const cases=Array.from({length:5},(_,i)=>({prompt:`Secret task ${i}: name the synthetic color`,expectedAnswer:'turquoise',category:'Colors'}));
test('blind scoring never sends reference keys to models or includes private cases in scorecard',async()=>{
 let calls=0;const score=await evaluateBenchmark({cases,models:['A','B'],infer:async input=>{calls++;assert.deepEqual(Object.keys(input).sort(),['env','model','prompt']);assert(!JSON.stringify(input).includes('turquoise'));return {answer:input.model==='A'?' TURQUOISE ':'other',evidence}}});assert.equal(calls,10);assert.equal(score.models[0].correct,5);assert.equal(score.models[1].correct,0);assert.equal(score.winner,'A');assert(!JSON.stringify(score).includes('Secret task'));assert(!JSON.stringify(score).includes('turquoise'));
 await assert.rejects(()=>evaluateBenchmark({cases,models:['A','B'],infer:async()=>({answer:'turquoise',evidence:{...evidence,checks:[]}})}));
 assert.throws(()=>parseBenchmark(JSON.stringify(cases.slice(0,4))));assert.throws(()=>parseBenchmark(JSON.stringify(cases.map((c,i)=>({...c,category:String(i)})))));
});
test('blind trials require owner consent, verified full run, finalized exact payment, and buyer access',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'loom-trials-')),env={DATA_DIR:dir,STORAGE_MASTER_KEY:Buffer.alloc(32,1).toString('base64'),BLIND_TRIALS_MODELS_READY:'true',CONFIDENTIAL_READY:'true',CONFIDENTIAL_RUNTIME:'phala',ENABLE_QUERY_PAYMENTS:'true',PHALA_AI_API_KEY:'test',SOLANA_RPC_URL:'test',PLATFORM_WALLET:'GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5'},db=await openDb(env),storage=await openStorage(env),id=randomUUID();
 await db.query('CREATE TABLE IF NOT EXISTS query_policies(dataset TEXT PRIMARY KEY,enabled INTEGER)');await db.query('INSERT INTO datasets(id,owner,title,category,description,preview,object_key,commitment,fingerprint,price,license,state,created,analysis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,'owner','Private benchmark','General','Description','Deliberate public preview','key','salted-commitment','fp',100000,'research-v1','draft',Date.now(),'{}']);await storage.put(id,{content:JSON.stringify(cases)});
 let built=0,fail=false,calls=0;const app=express();app.use(express.json());await installBlindTrials(app,{db,storage,env,authenticated:(q,s,n)=>{q.wallet=q.headers['x-wallet'];if(!q.wallet)return s.sendStatus(401);n()},infer:async()=>{calls++;if(fail)throw Error('unverified');return{answer:'turquoise',evidence}},build:async()=>{built++;assert.equal(calls,10);return{transaction:'wire',message:'exact-message',summary:{sellerAmount:'70000',platformAmount:'30000',price:'100000'}}},verify:async(sig,message)=>{assert.equal(message,'exact-message');if(sig!=='1'.repeat(88))throw Error('not paid')}});app.use((e,q,s,n)=>s.status(400).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;const req=async(route,body,wallet='buyer')=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-wallet':wallet},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json()}};const input={dataset:id,models:['qwen/qwen3.8-27b','qwen/qwen-2.5-7b-instruct'],consent:true};
 try{
 assert.equal((await req('/api/datasets/'+id+'/trial-policy',{enabled:true,price:100000,consent:true})).status,404);
 assert.equal((await req('/api/datasets/'+id+'/trial-policy',{enabled:true,price:100000,consent:true},'owner')).status,200);
 const offers=(await req('/api/blind-trials')).data;assert.equal(offers.offers.length,1);assert(!JSON.stringify(offers).includes('turquoise'));
 assert.equal((await req('/api/trial-orders',{...input,models:[input.models[0],input.models[0]]})).status,400);
 await db.query('INSERT INTO consent_state(dataset,paused,changed) VALUES(?,?,?)',[id,1,Date.now()]);
 assert.equal((await req('/api/blind-trials')).data.offers.length,0);
 assert.equal((await req('/api/trial-orders',input)).status,404);
 assert.equal(calls,0);
 await db.query('UPDATE consent_state SET paused=0 WHERE dataset=?',[id]);
 const releaseGate={revision:'a'.repeat(40),minimumAccuracy:100,category:'Colors',maxDrop:0};
 assert.equal((await req('/api/trial-orders',{...input,releaseGate:{...releaseGate,category:'Unknown'}})).status,400);
 const job=await req('/api/trial-orders',{...input,releaseGate});assert.equal(job.status,202);let prepared;for(let n=0;n<100;n++){prepared=await req('/api/trial-jobs/'+job.data.id);if(prepared.data.state!=='running')break;await new Promise(r=>setTimeout(r,10))}assert.equal(prepared.data.state,'ready');assert.equal(built,1);assert.equal(prepared.data.scorecard,undefined);assert.equal(prepared.data.releaseGate,undefined);const oid=job.data.id;
 assert.equal((await req('/api/trial-orders/'+oid)).data.scorecard,undefined);assert.equal((await req('/api/trial-jobs/'+oid,undefined,'other')).status,404);assert.equal((await req('/api/trial-orders/'+oid,undefined,'owner')).status,404);
 assert.equal((await req('/api/trial-orders/'+oid+'/confirm',{signature:'2'.repeat(88)})).status,400);assert.equal((await req('/api/trial-orders/'+oid)).data.scorecard,undefined);
 const paid=await req('/api/trial-orders/'+oid+'/confirm',{signature:'1'.repeat(88)});assert.equal(paid.data.scorecard.models[0].correct,5);assert(!JSON.stringify(paid).includes('Secret task'));assert(!JSON.stringify(paid).includes('turquoise'));assert.equal((await req('/api/my/trial-earnings',undefined,'owner')).data[0].contributorAmount,'70000');
 const {releaseGate:receipt}=paid.data;
 const payload=JSON.parse(receipt.payload);
 assert.equal(payload.verdict,'pass');
 assert.deepEqual(payload.policy,releaseGate);
 assert.equal(payload.benchmark,'salted-commitment');
 assert.equal(payload.checks.length,2);
 const {publicKey}= (await req('/api/release-gates')).data;
 const file=path.join(dir,'receipt.json');
 const verifyGate=(trial, revision)=>spawnSync(process.execPath,
  ['public/tools/verify-release-gate.mjs',file,trial,revision],
  {env:{...process.env,DATALOOM_GATE_PUBLIC_KEY:publicKey},encoding:'utf8'});
 await fs.writeFile(file,JSON.stringify(receipt));
 assert.equal(verifyGate(oid,releaseGate.revision).status,0);
 assert.match(verifyGate(randomUUID(),releaseGate.revision).stderr,/expected trial and revision/);
 assert.match(verifyGate(oid,'b'.repeat(40)).stderr,/expected trial and revision/);
 await fs.writeFile(file,JSON.stringify({...receipt,payload:receipt.payload.replace('100','99')}));
 assert.match(verifyGate(oid,releaseGate.revision).stderr,/Invalid Data Loom signature/);
 await req('/api/datasets/'+id+'/trial-policy',{enabled:false,price:100000,consent:true},'owner');assert.equal((await req('/api/trial-orders',input,'other')).status,404);
 await req('/api/datasets/'+id+'/trial-policy',{enabled:true,price:100000,consent:true},'owner');fail=true;const bad=await req('/api/trial-orders',input,'other');let failed;for(let n=0;n<100;n++){failed=await req('/api/trial-jobs/'+bad.data.id,undefined,'other');if(failed.data.state!=='running')break;await new Promise(r=>setTimeout(r,10))}assert.equal(failed.data.state,'failed');assert.equal(built,1);assert.equal((await req('/api/trial-orders/'+bad.data.id,undefined,'other')).status,404);
 }finally{await new Promise(r=>server.close(r));await db.close();await fs.rm(dir,{recursive:true,force:true})}
});

test('benchmark pools require opt-in, settle by case count, and retain receipts after opt-out', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'loom-pool-'));
 const env={DATA_DIR:dir,STORAGE_MASTER_KEY:Buffer.alloc(32,2).toString('base64'),BLIND_TRIALS_MODELS_READY:'true',
  CONFIDENTIAL_READY:'true',CONFIDENTIAL_RUNTIME:'phala',ENABLE_QUERY_PAYMENTS:'true',PHALA_AI_API_KEY:'test',
  SOLANA_RPC_URL:'test',PLATFORM_WALLET:'GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5'};
 const db=await openDb(env),storage=await openStorage(env);
 t.after(async()=>{await db.close();await fs.rm(dir,{recursive:true,force:true})});
 await db.query('CREATE TABLE query_policies(dataset TEXT PRIMARY KEY,enabled INTEGER)');
 const datasets=[randomUUID(),randomUUID()];
 for(const [index,id] of datasets.entries()){
  await db.query('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
   [id,'owner'+index,'Benchmark '+index,'General','Public description','Public preview','key','commitment-'+index,'fp',100001,'research-v1','draft',Date.now(),'{}']);
  await storage.put(id,{content:JSON.stringify(index===0?cases:[...cases,...cases])});
 }
 const app=express();
 app.use(express.json());
 let inferred=0,built=0;
 await installBlindTrials(app,{
  db,storage,env,authenticated:(req,res,next)=>{req.wallet=req.headers['x-wallet'];next()},
  infer:async input=>{inferred++;assert(!JSON.stringify(input).includes('turquoise'));return {answer:'turquoise',evidence}},
  build:async ({trialContributors,price})=>{
   built++;
   assert.equal(price,200002);
   assert.equal(trialContributors.reduce((sum,source)=>sum+Number(source.amount),0),140001);
   assert.equal(trialContributors.find(source=>source.cases===5).amount,'46667');
   assert.equal(trialContributors.find(source=>source.cases===10).amount,'93334');
   return {transaction:'pool-wire',message:'pool-message',summary:{price:String(price),sellerAmount:'140001',platformAmount:'60001'}};
  },
  verify:async (signature,message)=>assert.deepEqual([signature,message],['1'.repeat(88),'pool-message'])
 });
 app.use((error,req,res,next)=>res.status(400).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 try {
  async function request(route,body,wallet='buyer'){
   const response=await fetch('http://127.0.0.1:'+server.address().port+route,{
    method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-wallet':wallet},
    body:body===undefined?undefined:JSON.stringify(body)
   });
   return {status:response.status,data:await response.json()};
  }
  const policy=(index,pool)=>request('/api/datasets/'+datasets[index]+'/trial-policy',{enabled:true,price:100001,consent:true,pool},'owner'+index);
  const input={datasets,models:['qwen/qwen3.8-27b','qwen/qwen-2.5-7b-instruct'],consent:true};
  assert.equal((await policy(0,true)).status,200);
  assert.equal((await policy(1,false)).status,200);
  assert.equal((await request('/api/trial-orders',input)).status,404);
  assert.equal(inferred,0);
  assert.equal((await policy(1,true)).status,200);
  assert.equal((await request('/api/trial-orders',input,'owner1')).status,409);
  const job=await request('/api/trial-orders',input);
  assert.equal(job.status,202);
  const id=job.data.id;
  let prepared;
  for(let attempt=0;attempt<100;attempt++){
   prepared=await request('/api/trial-jobs/'+id);
   if(prepared.data.state!=='running')break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(prepared.data.state,'ready');
  assert.equal(inferred,30);
  assert.equal(built,1);
  assert.equal(prepared.data.scorecard,undefined);
  assert.equal((await request('/api/trial-orders/'+id,undefined,'stranger')).status,404);
  assert.equal((await request('/api/my/trial-earnings',undefined,'owner0')).data.length,0);
  assert.equal((await policy(1,false)).status,200);
  assert.equal((await request('/api/trial-orders',input,'stranger')).status,404);
  const {data:paid}=await request('/api/trial-orders/'+id+'/confirm',{signature:'1'.repeat(88)});
  assert.equal(paid.pooled,true);
  assert.equal(paid.scorecard.models[0].correct,15);
  assert.deepEqual(Object.keys(paid.scorecard.models[0].categories),['Combined']);
  assert(!JSON.stringify(paid).includes('Secret task'));
  assert(!JSON.stringify(paid).includes('turquoise'));
  assert.equal((await request('/api/my/trial-earnings',undefined,'owner0')).data[0].contributorAmount,'46667');
  assert.equal((await request('/api/my/trial-earnings',undefined,'owner1')).data[0].contributorAmount,'93334');
 } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('private router ranks passing models by cost and omits raw benchmark material', async () => {
 const benchmark = ['Routine', 'Disputes', 'Escalations'].flatMap(category =>
  cases.map(c => ({...c, prompt: category + ': ' + c.prompt, category})));
 const score = await evaluateBenchmark({
  cases: benchmark,
  models: ['cheap', 'mid', 'premium'],
  router: {minimumAccuracy: 80, costPerThousandMicros: [100000, 200000, 900000]},
  infer: async ({prompt, model}) => ({
   answer: prompt.startsWith('Routine') || (prompt.startsWith('Disputes') && model !== 'cheap') ? 'turquoise' : 'incorrect',
   evidence
  })
 });
 assert.deepEqual(score.router.categories.map(({category,recommendation}) => [category, recommendation?.model ?? null]), [
  ['Routine', 'cheap'], ['Disputes', 'mid'], ['Escalations', null]
 ]);
 assert.equal(score.models.flatMap(model => model.receipts).length, 45);
 assert(!JSON.stringify(score).includes('Secret task'));
 assert(!JSON.stringify(score).includes('turquoise'));
});
