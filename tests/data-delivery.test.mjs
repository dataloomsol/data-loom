import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {test} from 'node:test';
import express from 'express';
import {openDb} from '../backend/db.mjs';
import {deliveryChecks,installDataDelivery} from '../backend/data-delivery.mjs';
import {hash} from '../backend/security.mjs';

test('delivery criteria reject invalid JSON rows and missing values',() => {
  for (const content of ['invalid','[null]','[{}]','[{"region":" "}]']) {
    assert.equal(deliveryChecks(content,{minimumRows:1,requiredField:'region'}),null);
  }
  assert.equal(deliveryChecks('[{"region":"secret"}]',{minimumRows:1,requiredField:'region'}).requiredField.passed,true);
});

test('licensed direct updates deliver signed metadata once per release',async t => {
  const temp = await mkdtemp('/tmp/loom-data-delivery-');
  const db = await openDb({DATA_DIR:temp});
  const app = express();
  app.use(express.json());
  const parent = randomUUID(), version = randomUUID();
  const buyer = '11111111111111111111111111111111';
  const secret = 'test-signing-secret-only-not-for-production';
  const content = '[{"region":"private-row-value"}]';
  const salt = 'fixture';
  const commitment = hash(salt+'\n'+content);
  for (const [id,analysis] of [[parent,{}],[version,{lineage:{parentId:parent,parentCommitment:commitment}}]]) {
    await db.query('INSERT INTO datasets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id,'owner','private title','Research','','',id,commitment,'',0,'research-v1','draft',1,JSON.stringify(analysis)]);
  }
  const deliveries = [];
  const deliver = await installDataDelivery(app,{
    db,storage:{get:async () => ({salt,content})},protectedRuntime:true,
    env:{CONFIDENTIAL_READY:'true',DATA_DELIVERY_DESTINATIONS:JSON.stringify({
      [buyer]:{url:'https://receiver.example/webhook',secret}
    })},
    authenticated:(req,res,next) => {req.wallet = req.get('x-wallet');return req.wallet ? next() : res.sendStatus(401);},
    send:async(url,options) => {deliveries.push({url,options});return {ok:true};}
  });
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async () => {
    app.emit('loom-close');
    await new Promise(resolve => server.close(resolve));
    await db.close();
    await rm(temp,{recursive:true,force:true});
  });
  const base = 'http://127.0.0.1:'+server.address().port+'/api/data-delivery';
  const post = (path,wallet,body) => fetch(base+path,{method:'POST',
    headers:{'content-type':'application/json','x-wallet':wallet},body:JSON.stringify(body)});
  const subscribe = () => post('/subscriptions',buyer,{parent,checks:{minimumRows:1,requiredField:'region'}});
  const release = wallet => post('/releases',wallet,{version,consent:true});
  assert.equal((await subscribe()).status,403);
  await db.query('INSERT INTO licenses VALUES (?,?,?,?,?,?)',[randomUUID(),buyer,parent,randomUUID(),'terms',1]);
  assert.equal((await subscribe()).status,201);
  assert.equal((await release(buyer)).status,404);
  assert.equal((await release('owner')).status,202);
  assert.equal((await release('owner')).status,202);
  await deliver();
  await deliver();
  assert.equal(deliveries.length,1);
  const {url,options:{headers,body,redirect}} = deliveries[0];
  const event = JSON.parse(body);
  assert.equal(url,'https://receiver.example/webhook');
  assert.equal(redirect,'error');
  assert.equal(event.version.commitment,commitment);
  assert.equal(event.eventId,headers['Idempotency-Key']);
  assert.equal(headers['X-Data-Loom-Signature'],'sha256='+createHmac('sha256',secret)
    .update(headers['X-Data-Loom-Timestamp']+'.'+body).digest('hex'));
  assert.doesNotMatch(body,/private-row-value|private title/);
});
