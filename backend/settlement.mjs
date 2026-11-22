import {address,createNoopSigner,createTransactionMessage,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,appendTransactionMessageInstructions,compileTransaction,getTransactionEncoder,getTransactionDecoder,fillTransactionMessageProvisoryResourceLimits,estimateAndSetResourceLimitsFactory,estimateResourceLimitsFactory,createSolanaRpc} from '@solana/kit';
import {TOKEN_PROGRAM_ADDRESS,findAssociatedTokenPda,getCreateAssociatedTokenIdempotentInstruction,getTransferCheckedInstruction,getBurnCheckedInstruction} from '@solana-program/token';
import {getAddMemoInstruction} from '@solana-program/memo';
import {splitPayment,hash} from './security.mjs';
export const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DATALOOM='8SymmzsWdQBweqCK1p35MGNCwgw8FgPRdL4KPckdata';
export const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export function rpcClient(url){return async(method,params=[])=>{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Solana RPC unavailable');const body=await response.json();if(body.error)throw Error('Solana RPC rejected request: '+String(body.error.message).slice(0,160));return body.result}}
export async function checkMainnet(rpc){if(await rpc('getGenesisHash')!==GENESIS)throw Error('RPC is not Solana mainnet');const mint=await rpc('getAccountInfo',[USDC,{encoding:'jsonParsed',commitment:'confirmed'}]);if(mint?.value?.owner!==TOKEN_PROGRAM_ADDRESS||mint?.value?.data?.parsed?.info?.decimals!==6)throw Error('Invalid mainnet USDC mint');}
export async function buildPayment({buyer,seller,platform,price,id,commitment,license,version=0,rpcUrl,rpcOverride,buybackWallet,bountyOwners,trialContributors,paymentMint=USDC}){
 const rpc=rpcOverride||rpcClient(rpcUrl);await checkMainnet(rpc);const signer=createNoopSigner(address(buyer)),mint=address(paymentMint);
 let amounts;
 let discount=0n,burn=0n;
 if(paymentMint===USDC)amounts=splitPayment(price);
 else{
  if(paymentMint!==DATALOOM||buybackWallet||bountyOwners||trialContributors)throw Error('Unsupported payment asset or split');
  const account=(await rpc('getAccountInfo',[DATALOOM,{encoding:'jsonParsed',commitment:'confirmed'}]))?.value;
  const parsed=account?.data?.parsed;
  if(account?.owner!==TOKEN_PROGRAM_ADDRESS||parsed?.type!=='mint'||parsed.info?.decimals!==6||
   parsed.info.mintAuthority!==null||parsed.info.freezeAuthority!==null)throw Error('Invalid Data Loom mint');
  const total=BigInt(price);
  if(total<10000n||total>1000000000000n)throw Error('Data Loom price out of range');
  const sellerAmount=total*70n/100n;
  discount=total*5n/100n;
  const netFee=total-sellerAmount-discount;
  burn=netFee*15n/100n;
  amounts={seller:sellerAmount,platform:netFee-burn};
 }
 if(buyer===seller)throw Error('You already own this dataset');
 if(buybackWallet){address(buybackWallet);amounts.buyback=BigInt(price)*15n/100n;amounts.platform-=amounts.buyback;}
 const ata=async owner=>(await findAssociatedTokenPda({owner:address(owner),mint,tokenProgram:TOKEN_PROGRAM_ADDRESS}))[0];const source=await ata(buyer);const recipients=new Map();for(const [owner,amount] of [[seller,amounts.seller],[platform,amounts.platform],...(buybackWallet?[[buybackWallet,amounts.buyback]]:[])])recipients.set(owner,(recipients.get(owner)||0n)+amount);
 if(bountyOwners){
   if(bountyOwners.length<1||bountyOwners.length>5||new Set(bountyOwners).size!==bountyOwners.length||bountyOwners.includes(buyer))throw Error('Invalid bounty recipients');
   recipients.clear();
   const count=BigInt(bountyOwners.length);
   for(const [i,owner] of bountyOwners.entries()){
     const share=amounts.seller/count+(BigInt(i)<amounts.seller%count?1n:0n);
     recipients.set(owner,share);
   }
   recipients.set(platform,(recipients.get(platform)||0n)+amounts.platform);
 }
 if(trialContributors){
   const owners=trialContributors.map(entry=>entry.owner);
   if(owners.length<2||owners.length>3||new Set(owners).size!==owners.length||owners.includes(buyer)||bountyOwners||buybackWallet)throw Error('Invalid pool recipients');
   const total=trialContributors.reduce((sum,entry)=>sum+BigInt(entry.amount),0n);
   if(total!==amounts.seller||trialContributors.some(entry=>BigInt(entry.amount)<=0n))throw Error('Pool payouts must match the contributor allocation');
   recipients.clear();
   for(const {owner,amount} of trialContributors)recipients.set(owner,BigInt(amount));
   recipients.set(platform,(recipients.get(platform)||0n)+amounts.platform);
 }
 const instructions=[];for(const [owner,amount]of recipients){const destination=await ata(owner);instructions.push(getCreateAssociatedTokenIdempotentInstruction({payer:signer,ata:destination,owner:address(owner),mint}));instructions.push(getTransferCheckedInstruction({source,mint,destination,authority:signer,amount,decimals:6}));}
 if(burn>0n)instructions.push(getBurnCheckedInstruction({account:source,mint,authority:signer,amount:burn,decimals:6}));
 instructions.push(getAddMemoInstruction({memo:`DataLoom:v1:${id}:${commitment}:${hash(license)}`,signers:[signer]}));
 const block=await rpc('getLatestBlockhash',[{commitment:'confirmed'}]);let message=appendTransactionMessageInstructions(instructions,setTransactionMessageLifetimeUsingBlockhash({...block.value,lastValidBlockHeight:BigInt(block.value.lastValidBlockHeight)},setTransactionMessageFeePayer(address(buyer),createTransactionMessage({version}))));
 if(version===1){const kitRpc=createSolanaRpc(rpcUrl);message=await estimateAndSetResourceLimitsFactory(estimateResourceLimitsFactory({rpc:kitRpc}))(fillTransactionMessageProvisoryResourceLimits(message));}
 const tx=compileTransaction(message),wire=Buffer.from(getTransactionEncoder().encode(tx)).toString('base64');const simulation=await rpc('simulateTransaction',[wire,{encoding:'base64',sigVerify:false,commitment:'confirmed'}]);if(simulation.value.err)throw Error('Simulation failed. Check your mainnet SOL and USDC balances, then retry.');
 const fee=await rpc('getFeeForMessage',[Buffer.from(tx.messageBytes).toString('base64'),{commitment:'confirmed'}]);
 return{quoteSlot:block.context?.slot,lastValidBlockHeight:Number(block.value.lastValidBlockHeight),transaction:wire,message:Buffer.from(tx.messageBytes).toString('base64'),simulation:true,summary:{network:'solana:mainnet',mint:paymentMint,currency:paymentMint===DATALOOM?'DATALOOM':'USDC',feePayer:buyer,price:String(BigInt(price)-discount),...(paymentMint===DATALOOM?{listedPrice:String(price),discountAmount:String(discount),burnAmount:String(burn)}:{}),sellerAmount:String(amounts.seller),platformAmount:String(amounts.platform),seller,platform,...(buybackWallet?{buybackWallet,buybackAmount:String(amounts.buyback),buybackStatus:'Reserved USDC only; no tokens have been bought or burned'}:{}),estimatedNetworkFeeLamports:fee.value==null?null:String(fee.value),note:'Buyer also pays SOL rent for recipient token accounts if they do not exist.'}};
}
export function validatePaymentResult(result,expectedMessage){if(!result||!result.meta||result.meta.err!==null)throw Error('Payment is not finalized successfully');if(!Array.isArray(result.transaction)||result.transaction[1]!=='base64')throw Error('Unexpected transaction encoding');const decoded=getTransactionDecoder().decode(Buffer.from(result.transaction[0],'base64'));if(Buffer.from(decoded.messageBytes).toString('base64')!==expectedMessage)throw Error('Transaction does not match this purchase');return true;}
export async function verifyPayment(signature,message,rpcUrl){const rpc=rpcClient(rpcUrl);await checkMainnet(rpc);const result=await rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:1}]);validatePaymentResult(result,message);return result;}
