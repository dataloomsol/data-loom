import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {test} from 'node:test';
import express from 'express';
import {openDb} from '../backend/db.mjs';
import {installSealedAuctions,rankBids} from '../backend/sealed-auctions.mjs';
import {hash} from '../backend/security.mjs';

test('auction ordering respects reserve, amount, deadline order and slot count',() => {
  assert.deepEqual(rankBids([
    {amount:10,sequence:1},{amount:20,sequence:3},{amount:20,sequence:2},{amount:25,sequence:4}
  ],20,2).map(b => b.sequence),[4,2]);
});

test('auction stores encrypted bids and publishes only winning tags',async t => {
  const directory = await mkdtemp('/tmp/loom-auctions-');
  const db = await openDb({DATA_DIR:directory});
  const app = express();
  app.use(express.json());
  const id = randomUUID();
  const commitment = hash('dataset');
  await db.query('INSERT INTO datasets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id,'owner','Dataset','Research','','Preview',id,commitment,'',10000,'research-v1','draft',1,'{}']);
  const checkout = await installSealedAuctions(app,{
    db,protectedRuntime:true,payments:true,env:{CONFIDENTIAL_READY:'true',STORAGE_MASTER_KEY:Buffer.alloc(32,1).toString('base64')},
    attestationClient:{getQuote:async digest=>({quote:digest.toString('hex')})},
    authenticated:(req,res,next) => {req.wallet=req.get('x-wallet');return req.wallet ? next() : res.sendStatus(401);}
  });
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async () => {
    await new Promise(resolve=>server.close(resolve));
    await db.close();
    await rm(directory,{recursive:true,force:true});
  });
  const base = 'http://127.0.0.1:'+server.address().port+'/api/sealed-auctions';
  const post = (path,wallet,body) => fetch(base+path,{method:'POST',
    headers:{'content-type':'application/json','x-wallet':wallet},body:JSON.stringify(body)});
  const created = await post('','owner',{dataset:id,reserveMicroUsdc:20000,licenseSlots:1,closesAt:Date.now()+120000,consent:true});
  assert.equal(created.status,201);
  const auction = (await created.json()).id;
  const path = '/'+auction;
  const bid = (wallet,amountMicroUsdc) => post(path+'/bids',wallet,{amountMicroUsdc});
  assert.equal((await bid('owner',100000)).status,409);
  assert.equal((await bid('too-low',10000)).status,409);
  const first = await bid('first',40217);
  assert.equal(first.status,201);
  const {tag} = await first.json();
  assert.equal((await bid('second',40217)).status,201);
  assert.equal((await bid('first',50000)).status,409);
  assert.equal((await post(path+'/finalize','owner',{})).status,409);
  const stored = await db.one('SELECT ciphertext FROM sealed_auction_bids WHERE auction=? AND buyer=?',[auction,'first']);
  assert.doesNotMatch(Buffer.from(stored.ciphertext,'base64').toString(),/40217/);
  await db.query('UPDATE sealed_auctions SET close_at=? WHERE id=?',[Date.now()-1,auction]);
  assert.equal((await bid('late',80000)).status,409);
  const response = await post(path+'/finalize','owner',{});
  assert.equal(response.status,200);
  const result = await response.json();
  assert.deepEqual(result.report.winningTags,[tag]);
  assert.equal(result.attestation.quote.quote,hash(JSON.stringify(result.report)));
  assert.doesNotMatch(JSON.stringify(result),/40217|"first"|"second"/);
  assert.equal((await checkout(auction,id,'first')).price,40217);
  assert.equal(await checkout(auction,id,'second'),null);
});
