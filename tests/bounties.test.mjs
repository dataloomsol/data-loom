import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {openDb} from '../backend/db.mjs';
import {installBounties} from '../backend/bounties.mjs';
test('only selected paid reports are delivered to the buyer',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'loom-bounty-'));
 const db=await openDb({DATA_DIR:dir});const objects=new Map();const storage={put:(id,v)=>objects.set(id,v),get:id=>objects.get(id),remove:id=>objects.delete(id)};
 const app=express();app.use(express.json(),(req,res,next)=>{req.wallet=req.headers['x-test-wallet'];next()});
 const paidSignature='3'.repeat(88);let paid=false;
 await installBounties(app,{db,storage,env:{},payments:true,authenticated:(q,r,n)=>q.wallet?n():r.sendStatus(401),build:async q=>{assert.deepEqual(new Set(q.bountyOwners),new Set(['alice','bob']));return{transaction:'wire',message:'bound',simulation:true}},verify:async(sig,msg)=>{assert([paidSignature,'4'.repeat(88)].includes(sig));assert.equal(msg,'bound');assert(paid)}});
 await db.query('CREATE TABLE trial_orders(id TEXT PRIMARY KEY,buyer TEXT,state TEXT,signature TEXT)');
 const trial=randomUUID();
 await db.query('INSERT INTO trial_orders VALUES(?,?,?,?)',[trial,'buyer','paid','trial-signature']);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 async function call(route,wallet,body){return fetch('http://127.0.0.1:'+server.address().port+'/api/bounties'+route,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-test-wallet':wallet},...(body?{body:JSON.stringify(body)}:{})})}
 try{
  const b=await(await call('','buyer',{question:'What did your team observe?',criteria:'Provide a reproducible measurement.',price:7500000})).json();assert.ok(b.id);
  const reports=[];
  for(const owner of ['alice','bob','carol']){
   const dataset=randomUUID();await db.query('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[dataset,owner,'title','category','description','preview','key','hash','fp',10000,'terms','draft',Date.now(),'{}']);
   const report={dataset,consent:true,preview:'Public proposal',answer:'Confidential findings from '+owner};
   assert.equal((await call('/'+b.id+'/reports','intruder',report)).status,403);
   reports.push((await(await call('/'+b.id+'/reports',owner,report)).json()).id);
  }
  assert.equal((await call('/'+b.id+'/award','alice',{selected:reports.slice(0,2)})).status,403);
  const award=await call('/'+b.id+'/award','buyer',{selected:reports.slice(0,2)});assert.equal(award.status,200);
  const read=async wallet=>(await(await call('/'+b.id,wallet)).json()).reports;
  assert((await read('buyer')).every(r=>!r.answer));paid=true;
  assert.equal((await call('/'+b.id+'/confirm','buyer',{signature:paidSignature})).status,200);
  assert.equal((await read('buyer')).filter(r=>r.answer).length,2);assert((await read('alice')).every(r=>!r.answer));
  const brief={kind:'gap',trial,question:'Spanish billing evaluation cases',criteria:'Provide clear prompts and reference answers.',price:7500000};
  assert.equal((await call('','intruder',brief)).status,404);
  const created=await call('','buyer',brief);
  assert.equal(created.status,201);
  const gap=(await created.json()).id;
  const details=async wallet=>(await(await call('/'+gap,wallet)).json());
  assert.equal((await details('buyer')).kind,'gap');
  assert(!JSON.stringify(await details('intruder')).includes(trial));
  const packs=[];
  for(const owner of ['alice','bob','carol']){
   const {id:dataset}=await db.one('SELECT id FROM datasets WHERE owner=?',[owner]);
   const answer=JSON.stringify(Array.from({length:5},(_,i)=>({prompt:'Private Spanish question '+owner+i,expectedAnswer:'private reference'})));
   const data={dataset,consent:true,preview:'Spanish billing scenarios',answer};
   assert.equal((await call('/'+gap+'/reports',owner,{...data,answer:'Invalid JSON, do not store'})).status,400);
   const submission=await call('/'+gap+'/reports',owner,data);
   assert.equal(submission.status,201);
   packs.push((await submission.json()).id);
  }
  assert((await details('buyer')).reports.every(r=>!r.cases));
  assert.equal((await call('/'+gap+'/award','buyer',{selected:packs.slice(0,2)})).status,200);
  assert.equal((await call('/'+gap+'/confirm','buyer',{signature:'4'.repeat(88)})).status,200);
  const delivered=(await details('buyer')).reports.filter(r=>r.cases);
  assert.deepEqual(new Set(delivered.map(r=>r.id)),new Set(packs.slice(0,2)));
  assert(delivered.every(r=>r.cases.length===5));
  assert((await details('intruder')).reports.every(r=>!r.cases));
 
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await rm(dir,{recursive:true,force:true})}
});
