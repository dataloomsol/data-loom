import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDb} from '../backend/db.mjs';
import {installProofCards} from '../backend/proof-cards.mjs';
test('paid card sharing is buyer-controlled, revocable, and uses historical receipt evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'loom-card-')),db=await openDb({DATA_DIR:dir});
 const id=randomUUID(),privateText='ANSWER <script>alert(1)</script>';
 await db.query('CREATE TABLE query_orders (id TEXT PRIMARY KEY,buyer TEXT,state TEXT,signature TEXT,dataset TEXT,commitment TEXT,answer_object TEXT)');
 await db.query('CREATE TABLE query_receipts(order_id TEXT,terms TEXT)');
 await db.query('INSERT INTO query_orders VALUES(?,?,?,?,?,?,?)',[id,'buyer','prepared',null,'dataset-version','digest','object']);
 await db.query('INSERT INTO query_receipts VALUES(?,?)',[id,'Permission for one generated answer']);
 const checks=['receipt-1','receipt-2','receipt-3','receipt-4','upstream-1','upstream-2'].map(id=>({id,status:'pass'}));
 const evidence={provider:'phala',receiptId:'rcpt-example',verifiedAt:'2026-11-04',checks};
 const app=express();app.use(express.json());await installProofCards(app,{db,storage:{get:async()=>({answer:privateText,evidence})},authenticated:(q,r,n)=>{q.wallet=q.headers.wallet;q.wallet?n():r.sendStatus(401)}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const path='/api/query-orders/'+id+'/proof-card';const manage=(wallet,method='GET',value=false)=>fetch(base+path,{method,headers:{wallet,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify({includeAnswer:value})}:{})});
 try{
  assert.equal((await manage('buyer','POST')).status,404);
  await db.query("UPDATE query_orders SET state='answered',signature='sig'");
  assert.equal((await manage('other','POST')).status,404);assert.equal((await(await manage('buyer')).json()).path,null);
  const card=await(await manage('buyer','POST')).json();const read=()=>fetch(base+card.path);
  const response=await read();assert.match(response.headers.get('cache-control'),/no-store/);const html=await response.text();
  for(const x of ['digest','dataset-version','Permission for one generated answer','rcpt-example'])assert(html.includes(x));assert(!html.includes('ANSWER &lt;script'));
  await manage('buyer','POST',true);assert.match(await(await read()).text(),/ANSWER &lt;script&gt;/);
  checks[5].status='skip';assert.match(await(await read()).text(),/No verified inference receipt/);
  await manage('buyer','POST',false);assert(!(await(await read()).text()).includes('ANSWER &lt;script'));
  await manage('buyer','DELETE');assert.equal((await read()).status,404);assert.notEqual((await(await manage('buyer','POST')).json()).path,card.path);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await rm(dir,{recursive:true,force:true});}
});
