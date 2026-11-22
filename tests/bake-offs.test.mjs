import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import bs58 from 'bs58';
import { openDb } from '../backend/db.mjs';
import { installBakeOffs } from '../backend/bake-offs.mjs';

test('comparison stays private until the sponsor publishes aggregate rankings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-bake-'));
  const db = await openDb({DATA_DIR:dir});
  const wallet = n => bs58.encode(Buffer.alloc(32,n));
  const [sponsor, first, second] = [1,2,3].map(wallet);
  const dataset = randomUUID();
  const objects = new Map([[dataset,{content:'hidden benchmark'}]]);
  await db.query('CREATE TABLE trial_policies (dataset TEXT PRIMARY KEY, enabled INTEGER)');
  await db.query('INSERT INTO trial_policies VALUES (?,1)',[dataset]);
  await db.query('INSERT INTO datasets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [dataset,sponsor,'Benchmark','Coding','','','','commitment','fingerprint',0,'research-v1','draft',1,'{}']);
  const app=express();
  app.use(express.json());
  app.use((req,_res,next)=>{req.wallet=req.get('x-wallet');next()});
  await installBakeOffs(app,{
    db, models:['test-model'], env:{},
    authenticated:(req,res,next)=>req.wallet?next():res.sendStatus(401),
    storage:{get:async id=>objects.get(id),put:async(id,value)=>objects.set(id,value),remove:async id=>objects.delete(id)},
    parseBenchmark: content => {assert.equal(content,'hidden benchmark');return [1,2,3,4,5]},
    evaluateBenchmark:async ({benchmarkPrompt,beforeCase})=>{
      await beforeCase();
      return {models:[{correct:benchmarkPrompt==='vendor private instructions'?5:4,total:5,
        averageLatencyMs:123,reportedCostUsd:0.1,receipts:Array(5).fill({})}]};
    },
  });
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    await db.close();
    await rm(dir,{recursive:true,force:true});
  });
  async function request(path, actor, body) {
    return fetch('http://127.0.0.1:'+server.address().port+'/api/bake-offs'+path,{
      method:body?'POST':'GET',
      headers:{...(actor?{'x-wallet':actor}:{}),'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,
    });
  }
  const created=await request('',sponsor,{dataset,title:'Test benchmark',vendors:[first,second]});
  assert.equal(created.status,201);
  const {id}=await created.json();
  const path='/'+id;
  assert.equal((await request(path)).status,404);
  assert.equal((await request(path+'/publication',sponsor,{published:true})).status,409);
  for (const [actor,label,prompt] of [[first,'Candidate A','vendor private instructions'],[second,'Candidate B','']]) {
    const entry=await request(path+'/entries',actor,{label,model:'test-model',prompt,consentToPublish:true});
    assert.equal(entry.status,201);
    const result=await request(path+'/evaluate/'+(await entry.json()).id,sponsor,{});
    assert.equal(result.status,202);
  }
  for(let i=0;i<50;i++){
    if((await (await request(path,sponsor)).json()).rankings.length===2)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const vendor=await (await request(path,first)).json();
  assert.equal(vendor.own.correct,5);
  assert.equal(vendor.rankings,undefined);
  assert.equal(vendor.entries,undefined);
  assert.equal((await request(path+'/publication',first,{published:true})).status,404);
  assert.equal((await request(path+'/publication',sponsor,{published:true})).status,200);
  const publicResult=await (await request(path)).json();
  assert.deepEqual(publicResult.rankings.map(row=>row.label),['Candidate A','Candidate B']);
  assert.equal(publicResult.entries,undefined);
  assert.ok(!JSON.stringify(publicResult).includes('vendor private instructions'));
  assert.equal((await request(path+'/publication',sponsor,{published:false})).status,200);
  assert.equal((await request(path)).status,404);
});
