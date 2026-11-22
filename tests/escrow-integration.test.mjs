import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import express from 'express';import {randomUUID} from 'node:crypto';
import {createEscrowChain} from '../backend/escrow-chain.mjs';import {installDataEscrow} from '../backend/data-escrow.mjs';import {openDb} from '../backend/db.mjs';import {openStorage} from '../backend/storage.mjs';import {hash} from '../backend/security.mjs';
// Opt in explicitly: needs the compiled SBF program and Python solders. Ordinary npm tests stay portable.
test('HTTP escrow lifecycle uses the real adapter and SBF vault through LiteSVM', {skip:process.env.LOOM_ESCROW_SVM!=='1'},async t=>{
 const child=spawn('python3',['programs/private-data-escrow/tests/rpc_bridge.py'],{stdio:['pipe','pipe','inherit']});t.after(()=>child.kill());const lines=createInterface({input:child.stdout}),pending=new Map();let n=0;const initial=await new Promise((resolve,reject)=>{lines.once('line',l=>resolve(JSON.parse(l)));child.once('exit',code=>reject(Error('VM exited '+code)));});
 lines.on('line',l=>{const r=JSON.parse(l),p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(Error(r.error)):p.resolve(r.result)});
 const rpc=(method,params=[])=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n')});
 const roles=initial.roles,code=await fs.readFile('programs/private-data-escrow/target/deploy/loom_data_escrow.so');const env={DATA_ESCROW_PROGRAM:initial.program,DATA_ESCROW_PROGRAM_HASH:hash(code),DATA_ESCROW_PROGRAM_SIZE:String(code.length),DATA_ESCROW_VERIFIER:roles.verifier,PLATFORM_WALLET:roles.platform,SOLANA_RPC_URL:'test'};
 const chain=createEscrowChain(env,{rpc});assert.equal(await chain.verifyProgram(),true);
 const broken=createEscrowChain({...env,DATA_ESCROW_PROGRAM_HASH:'0'.repeat(64)},{rpc});await assert.rejects(()=>broken.verifyProgram(),/binary/);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'loom-vault-flow-'));env.DATA_DIR=dir;const db=await openDb(env),storage=await openStorage(env);t.after(async()=>{await db.close();await fs.rm(dir,{recursive:true,force:true})});const app=express();app.use(express.json());const auth=(q,s,next)=>{q.wallet=q.get('x-wallet');q.wallet?next():s.sendStatus(401)};await installDataEscrow(app,{db,storage,authenticated:auth,chain});app.use((e,q,s,next)=>s.status(400).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const req=async(p,who,body)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+p,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-wallet':roles[who]||who},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}};
 const dataset=randomUUID(),content='[{"category":"a","answer":"yes"},{"category":"b","answer":"no"}]';await db.query('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[dataset,roles.contributor,'Test','General','Escrow test table','Preview','key','version-one','fp',10000,'research-v1','draft',Date.now(),'{}']);await storage.put(dataset,{content});
 const criteria={minRows:2,maxRows:10,requiredFields:[{name:'answer',type:'string'}],minCompletenessBps:10000,maxDuplicateBps:0,coverage:{field:'category',values:['a','b'],minPerValue:1}};
 async function create(){const r=await req('/api/my/data-escrows','buyer',{title:'Private coverage',contributor:roles.contributor,price:10000,days:1,license:'research-v1',criteria});assert.equal(r.status,201);return r.data;}
 const row=await create(),base='/api/my/data-escrows/'+row.id;
 const action=(a,who,body={})=>req(base+'/'+a,who,body);
 assert.equal((await action('submit','contributor',{dataset,consent:true})).status,409);
 await action('accept','contributor',{termsHash:row.termsHash});
 async function send(a,who){const r=await action(a,who);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.simulation,true);const sent=await rpc('__send',[r.data.transaction]);assert.equal(sent.value.err,null);return r;}
 await send('initialize','buyer');await send('accept-vault','contributor');await send('fund','buyer');
 assert.equal((await action('sync','buyer')).data.state,'funded');assert.equal((await action('download','buyer')).status,403);assert.equal((await action('fund','buyer')).status,400);
 const submitted=await action('submit','contributor',{dataset,consent:true});assert.equal(submitted.status,201);assert.equal(submitted.data.report.passed,true);
 // Mutating the original does not replace the agreed encrypted snapshot.
 await storage.put(dataset,{content:'[{"wrong":"changed"}]'});
 assert.equal((await action('release','buyer')).status,400);await send('release','verifier');
 const delivery=await action('download','buyer');assert.equal(delivery.status,200);assert.equal(delivery.data.content,content);assert.equal(delivery.data.source.commitment,'version-one');assert.equal((await action('download','contributor')).status,403);
 const second=await create(),p='/api/my/data-escrows/'+second.id;await req(p+'/accept','contributor',{termsHash:second.termsHash});
 for(const [a,who]of [['initialize','buyer'],['accept-vault','contributor'],['fund','buyer']]){const r=await req(p+'/'+a,who,{});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal((await rpc('__send',[r.data.transaction])).value.err,null);}
 assert.equal((await req(p+'/refund','buyer',{})).status,400);
 await rpc('__clock',[Math.floor(second.deadline/1000)+1]);const oldNow=Date.now;Date.now=()=>second.deadline+1000;
 try{const r=await req(p+'/refund','buyer',{});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal((await rpc('__send',[r.data.transaction])).value.err,null);assert.equal((await req(p+'/sync','buyer',{})).data.state,'refunded');assert.equal((await req(p+'/download','buyer',{})).status,403);}finally{Date.now=oldNow}
});
