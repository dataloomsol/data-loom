import {spawn} from 'node:child_process';

const pin=process.env.PHALA_ACCEPT_COMPOSE;
const proxyEnv={...process.env,PHALA_PROXY_URL:'http://127.0.0.1:4180/v1',PHALA_PROXY_CONTROL_URL:'http://127.0.0.1:4183'};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let app,proxy,verified=false,stopping=false;
function stop(){
 stopping=true;
 app?.kill('SIGTERM');
 proxy?.kill('SIGTERM');
}
process.on('SIGTERM',stop);
process.on('SIGINT',stop);

function startApp(extra){
 const child=spawn(process.execPath,['server.mjs'],{stdio:'inherit',env:{...proxyEnv,PRIVATE_ROUTER_MODELS_READY:'false',...extra}});
 child.on('exit',code=>{if(app===child){proxy?.kill('SIGTERM');process.exit(stopping?0:code??1)}});
 app=child;
}
startApp({CONFIDENTIAL_APPROVED_COMPOSE:'',PHALA_STARTUP_RECEIPT:'',BLIND_TRIALS_MODELS_READY:'false'});

async function waitForProxy(){
 if(!/^(0x)?[a-f0-9]{64}$/i.test(pin||'')||!process.env.PHALA_AI_API_KEY){
  console.error('Confidential inference awaits reviewed gateway configuration');
  return false;
 }
 while(!stopping){
  proxy=spawn(process.execPath,['deploy/pap/node_modules/private-ai-proxy/bin/private-ai-proxy.cjs','serve','https://inference.phala.com','--listen','127.0.0.1:4180','--control','127.0.0.1:4183','--accept-compose',pin,'--accept-subject','app-id:0x89c51ab856bee41efe78c40309a4deb277a02a0f','--accept-dstack-kms-root-public-key','02a335aea3df11d46ae0a373d3f26fbd1d208572ecc87e630e618dac693b7af721','--require-claim','tee_attested=hardware_proven','--require-claim','tcb_up_to_date=hardware_proven','--require-claim','gpu_attested=verifier_derived','--require-claim','os_known_good=verifier_derived','--json-events'],{stdio:['ignore','pipe','pipe'],env:process.env});
  const child=proxy;
  let exited=false;
  child.stdout.resume();
  child.stderr.resume();
  child.on('exit',()=>{
   exited=true;
   if(verified&&!stopping){app?.kill('SIGTERM');process.exit(1);}
  });
  child.on('error',()=>{exited=true;});
  const deadline=Date.now()+300000;
  while(!exited&&!stopping&&Date.now()<deadline){
   try{
    const response=await fetch('http://127.0.0.1:4183/receipts',{signal:AbortSignal.timeout(1000)});
    if(response.ok){await response.body?.cancel();verified=true;return true;}
   }catch{}
   await delay(1000);
  }
  child.kill('SIGTERM');
  if(!stopping){
   console.error('Confidential inference proxy unavailable. Marketplace stays online.');
   await delay(30000);
  }
 }
 return false;
}

if(await waitForProxy()){
 const {phalaAnswer}=await import('../backend/phala-inference.mjs');
let startupReceipt;
for(;;){
 try{
  const health=await phalaAnswer({question:'What fraction of the synthetic checks passed? Answer briefly.',content:'This is synthetic deployment verification data. A fictional test suite performed twenty checks. Fifteen passed and five failed. These values are not customer records.',env:proxyEnv});
  console.log('Protected inference startup verification passed:',health.evidence.receiptId);
  const previous=app;app=null;
  await new Promise(resolve=>{previous.once('exit',resolve);previous.kill('SIGTERM')});
  startupReceipt=health.evidence.receiptId;startApp({PHALA_STARTUP_RECEIPT:startupReceipt});break;
 }catch(error){
  const code=/^PHALA_HTTP_[0-9]{3}$/.test(error?.code||'')?error.code:'PHALA_VERIFICATION_UNAVAILABLE';
  console.error('Protected inference check unavailable:',code,'; confidential queries stay disabled. Retrying.');
  await new Promise(r=>setTimeout(r,30000));
 }
}

// Trials are independently enabled only after both advertised models pass fresh receipts.
const {phalaTrial}=await import('../backend/phala-inference.mjs');
const {TRIAL_MODELS,routerModels}=await import('../backend/blind-trials.mjs');
for(;;){try{
 for(const model of TRIAL_MODELS)await phalaTrial({prompt:'Synthetic deployment check: What is two plus two? Answer with a number only.',model,env:proxyEnv});
 const previous=app;app=null;await new Promise(resolve=>{previous.once('exit',resolve);previous.kill('SIGTERM')});
 startApp({PHALA_STARTUP_RECEIPT:process.env.PHALA_STARTUP_RECEIPT||startupReceipt,BLIND_TRIALS_MODELS_READY:'true'});break;
}catch{console.error('Blind trial model verification pending; ordinary verified queries remain available.');await new Promise(r=>setTimeout(r,30000))}}

// A third model gets its own fresh receipt without gating ordinary trials.
const models=routerModels(proxyEnv);
while(models.length&&!stopping){
 try{
  await phalaTrial({prompt:'Synthetic router check: What is two plus two? Answer with a number only.',model:models[2],env:proxyEnv});
 }catch{
  console.error('Private Model Router model verification pending.');
  await delay(30000);
  continue;
 }
 if(stopping)break;
 const previous=app;app=null;
 await new Promise(resolve=>{previous.once('exit',resolve);previous.kill('SIGTERM')});
 if(!stopping)startApp({PHALA_STARTUP_RECEIPT:startupReceipt,BLIND_TRIALS_MODELS_READY:'true',PRIVATE_ROUTER_MODELS_READY:'true'});
 break;
}

}
