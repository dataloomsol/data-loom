import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import express from 'express';
import {openDb} from '../backend/db.mjs';
import {openStorage} from '../backend/storage.mjs';
import {hash} from '../backend/security.mjs';
import {installPrivateAggregate,computeAggregate} from '../backend/private-aggregate.mjs';
import {initializePrivateSqlBudget} from '../backend/private-sql-budget.mjs';

test('private aggregates suppress undersized groups even with favorable noise', () => {
  const noise = count => count + 100;
  const rows = Array.from({length:29}, () => ({period:'earlier', value:5}));
  assert.deepEqual(computeAggregate(rows,{statistic:'count'},noise),{status:'suppressed'});
  assert.deepEqual(computeAggregate(rows,{statistic:'median',column:'value',lower:0,upper:10},noise),{status:'suppressed'});
  assert.deepEqual(computeAggregate(rows,{statistic:'trend',column:'period',earlier:'earlier',later:'later'},noise),{status:'suppressed'});
  const sample = [...Array.from({length:60}, () => ({period:'earlier',value:5})),
    ...Array.from({length:70}, () => ({period:'later',value:5}))];
  assert.deepEqual(computeAggregate(sample,{statistic:'trend',column:'period',earlier:'earlier',later:'later'},x=>x),
    {status:'available',earlier:60,later:70,change:10});
  assert.equal(computeAggregate(sample,{statistic:'median',column:'value',lower:0,upper:16},x=>x).median,5.5);
});

test('private aggregate releases share a budget and stay gated behind buyer payment', async t => {
  const dir = await mkdtemp(tmpdir()+'/loom-aggregate-test-');
  const db = await openDb({DATA_DIR:dir});
  const storage = await openStorage({DATA_DIR:dir});
  await initializePrivateSqlBudget(db,250);
  const app = express();
  app.use(express.json());
  const authenticated = (req,res,next) => {
    req.wallet = req.get('x-test-wallet');
    if (!req.wallet) return res.sendStatus(401);
    next();
  };
  const dataset = randomUUID(), salt = 'test-salt';
  const content = JSON.stringify(Array.from({length:100}, () => ({period:'earlier'})));
  const commitment = hash(salt+'\n'+content);
  await db.query('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [dataset,'owner','Sample','General','Fixture','Fixture','object',commitment,'fp',10000,'research-v1','draft',1,'{}']);
  await storage.put(dataset,{salt,content});
  await installPrivateAggregate(app,{db,storage,authenticated,protectedRuntime:true,
    env:{CONFIDENTIAL_READY:'true',ENABLE_QUERY_PAYMENTS:'true',PLATFORM_WALLET:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',SOLANA_RPC_URL:'https://example.invalid'},
    build:async ({id}) => ({transaction:'fixture',message:id,simulation:true,lastValidBlockHeight:123}),
    verify:async (sig,message) => {
      assert.match(sig,/^(1{88}|2{88})$/);
      assert.match(message,/^[\da-f-]{36}$/);
    }});
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async () => {
    await new Promise(resolve=>server.close(resolve));
    await db.close();
    await rm(dir,{recursive:true,force:true});
  });
  const base = 'http://127.0.0.1:'+server.address().port+'/api/private-aggregates';
  const send = (wallet,path,body) => fetch(base+path,{method:body?'POST':'GET',
    headers:{'content-type':'application/json','x-test-wallet':wallet},body:body&&JSON.stringify(body)});
  const body = {dataset,title:'Count offer',price:10000,specification:{statistic:'count'},consent:true};
  assert.equal((await send('buyer','/offers',body)).status,404);
  const offers = await Promise.all([send('owner','/offers',body),send('owner','/offers',body)]);
  assert.deepEqual(offers.map(res=>res.status),[201,201]);
  assert.equal((await db.one('SELECT count(*) AS n FROM private_aggregate_releases')).n,1);
  assert.equal((await send('owner','/offers',{...body,specification:{statistic:'count',filter:{column:'period',equals:'earlier'}}})).status,429);
  const [{id:offer},{id:relisted}] = await Promise.all(offers.map(res=>res.json()));
  const buy = async (wallet,id) => {
    const request = {requestId:randomUUID(),accept:true};
    const quote = await send(wallet,'/offers/'+id+'/checkout',request);
    assert.equal(quote.status,201);
    const order = await quote.json();
    assert.equal(order.message,undefined);
    assert.equal(order.result,undefined);
    assert.equal((await (await send(wallet,'/offers/'+id+'/checkout',request)).json()).id,order.id);
    assert.equal((await send(wallet,'/orders/'+order.id+'/result')).status,404);
    assert.equal((await send(wallet,'/orders/'+order.id+'/confirm',{signature:(wallet==='buyer'?'1':'2').repeat(88)})).status,200);
    assert.equal((await send('other','/orders/'+order.id+'/result')).status,404);
    return (await (await send(wallet,'/orders/'+order.id+'/result')).json()).result;
  };
  const a = await buy('buyer',offer);
  const b = await buy('buyer2',relisted);
  assert.deepEqual(a,b);
  assert.equal((await send('owner','/offers/'+offer+'/retire',{})).status,200);
  assert.equal((await send('other','/offers/'+offer+'/checkout',{requestId:randomUUID(),accept:true})).status,404);
});
