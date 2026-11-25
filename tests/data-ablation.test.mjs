import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {test} from 'node:test';
import express from 'express';
import {installDataAblation,measureAblation} from '../backend/data-ablation.mjs';
import {openDb} from '../backend/db.mjs';
import {hash} from '../backend/security.mjs';

test('ablation rejects tokenized overlap between training and holdout',() => {
  assert.throws(() => measureAblation(
    [{prompt:'Apple, orchard!',expectedAnswer:'fruit'}],
    [[{text:'APPLE ORCHARD',label:'fruit'}]]
  ),/holdout/);
});

test('ablation releases attested differences to the buyer after all version owners approve',async t => {
  const directory = await mkdtemp('/tmp/loom-ablation-test-');
  const db = await openDb({DATA_DIR:directory});
  const app = express();
  app.use(express.json());
  const benchmarkOwner = 'benchmark-owner', firstOwner = 'first-owner', secondOwner = 'second-owner';
  const buyer = '11111111111111111111111111111111';
  const examples = [
    Array.from({length:10},(_,i) => ({prompt:`secret winter apple ${i}`,expectedAnswer:'fruit'})),
    [{text:'apple winter orchard',label:'fruit'},{text:'car seat',label:'vehicle'}],
    [{text:'apple driveway',label:'vehicle'},{text:'plum basket',label:'fruit'}]
  ];
  const objects = new Map();
  for (const [index,owner] of [benchmarkOwner,firstOwner,secondOwner].entries()) {
    const id = randomUUID(), salt = randomUUID(), content = JSON.stringify(examples[index]);
    objects.set(id,{salt,content});
    await db.query('INSERT INTO datasets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id,owner,'name','category','','',id,hash(salt+'\n'+content),hash(content),0,'research-v1','private',0,'']);
  }
  const [benchmark,...sources] = objects.keys();
  let quoteCount = 0;
  let revokeDuringQuote = false;
  let id;
  await installDataAblation(app,{
    db,storage:{get:async id => objects.get(id)},
    env:{CONFIDENTIAL_RUNTIME:'phala',CONFIDENTIAL_READY:'true'},
    authenticated:(req,res,next) => {
      req.wallet = req.get('x-wallet');
      return req.wallet ? next() : res.sendStatus(401);
    },
    attestationClient:{getQuote:async digest => {
      quoteCount++;
      if (revokeDuringQuote) await db.query('DELETE FROM ablation_permissions WHERE study=? AND dataset=?',[id,sources[1]]);
      return {quote:digest.toString('hex')};
    }}
  });
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await db.close();
    await rm(directory,{recursive:true,force:true});
  });
  const base = 'http://127.0.0.1:'+server.address().port+'/api/data-ablation/studies';
  const post = (path,wallet,body) => fetch(base+path,{method:'POST',
    headers:{'content-type':'application/json',...(wallet && {'x-wallet':wallet})},body:JSON.stringify(body)});
  const created = await post('',buyer,{benchmark,sources});
  assert.equal(created.status,201);
  ({id} = await created.json());
  const run = wallet => post('/'+id+'/run',wallet,{});
  const grant = (dataset,role,owner) => post('/'+id+'/permission',owner,{dataset,role,buyer,approve:true});
  assert.equal((await run(null)).status,401);
  assert.equal((await run(buyer)).status,409);
  assert.equal((await grant(benchmark,'training',benchmarkOwner)).status,404);
  assert.equal((await grant(benchmark,'benchmark',firstOwner)).status,404);
  assert.equal((await grant(benchmark,'benchmark',benchmarkOwner)).status,204);
  assert.equal((await grant(sources[0],'training',firstOwner)).status,204);
  assert.equal((await grant(sources[1],'training',secondOwner)).status,204);
  revokeDuringQuote = true;
  assert.equal((await run(buyer)).status,409);
  revokeDuringQuote = false;
  assert.equal((await grant(sources[1],'training',secondOwner)).status,204);
  const response = await run(buyer);
  assert.equal(response.status,201);
  const document = await response.json();
  assert.deepEqual(document.report.differences.map(row => row.accuracyDeltaPoints),[100,0]);
  assert.equal(document.attestation.quote.quote,hash(JSON.stringify(document.report)));
  assert.doesNotMatch(JSON.stringify(document),/secret winter|apple driveway|expectedAnswer/);
  assert.equal((await run(firstOwner)).status,404);
  assert.deepEqual(await (await run(buyer)).json(),document);
  assert.equal(quoteCount,2);
  const duplicate = await post('',buyer,{benchmark,sources});
  assert.equal(duplicate.status,201);
  ({id} = await duplicate.json());
  assert.equal((await grant(benchmark,'benchmark',benchmarkOwner)).status,204);
  assert.equal((await grant(sources[0],'training',firstOwner)).status,204);
  assert.equal((await grant(sources[1],'training',secondOwner)).status,204);
  assert.equal((await run(buyer)).status,409);
  assert.equal(quoteCount,2);
});
