import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import express from 'express';
import bs58 from 'bs58';
import {openDb} from '../backend/db.mjs';
import {openStorage} from '../backend/storage.mjs';
import {hash} from '../backend/security.mjs';
import {installComputeCapsules} from '../backend/compute-capsules.mjs';
import {prepareCapsuleRecipient} from '../public/tools/compute-capsule-client.mjs';

test('compute capsules bind ciphertext to the approved attested key, version and buyer', async t => {
  const dir=await mkdtemp(tmpdir()+'/loom-capsule-test-');
  const db=await openDb({DATA_DIR:dir}),storage=await openStorage({DATA_DIR:dir});
  const app=express();
  app.use(express.json());
  const buyer=bs58.encode(randomBytes(32)),dataset=randomUUID();
  const workload={appId:'a'.repeat(40),composeHash:'b'.repeat(64),osImageHash:'c'.repeat(64)};
  const content='[{"purchaseOrder":"private-example"}]',salt='test-salt',commitment=hash(salt+'\n'+content);
  await storage.put(dataset,{salt,content});
  await db.query('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [dataset,'owner','Sample','General','Fixture','Fixture','object',commitment,'fp',10000,'research-v1','draft',1,'{}']);
  await installComputeCapsules(app,{db,storage,protectedRuntime:true,
    env:{CONFIDENTIAL_RUNTIME:'phala',CONFIDENTIAL_READY:'true',CAPSULE_VERIFIER_URL:'http://127.0.0.1:4189/verify'},
    authenticated:(req,res,next)=>{req.wallet=req.get('x-wallet');if(!req.wallet)return res.sendStatus(401);next();},
    fetchImpl:async (_url,{body})=>new Response(JSON.stringify({is_valid:true,details:{
      quote_verified:true,event_log_verified:true,os_image_hash_verified:true,acpi_tables_verified:true,
      os_image_is_dev:false,tcb_status:'UpToDate',advisory_ids:[],report_data:JSON.parse(body).quote+'0'.repeat(64),
      app_info:{app_id:workload.appId,compose_hash:workload.composeHash,os_image_hash:workload.osImageHash}
    }}))});
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{await new Promise(r=>server.close(r));await db.close();await rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port+'/api/compute-capsules';
  const post=(wallet,path,body={})=>fetch(base+path,{method:'POST',
    headers:{'content-type':'application/json','x-wallet':wallet},body:JSON.stringify(body)});
  const created=await post('owner','/grants',{dataset,buyer,workload,consent:true});
  assert.equal(created.status,201);
  const {id}=await created.json();
  const path='/grants/'+id+'/challenge';
  assert.equal((await post('stranger',path)).status,404);
  const getChallenge=async()=> (await post(buyer,path)).json();
  const quote={getQuote:async data=>({quote:data.toString('hex')})};
  const a=await prepareCapsuleRecipient(await getChallenge(),quote);
  assert.equal((await post(buyer,'/release',{...a.submission,publicKey:'e'.repeat(64)})).status,403);
  assert.equal((await post(buyer,'/release',a.submission)).status,404);
  const b=await prepareCapsuleRecipient(await getChallenge(),quote);
  const response=await post(buyer,'/release',b.submission);
  assert.equal(response.status,200);
  const capsule=await response.json();
  assert.doesNotMatch(JSON.stringify(capsule),/private-example/);
  assert.throws(()=>a.open(capsule));
  assert.equal(b.open(capsule),content);
  assert.throws(()=>b.open(capsule));
  const pending=await prepareCapsuleRecipient(await getChallenge(),quote);
  assert.equal((await post('owner','/grants/'+id+'/revoke')).status,200);
  assert.equal((await post(buyer,'/release',pending.submission)).status,404);
});
