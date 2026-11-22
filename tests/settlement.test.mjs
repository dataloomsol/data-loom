import test from 'node:test';import assert from 'node:assert/strict';import {address,blockhash,createTransactionMessage,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,compileTransaction,getTransactionEncoder} from '@solana/kit';import {validatePaymentResult} from '../backend/settlement.mjs';
test('settlement requires exact transaction message and successful execution',()=>{const tx=compileTransaction(setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash('11111111111111111111111111111111'),lastValidBlockHeight:100n},setTransactionMessageFeePayer(address('GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5'),createTransactionMessage({version:0}))));const wire=Buffer.from(getTransactionEncoder().encode(tx)).toString('base64'),message=Buffer.from(tx.messageBytes).toString('base64'),result={meta:{err:null},transaction:[wire,'base64']};assert(validatePaymentResult(result,message));assert.throws(()=>validatePaymentResult(result,'different'));assert.throws(()=>validatePaymentResult({...result,meta:{err:'InsufficientFunds'}},message));assert.throws(()=>validatePaymentResult(null,message));});
import {buildPayment,USDC,GENESIS} from '../backend/settlement.mjs';
import {getTransactionDecoder,getCompiledTransactionMessageDecoder} from '@solana/kit';
test('prepared v0 mainnet purchase simulates before exposing transaction',async()=>{let simulated=false;const result=await buildPayment({buyer:'GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5',seller:'9zzN2FkbG2AwHZCH1cnH6Wxo4V7YzFoKKqJXRvLATohJ',platform:'GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5',price:100000,id:'test-purchase',commitment:'a'.repeat(64),license:'terms',version:0,rpcOverride:async(method)=>{if(method==='getGenesisHash')return GENESIS;if(method==='getAccountInfo')return{value:{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:{parsed:{info:{decimals:6}}}}};if(method==='getLatestBlockhash')return{value:{blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100}};if(method==='simulateTransaction'){simulated=true;return{value:{err:null}}}if(method==='getFeeForMessage')return{value:5000};throw Error(method)}});assert(simulated);assert.equal(result.summary.mint,USDC);assert.equal(result.summary.sellerAmount,'70000');assert.equal(result.summary.platformAmount,'30000');const tx=getTransactionDecoder().decode(Buffer.from(result.transaction,'base64'));const message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);assert.equal(message.instructions.length,5);});
test('optional buyback reserve conserves micro-USDC without claiming a burn',async()=>{const r=await buildPayment({buyer:'GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5',seller:'9zzN2FkbG2AwHZCH1cnH6Wxo4V7YzFoKKqJXRvLATohJ',platform:'GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5',buybackWallet:'9zzN2FkbG2AwHZCH1cnH6Wxo4V7YzFoKKqJXRvLATohJ',price:10001,id:'reserve-test',commitment:'a'.repeat(64),license:'terms',rpcOverride:async m=>{if(m==='getGenesisHash')return GENESIS;if(m==='getAccountInfo')return{value:{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:{parsed:{info:{decimals:6}}}}};if(m==='getLatestBlockhash')return{value:{blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100}};if(m==='simulateTransaction')return{value:{err:null}};if(m==='getFeeForMessage')return{value:5000}}});assert.equal(BigInt(r.summary.sellerAmount)+BigInt(r.summary.platformAmount)+BigInt(r.summary.buybackAmount),10001n);assert.equal(r.summary.buybackAmount,'1500');assert.match(r.summary.buybackStatus,/no tokens/);});
test('bounty transfers conserve an uneven reward across independent recipients',async()=>{
 const buyer='GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5',alice='9zzN2FkbG2AwHZCH1cnH6Wxo4V7YzFoKKqJXRvLATohJ',bob='11111111111111111111111111111111';
 const q=await buildPayment({buyer,seller:alice,platform:buyer,price:10002,bountyOwners:[alice,bob],id:'bounty-test',commitment:'a'.repeat(64),license:'terms',rpcOverride:async m=>{
  if(m==='getGenesisHash')return GENESIS;
  if(m==='getAccountInfo')return{value:{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:{parsed:{info:{decimals:6}}}}};
  if(m==='getLatestBlockhash')return{context:{slot:20},value:{blockhash:bob,lastValidBlockHeight:100}};
  if(m==='simulateTransaction')return{value:{err:null}};
  if(m==='getFeeForMessage')return{value:5000};
 }});
 const wire=getTransactionDecoder().decode(Buffer.from(q.transaction,'base64'));const compiled=getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
 const amounts=compiled.instructions.filter(i=>i.data?.length===10&&i.data[0]===12).map(i=>Buffer.from(i.data).readBigUInt64LE(1));
 assert.deepEqual(amounts,[3501n,3500n,3001n]);
});

test('pool checkout includes every weighted USDC transfer in one simulated transaction',async()=>{
 const buyer='GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5';
 const alice='9zzN2FkbG2AwHZCH1cnH6Wxo4V7YzFoKKqJXRvLATohJ',bob='11111111111111111111111111111111';
 let simulated=false;
 const request={buyer,seller:alice,platform:buyer,price:200002,id:'pool-test',commitment:'a'.repeat(64),license:'pool terms',
  trialContributors:[{owner:alice,amount:'46667'},{owner:bob,amount:'93334'}],
  rpcOverride:async method=>{
   if(method==='getGenesisHash')return GENESIS;
   if(method==='getAccountInfo')return {value:{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:{parsed:{info:{decimals:6}}}}};
   if(method==='getLatestBlockhash')return {context:{slot:20},value:{blockhash:bob,lastValidBlockHeight:100}};
   if(method==='simulateTransaction'){simulated=true;return {value:{err:null}}}
   if(method==='getFeeForMessage')return {value:5000};
   throw Error(method);
  }};
 const quote=await buildPayment(request);
 const transaction=getTransactionDecoder().decode(Buffer.from(quote.transaction,'base64'));
 const message=getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
 const amounts=message.instructions.filter(i=>i.data?.length===10&&i.data[0]===12)
  .map(i=>Buffer.from(i.data).readBigUInt64LE(1));
 assert(simulated);
 assert.deepEqual(amounts,[46667n,93334n,60001n]);
 await assert.rejects(buildPayment({...request,trialContributors:[{owner:alice,amount:'1'},{owner:bob,amount:'1'}]}),/must match/);
});

test('Data Loom checkout pins the mint and transfers the exact 70/30 split',async()=>{
 const {DATALOOM}=await import('../backend/settlement.mjs');
 const buyer='GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5',seller='9zzN2FkbG2AwHZCH1cnH6Wxo4V7YzFoKKqJXRvLATohJ';
 let freezeAuthority=null;
 const input={buyer,seller,platform:'11111111111111111111111111111111',paymentMint:DATALOOM,price:100000001,id:'query-token',commitment:'a'.repeat(64),license:'terms',
  rpcOverride:async (method,params)=>{
   if(method==='getGenesisHash')return GENESIS;
   if(method==='getAccountInfo')return {value:{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:{parsed:{type:'mint',info:{decimals:6,mintAuthority:null,freezeAuthority:params[0]===DATALOOM?freezeAuthority:null}}}}};
   if(method==='getLatestBlockhash')return {context:{slot:20},value:{blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100}};
   if(method==='simulateTransaction')return {value:{err:null}};
   if(method==='getFeeForMessage')return {value:5000};
   throw Error(method);
  }};
 const quote=await buildPayment(input);
 assert.equal(quote.summary.currency,'DATALOOM');
 assert.equal(quote.summary.mint,DATALOOM);
 const transaction=getTransactionDecoder().decode(Buffer.from(quote.transaction,'base64'));
 const message=getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
 const transfers=message.instructions.filter(i=>i.data?.length===10&&i.data[0]===12);
 assert.deepEqual(transfers.map(i=>Buffer.from(i.data).readBigUInt64LE(1)),[70000000n,16000001n]);
 for(const transfer of transfers)assert.equal(message.staticAccounts[transfer.accountIndices[1]],DATALOOM);
 const burn=message.instructions.find(i=>i.data?.length===10&&i.data[0]===15);
 assert.equal(Buffer.from(burn.data).readBigUInt64LE(1),4000000n);
 assert.equal(message.staticAccounts[burn.accountIndices[1]],DATALOOM);
 assert.equal(quote.summary.price,'90000001');
 assert.equal(quote.summary.discountAmount,'10000000');
 freezeAuthority=seller;
 await assert.rejects(buildPayment(input),/Invalid Data Loom mint/);
});
