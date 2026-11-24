import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {test} from 'node:test';
import express from 'express';
import {hash} from '../backend/security.mjs';
import {installPrivateValidation,validatePrivateRows} from '../backend/private-validation.mjs';

test('validation requires scalar fields and valid inclusive dates in every row', () => {
  const required={type:'required-field',field:'value'};
  assert.equal(validatePrivateRows([{value:false},{value:0},{value:'  valid  '}],required),true);
  for (const rows of [[],[{}],[{value:null}],[{value:' '}],[{value:[]}],[{value:{}}]]) {
    assert.equal(validatePrivateRows(rows,required),false);
  }
  const range={type:'date-range',field:'value',from:'2024-02-01',to:'2024-02-29'};
  assert.equal(validatePrivateRows([{value:'2024-02-01'},{value:'2024-02-29'}],range),true);
  for (const value of ['2024-02-30','2024-02-01T00:00:00Z','2024-03-01',null]) {
    assert.equal(validatePrivateRows([{value}],range),false);
  }
});

test('owner-only validation binds a source-free report to the quote and checks for revocation',async t=>{
  const app=express();
  app.use(express.json());
  const dataset=randomUUID(),salt='test',content='[{"purchaseOrder":"private-order-42"}]';
  const commitment=hash(salt+'\n'+content);
  let paused=false,corrupt=false,revokeDuringQuote=false,reads=0;
  installPrivateValidation(app,{
    env:{CONFIDENTIAL_RUNTIME:'phala',CONFIDENTIAL_READY:'true'},
    authenticated:(req,res,next)=>{req.wallet=req.get('x-wallet');if(!req.wallet)return res.sendStatus(401);next();},
    db:{one:async(_,[id,owner])=>!paused&&id===dataset&&owner==='owner'?{id,commitment}:null},
    storage:{get:async()=>{reads++;return {salt,content:corrupt?'[]':content};}},
    attestationClient:{getQuote:async buffer=>{
      if(revokeDuringQuote) paused=true;
      return {quote:buffer.toString('hex')};
    }}
  });
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const path='http://127.0.0.1:'+server.address().port+'/api/my/private-validation';
  const send=wallet=>fetch(path,{method:'POST',headers:{'content-type':'application/json',...(wallet&&{'x-wallet':wallet})},
    body:JSON.stringify({dataset,rule:{type:'required-field',field:'purchaseOrder'},nonce:'a'.repeat(64),consent:true})});
  assert.equal((await send(null)).status,401);
  assert.equal((await send('other')).status,404);
  assert.equal(reads,0);
  const response=await send('owner');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const document=await response.json();
  assert.equal(document.report.sourceCommitment,commitment);
  assert.equal(document.report.passed,true);
  assert.equal(document.attestation.quote.quote,hash(JSON.stringify(document.report)));
  assert.doesNotMatch(JSON.stringify(document),/private-order-42/);
  corrupt=true;
  assert.equal((await send('owner')).status,409);
  corrupt=false;
  revokeDuringQuote=true;
  assert.equal((await send('owner')).status,409);
});
