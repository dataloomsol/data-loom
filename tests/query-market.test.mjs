import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {openDb} from '../backend/db.mjs';import {openStorage} from '../backend/storage.mjs';import {installQueryMarket,guardAnswer} from '../backend/query-market.mjs';
test('answer guard rejects verbatim disclosure and identifiers',()=>{assert.throws(()=>guardAnswer('one two three four five six seven eight nine ten eleven twelve','one two three four five six seven eight nine ten eleven twelve'));assert.throws(()=>guardAnswer('Contact foo@example.com for details','other content'))});
test('paid queries prepare answers first, deny unpaid access, verify payment, and never grant file licenses',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'loom-query-')),env={DATA_DIR:dir,ENABLE_QUERY_PAYMENTS:'true',ENABLE_CONVENTIONAL_QUERY_PROCESSING:'true',AI_API_KEY:'test',AI_MODEL:'test',SOLANA_RPC_URL:'test',PLATFORM_WALLET:'GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5'},db=await openDb(env),storage=await openStorage(env),id=randomUUID(),owner='owner',buyer='buyer';
 await db.query('INSERT INTO datasets(id,owner,title,category,description,preview,object_key,commitment,fingerprint,price,license,state,created,analysis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,owner,'Source','General','Description','Preview','key','commitment','fingerprint',100000,'research-v1','draft',Date.now(),'{}']);await storage.put(id,{content:'Design guidance for an application: validate all incoming parameters carefully before use.'});
 let inferred=0,built=0,verified=0,fail=false;const app=express();app.use(express.json());await installQueryMarket(app,{db,storage,env,authenticated:(q,s,n)=>{q.wallet=q.headers['x-wallet'];if(!q.wallet)return s.sendStatus(401);n()},infer:async()=>{inferred++;if(fail)throw Error('failure');return 'Input validation reduces avoidable errors.'},build:async()=>{built++;assert(inferred>0);return{transaction:'wire',message:'exact',summary:{sellerAmount:'70000',platformAmount:'30000'}}},verify:async(sig,message)=>{verified++;assert.equal(message,'exact');if(sig!=='1'.repeat(88))throw Error('wrong payment')}});app.use((e,q,s,n)=>s.status(400).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;const req=async(route,body,wallet=buyer)=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-wallet':wallet},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json()}};
 try{assert.equal((await req('/api/datasets/'+id+'/query-policy',{enabled:true,price:100000,consent:true})).status,404);await req('/api/datasets/'+id+'/query-policy',{enabled:true,price:100000,consent:true},owner);assert.equal((await req('/api/query-market')).data.offers.length,1);
 await db.query('INSERT INTO consent_state(dataset,paused,changed) VALUES(?,?,?)',[id,1,Date.now()]);
 assert.equal((await req('/api/query-market')).data.offers.length,0);
 assert.equal((await req('/api/query-orders',{dataset:id,question:'What is recommended?',consent:true})).status,404);
 assert.equal(inferred,0);
 await db.query('UPDATE consent_state SET paused=0 WHERE dataset=?',[id]);
 fail=true;assert.equal((await req('/api/query-orders',{dataset:id,question:'What is recommended?',consent:true})).status,400);assert.equal(built,0);fail=false;const prepared=await req('/api/query-orders',{dataset:id,question:'What is recommended?',consent:true});assert.equal(prepared.status,200);assert.equal(prepared.data.answer,undefined);const oid=prepared.data.id;assert.equal((await req('/api/query-orders/'+oid)).data.answer,undefined);assert.equal((await req('/api/query-orders/'+oid,undefined,owner)).status,404);assert.equal((await req('/api/query-orders/'+oid+'/confirm',{signature:'2'.repeat(88)})).status,400);assert.equal((await req('/api/query-orders/'+oid)).data.answer,undefined);const paid=await req('/api/query-orders/'+oid+'/confirm',{signature:'1'.repeat(88)});assert.equal(paid.data.answer,'Input validation reduces avoidable errors.');assert.equal((await req('/api/query-orders/'+oid+'/confirm',{signature:'1'.repeat(88)})).status,200);assert.equal(verified,2);assert.equal((await db.query('SELECT * FROM licenses')).rows.length,0);assert.equal((await req('/api/my/query-earnings',undefined,owner)).data.length,1);fail=true;for(let n=0;n<8;n++)assert.equal((await req('/api/query-orders',{dataset:id,question:'Another question?',consent:true})).status,400);assert.equal((await req('/api/query-orders',{dataset:id,question:'Another question?',consent:true})).status,429);await req('/api/datasets/'+id+'/query-policy',{enabled:false,price:100000,consent:true},owner);assert.equal((await req('/api/query-orders',{dataset:id,question:'Another question?',consent:true})).status,404);assert.equal((await req('/api/query-orders/'+oid)).data.answer,paid.data.answer);
 }finally{await new Promise(r=>server.close(r));await db.close();await fs.rm(dir,{recursive:true,force:true})}
});

test('DATALOOM queries require contributor opt-in and keep their currency after opt-out',async()=>{
 const {DATALOOM}=await import('../backend/settlement.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'loom-token-query-'));
 const env={DATA_DIR:dir,ENABLE_QUERY_PAYMENTS:'true',CONFIDENTIAL_RUNTIME:'phala',CONFIDENTIAL_READY:'true',PHALA_AI_API_KEY:'test',PHALA_MODEL:'test',SOLANA_RPC_URL:'test',PLATFORM_WALLET:'GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5'};
 const db=await openDb(env),storage=await openStorage(env),id=randomUUID();
 await db.query('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  [id,'owner','Private source','General','Description','Preview','key','commitment','fingerprint',100000,'research-v1','draft',Date.now(),'{}']);
 await storage.put(id,{content:'Synthetic policy text for this test.'});
 const app=express();app.use(express.json());
 await installQueryMarket(app,{db,storage,env,authenticated:(req,res,next)=>{req.wallet=req.get('x-wallet');next()},
  inferConfidential:async()=>({answer:'The conditions are met.',evidence:{provider:'phala',receiptId:'test-receipt'}}),
  build:async ({paymentMint,price,license,buybackWallet})=>{
   assert.equal(paymentMint,DATALOOM);assert.equal(Number(price),250000000);assert.match(license,/Paid in DATALOOM/);assert.equal(buybackWallet,undefined);
   return {transaction:'wire',message:'token-quote',summary:{mint:DATALOOM,price:String(price),sellerAmount:'175000000',platformAmount:'75000000',currency:'DATALOOM'}};
  },
  verify:async(signature,message)=>assert.deepEqual([signature,message],['3'.repeat(88),'token-quote'])
 });
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 async function request(route,body,wallet='buyer'){
  const res=await fetch('http://127.0.0.1:'+server.address().port+'/api'+route,{method:body===undefined?'GET':'POST',
   headers:{'content-type':'application/json','x-wallet':wallet},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,data:await res.json()};
 }
 try{
  const policy='/datasets/'+id+'/query-policy',config={enabled:true,price:100000,consent:true};
  const order={dataset:id,question:'Are the conditions met?',consent:true,currency:'DATALOOM'};
  await request(policy,config,'owner');
  assert.equal((await request('/query-orders',order)).status,409);
  await request(policy,{...config,tokenPrice:250000000},'owner');
  assert.equal((await request('/query-market')).data.offers[0].tokenPrice,'250000000');
  const quote=await request('/query-orders',order);
  assert.equal(quote.status,200);
  assert.equal(quote.data.summary.mint,DATALOOM);
  assert.equal(quote.data.answer,undefined);
  await request(policy,{...config,tokenPrice:null},'owner');
  assert.equal((await request('/query-orders',order)).status,409);
  const paid=await request('/query-orders/'+quote.data.id+'/confirm',{signature:'3'.repeat(88)});
  assert.equal(paid.data.currency,'DATALOOM');assert.equal(paid.data.answer,'The conditions are met.');
  assert.equal((await request('/my/query-earnings',undefined,'owner')).data[0].currency,'DATALOOM');
 }finally{await new Promise(resolve=>server.close(resolve));await db.close();await fs.rm(dir,{recursive:true,force:true})}
});
