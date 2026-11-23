import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import express from 'express';
import bs58 from 'bs58';
import {randomBytes} from 'node:crypto';
import {openDb} from '../backend/db.mjs';
import {openStorage} from '../backend/storage.mjs';
import {hash} from '../backend/security.mjs';
import {installByom} from '../backend/byom.mjs';

test('BYOM binds an aggregate-only scorecard to an attested private version and caps reruns', async t => {
  const dir = await mkdtemp(tmpdir()+'/loom-byom-test-');
  const env = {DATA_DIR:dir,CONFIDENTIAL_RUNTIME:'phala',CONFIDENTIAL_READY:'true'};
  const db = await openDb(env), storage = await openStorage(env);
  const app = express();
  app.use(express.json());
  const authenticated = (req,res,next) => {
    req.wallet = req.get('x-wallet');
    if (!req.wallet) return res.sendStatus(401);
    next();
  };
  const quotes = [];
  await installByom(app,{db,storage,env,authenticated,attestationClient:{getQuote:async data => {
    quotes.push(data.toString('hex'));
    return {fixture:true};
  }}});
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await db.close();
    await rm(dir,{recursive:true,force:true});
  });
  const base = 'http://127.0.0.1:'+server.address().port+'/api/byom';
  const request = (wallet,path,body) => fetch(base+path,{method:body?'POST':'GET',
    headers:{'content-type':'application/json',...(wallet && {'x-wallet':wallet})},body:body&&JSON.stringify(body)});
  const dataset = randomUUID(), salt = 'fixture';
  const content = JSON.stringify(Array.from({length:10},(_,i)=>({prompt:'private valid '+i,expectedAnswer:'allow'})));
  const commitment = hash(salt+'\n'+content);
  await db.query('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [dataset,'owner','Sample','General','Fixture','Fixture','object',commitment,'fp',10000,'research-v1','draft',1,'{}']);
  await storage.put(dataset,{salt,content});
  const model = {format:'linear-text-v1',vocabulary:['valid'],
    classes:[{label:'allow',bias:0,weights:[2]},{label:'deny',bias:1,weights:[0]}]};
  const body = {dataset,model,nonce:'a'.repeat(64),consent:true};
  const buyers = Array.from({length:6},()=>bs58.encode(randomBytes(32)));
  for (const buyer of buyers) {
    assert.equal((await request('owner','/grants',{dataset,buyer,enabled:true,consent:true})).status,200);
  }
  assert.equal((await request(null,'/runs',body)).status,401);
  assert.equal((await request('outsider','/runs',body)).status,404);
  const concurrent = await Promise.all([request(buyers[0],'/runs',body),request(buyers[0],'/runs',body)]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,201]);
  const [first,repeat] = await Promise.all(concurrent.map(r=>r.json()));
  assert.deepEqual(first,repeat);
  assert.equal(quotes.length,1);
  assert.equal(quotes[0],hash(JSON.stringify(first.scorecard)));
  assert.equal(first.scorecard.sourceCommitment,commitment);
  assert.equal(first.scorecard.modelHash,hash(JSON.stringify(model)));
  assert.deepEqual(first.scorecard.accuracyPercent,{lower:80,upper:100,upperInclusive:true});
  assert.doesNotMatch(JSON.stringify(first),/private valid|expectedAnswer|"weights"/);
  assert.equal((await request('owner','/scorecards/'+dataset)).status,404);
  assert.equal((await request(buyers[0],'/runs',{...body,model:{...model,vocabulary:['expired']}})).status,409);
  for (const buyer of buyers.slice(1,5)) assert.equal((await request(buyer,'/runs',body)).status,201);
  assert.equal((await request(buyers[5],'/runs',body)).status,429);
});
