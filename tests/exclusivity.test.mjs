import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {test,mock} from 'node:test';
import bs58 from 'bs58';
import express from 'express';
import {openDb} from '../backend/db.mjs';
import {installExclusivity} from '../backend/exclusivity.mjs';
import {LICENSES} from '../backend/api.mjs';
import {hash} from '../backend/security.mjs';

test('exclusive reservation has one checkout and proves only a matching scoped license',async t=>{
  const dir = await mkdtemp('/tmp/loom-exclusivity-');
  const db = await openDb({DATA_DIR:dir});
  const app = express();
  app.use(express.json());
  const dataset = randomUUID();
  const buyer = bs58.encode(Buffer.alloc(32,2));
  const commitment = hash('test source');
  await db.query('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [dataset,'seller','Private catalog','Research','','Preview',dataset,commitment,'',10000,'research-v1','draft',1,'{}']);
  const checkout = await installExclusivity(app,{
    db,protectedRuntime:true,payments:true,env:{CONFIDENTIAL_READY:'true'},licenses:LICENSES,
    attestationClient:{getQuote:async digest=>({quote:digest.toString('hex')})},
    authenticated:(req,_res,next)=>{req.wallet=req.get('x-wallet');next();}
  });
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    await db.close();
    await rm(dir,{recursive:true,force:true});
  });
  const url = 'http://127.0.0.1:'+server.address().port+'/api/exclusivity';
  const get = (path,wallet='seller')=>fetch(url+path,{headers:{'x-wallet':wallet}});
  const startsAt = Date.now()+600000;
  const endsAt = startsAt+3600000;
  const input = {dataset,buyer,use:'research',market:'India',startsAt,endsAt,consent:true};
  const create = payload=>fetch(url,{method:'POST',
    headers:{'content-type':'application/json','x-wallet':'seller'},body:JSON.stringify(payload)});
  assert.equal((await create({...input,use:'model-training'})).status,409);
  const created = await create(input);
  assert.equal(created.status,201);
  const {id} = await created.json();
  assert.equal((await db.one('SELECT state FROM datasets WHERE id=?',[dataset])).state,'exclusive');
  assert.equal((await create(input)).status,409);
  assert.equal((await get('/'+id,'other')).status,404);
  assert.equal(await checkout.checkout(id,dataset,'other'),null);
  assert.equal((await get('/'+id,buyer)).status,200);

  const orderId = randomUUID();
  const reserve = idForPayment=>db.transaction(tx=>checkout.reserveCheckout(tx,
    {id,dataset,buyer,orderId:idForPayment,expires:Date.now()+120000}));
  assert.ok(await reserve(orderId));
  assert.equal(await reserve(randomUUID()),null);
  assert.equal(await checkout.confirm(db,dataset,'other',orderId),null);
  const {terms} = await checkout.confirm(db,dataset,buyer,orderId);
  assert.match(terms,/research in India/);
  assert.equal((await get('/'+id+'/proof')).status,409);
  await db.query('INSERT INTO licenses VALUES(?,?,?,?,?,?)',[randomUUID(),buyer,dataset,orderId,terms,Date.now()]);
  assert.equal(await checkout.allowsDownload(dataset,buyer),false);
  mock.method(Date,'now',()=>startsAt);
  try {
    assert.equal(await checkout.allowsDownload(dataset,buyer),true);
    assert.equal(await checkout.allowsDownload(dataset,'other'),false);
  } finally {mock.restoreAll();}
  const proofResponse = await get('/'+id+'/proof');
  assert.equal(proofResponse.status,200);
  const proof = await proofResponse.json();
  assert.equal(proof.report.commitment,commitment);
  assert.equal(proof.report.termsDigest,hash(terms));
  assert.equal(proof.attestation.quote.quote,hash(JSON.stringify(proof.report)));
  assert.ok(!JSON.stringify(proof).includes(buyer));
  await db.query('INSERT INTO licenses VALUES(?,?,?,?,?,?)',[randomUUID(),'other',dataset,randomUUID(),terms,Date.now()]);
  assert.equal((await get('/'+id+'/proof')).status,409);
});
