import {inferDecision,validateInput} from './agent-tools.mjs';
import {allocatePoolPayouts,installPoolTables,POOL_TERMS} from './benchmark-pools.mjs';
import {installReleaseGates, releaseGateSchema} from './release-gates.mjs';
import {installRegressionWatch} from './regression-watch.mjs';
import {isPaused,unpaused} from './consent-ledger.mjs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash,validWallet} from './security.mjs';
import {phalaTrial,validatePhalaReceipt} from './phala-inference.mjs';
import {buildPayment,verifyPayment,rpcClient} from './settlement.mjs';
export const TRIAL_MODELS=['qwen/qwen3.8-27b','qwen/qwen-2.5-7b-instruct'];
const ROUTER_TERMS='Private Model Router v1. Three verified models evaluate one private benchmark. Aggregate scores and recommendations use buyer-supplied cost estimates. 70% of USDC pays the contributor and 30% pays Data Loom.';
export const routerModels=env=>{
 const third=env.PRIVATE_ROUTER_THIRD_MODEL?.trim();
 return third&&!TRIAL_MODELS.includes(third)?[...TRIAL_MODELS,third]:[];
};
const routerSchema=z.object({
 minimumAccuracy:z.number().int().min(1).max(100),
 costPerThousandMicros:z.array(z.number().int().positive().max(1e9)).length(3)
}).strict();
function recommendModels(results,{minimumAccuracy,costPerThousandMicros}){
 return {minimumAccuracy,rates:results.map(({model},index)=>({model,cost:costPerThousandMicros[index]})),
  categories:Object.keys(results[0].categories).map(category=>{
   const passing=results.map(({model,categories},index)=>({model,...categories[category],cost:costPerThousandMicros[index]}))
    .filter(score=>100*score.correct>=minimumAccuracy*score.total)
    .sort((a,b)=>a.cost-b.cost||b.correct-a.correct||a.model.localeCompare(b.model));
   return {category,recommendation:passing[0]??null};
  })};
}
export const TRIAL_TERMS='Blind Model Trials v1. One aggregate benchmark scorecard, scored by Unicode-normalized, case-insensitive exact answer match with collapsed whitespace. No case prompts, reference answers, individual model outputs, download or training rights. Each model receives prompts, never reference answers. Verified Phala inference receipts are required for every response. 70% of USDC pays the contributor; 30% pays Data Loom. Results are a single run, not a guarantee of model quality. Already prepared purchases remain payable after an offer is disabled.';
export const IMPACT_TERMS='Data Impact Trials v1. One aggregate scorecard comparing the same model with and without an approved private tool. The tool receives only the typed case inputs, and the assisted model receives only its decision. 70% of USDC pays the contributor and 30% pays Data Loom. Case inputs, reference answers, tool source files, and individual outputs are excluded from the scorecard.';
const uuid=z.string().uuid();
const casesSchema=z.array(z.object({prompt:z.string().trim().min(3).max(2000),expectedAnswer:z.string().trim().min(1).max(500),category:z.string().trim().min(2).max(40).default('General'),toolInput:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()])).optional()}).strict()).min(5).max(20);
export function parseBenchmark(content){
 let value;try{value=JSON.parse(content)}catch{throw Error('Benchmark must be a JSON array of 5–20 cases with prompt, expectedAnswer and optional category')}
 const cases=casesSchema.parse(value),groups=new Map();for(const c of cases)groups.set(c.category,(groups.get(c.category)||0)+1);
 if([...groups.values()].some(n=>n<5))throw Error('Every public category must contain at least five cases');
 return cases;
}
export const normalizeAnswer=s=>s.normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/gu,' ');
export function overlapBands(baseline,candidate){
 const group=cases=>{
  const categories=new Map();
  for(const {category,prompt} of cases){
   if(!categories.has(category))categories.set(category,new Set());
   categories.get(category).add(normalizeAnswer(prompt));
  }
  return categories;
 };
 const base=group(baseline);
 const results=[];
 for(const [category,prompts] of group(candidate)){
  const previous=base.get(category);
  if(prompts.size<10||!previous||previous.size<10)continue;
  const share=[...prompts].filter(prompt=>previous.has(prompt)).length/prompts.size;
  results.push({category,band:share<0.25?'0–24%':share<0.5?'25–49%':share<0.75?'50–74%':'75–100%'});
 }
 return results;
}
function checkTrialReceipt(evidence){
 if(evidence?.provider!=='phala'||!evidence.receiptId||!evidence.verifiedAt)throw Error('Trial inference receipt missing');
 validatePhalaReceipt({receipt_id:evidence.receiptId,verdict:{verified:true},checks:evidence.checks},evidence.receiptId);
}
export async function evaluateBenchmark({cases,models,env,infer=phalaTrial,beforeCase,impact,router}){
 const results=[];
 for(const [index,model] of models.entries()){
  let correct=0,totalMs=0;
  const categories=Object.create(null),receipts=[],toolReceipts=[];
  for(const c of cases){if(beforeCase)await beforeCase(c);const start=Date.now();
   let tool;
   if(impact&&index===1){
    tool=await impact.invoke(c);
    checkTrialReceipt(tool.evidence);
    toolReceipts.push(tool.evidence);
    if(beforeCase)await beforeCase(c);
   }
   const r=await infer({prompt:c.prompt,model,env,...(tool?{toolDecision:tool.output.decision}:{})});
   // Do not allow an adapter to silently return conventional or unverified output.
   checkTrialReceipt(r.evidence);
   const ok=normalizeAnswer(r.answer)===normalizeAnswer(c.expectedAnswer);correct+=Number(ok);totalMs+=Date.now()-start;
   const group=categories[c.category]??={total:0,correct:0};group.total++;group.correct+=Number(ok);receipts.push(r.evidence);
  }
  results.push({model,total:cases.length,correct,accuracy:correct/cases.length,averageLatencyMs:Math.round(totalMs/cases.length),categories,receipts,...(impact?{condition:index===0?'baseline':'assisted',toolReceipts}:{})});
 }
 const [baseline,assisted]=results;
 const comparison=impact?{tool:impact.tool,toolCommitment:impact.toolCommitment,toolCost:String(impact.toolCost),accuracyDelta:assisted.accuracy-baseline.accuracy,
  categoryDeltas:Object.fromEntries(Object.entries(baseline.categories).map(([name,group])=>[name,(assisted.categories[name].correct-group.correct)/group.total]))}:null;
 const best=Math.max(...results.map(result=>result.correct));
 const winners=results.filter(result=>result.correct===best);
 return {scoring:'normalized-exact-match-v1',...(comparison?{impact:comparison}:{}),...(router?{router:recommendModels(results,router)}:{}),created:new Date().toISOString(),models:results,winner:winners.length===1?winners[0].condition||winners[0].model:'tie',note:'Aggregate results only. Prompt/answer pairs and individual outputs are never included. Latency includes receipt verification. A scorecard can reveal statistical information; it is not a formal non-extraction guarantee.'};
}
export async function installBlindTrials(app,{db,storage,env,authenticated,build=buildPayment,verify=verifyPayment,infer=phalaTrial,runTool=inferDecision}){
 await db.query('CREATE TABLE IF NOT EXISTS trial_policies(dataset TEXT PRIMARY KEY,owner TEXT NOT NULL,price BIGINT NOT NULL,enabled INTEGER NOT NULL,cases INTEGER NOT NULL,categories TEXT NOT NULL,consented BIGINT NOT NULL)');
 await db.query('CREATE TABLE IF NOT EXISTS trial_quota(slot TEXT PRIMARY KEY,created BIGINT NOT NULL)');
 await db.query('CREATE TABLE IF NOT EXISTS trial_orders(id TEXT PRIMARY KEY,buyer TEXT NOT NULL,dataset TEXT NOT NULL,owner TEXT NOT NULL,price BIGINT NOT NULL,commitment TEXT NOT NULL,models TEXT NOT NULL,terms TEXT NOT NULL,summary TEXT NOT NULL,message TEXT NOT NULL,tx TEXT NOT NULL,quote TEXT NOT NULL,state TEXT NOT NULL,signature TEXT UNIQUE,created BIGINT NOT NULL,expires BIGINT NOT NULL)');
 await db.query('CREATE TABLE IF NOT EXISTS trial_jobs(id TEXT PRIMARY KEY,buyer TEXT NOT NULL,state TEXT NOT NULL,created BIGINT NOT NULL)');
 await db.query("UPDATE trial_jobs SET state='failed' WHERE state='running'");
 await installPoolTables(db);
 await db.query('CREATE TABLE IF NOT EXISTS trial_impact_tools(dataset TEXT PRIMARY KEY,tool TEXT NOT NULL,unit_price BIGINT NOT NULL,consented BIGINT NOT NULL)');
 const availableTool=`SELECT t.* FROM agent_tools t JOIN datasets d ON d.id=t.dataset
  WHERE t.id=? AND t.owner=? AND d.owner=t.owner AND d.commitment=t.commitment AND d.state<>'published'
  AND ${unpaused} AND NOT EXISTS (SELECT 1 FROM trial_policies tp WHERE tp.dataset=d.id AND tp.enabled=1)`;
 const impactGuard=`EXISTS (SELECT 1 FROM trial_impact_tools it JOIN trial_policies p ON p.dataset=it.dataset AND p.consented=it.consented
  JOIN datasets b ON b.id=it.dataset
  WHERE it.dataset=? AND it.tool=? AND it.consented=? AND p.enabled=1 AND p.price=? AND b.commitment=?
  AND NOT EXISTS (SELECT 1 FROM consent_state cs WHERE cs.dataset=b.id AND cs.paused=1))
  AND EXISTS (${availableTool} AND t.commitment=? AND t.price=?)`;
 const enabled=env.BLIND_TRIALS_MODELS_READY==='true'&&env.CONFIDENTIAL_READY==='true'&&env.CONFIDENTIAL_RUNTIME==='phala'&&env.ENABLE_QUERY_PAYMENTS==='true'&&!!env.PHALA_AI_API_KEY&&!!env.SOLANA_RPC_URL&&validWallet(env.PLATFORM_WALLET||'');
 const routingModels=enabled&&env.PRIVATE_ROUTER_MODELS_READY==='true'?routerModels(env):[];
 const overlapReady=env.CONFIDENTIAL_READY==='true'&&env.CONFIDENTIAL_RUNTIME==='phala';
 await db.query('CREATE TABLE IF NOT EXISTS trial_overlap_permissions(dataset TEXT PRIMARY KEY, consented BIGINT NOT NULL)');
 await db.query('CREATE TABLE IF NOT EXISTS trial_overlap_usage(buyer TEXT NOT NULL, candidate TEXT NOT NULL, PRIMARY KEY(buyer,candidate))');
 app.get('/api/my/overlap-options',authenticated,async(req,res)=>{
  const {rows:baseline}=await db.query(`SELECT DISTINCT d.id,d.title FROM datasets d JOIN trial_orders o ON o.dataset=d.id
   JOIN trial_policies p ON p.dataset=d.id JOIN trial_overlap_permissions op ON op.dataset=d.id AND op.consented=p.consented
   WHERE o.buyer=? AND o.state='paid' AND o.commitment=d.commitment AND p.enabled=1 AND d.state<>'published' AND ${unpaused}`,[req.wallet]);
  const {rows:candidates}=await db.query(`SELECT d.id,d.title FROM datasets d JOIN trial_policies p ON p.dataset=d.id
   JOIN trial_overlap_permissions op ON op.dataset=d.id AND op.consented=p.consented
   WHERE p.enabled=1 AND d.state<>'published' AND ${unpaused}`);
  res.json({enabled:overlapReady,baseline,candidates});
 });
 app.post('/api/my/overlap-check',authenticated,async(req,res)=>{
  if(!overlapReady)return res.status(503).json({error:'Confidential compute is unavailable'});
  const {baseline,candidate}=z.object({baseline:uuid,candidate:uuid}).strict().parse(req.body);
  if(baseline===candidate)return res.status(400).json({error:'Choose two different benchmark versions'});
  const access=()=>db.one(`SELECT b.commitment AS baseline_commitment,d.commitment AS candidate_commitment,p.consented,bp.consented AS baseline_consented
   FROM datasets d JOIN trial_policies p ON p.dataset=d.id
   JOIN trial_overlap_permissions op ON op.dataset=d.id AND op.consented=p.consented
   JOIN datasets b ON b.id=? JOIN trial_policies bp ON bp.dataset=b.id
   JOIN trial_overlap_permissions bop ON bop.dataset=b.id AND bop.consented=bp.consented
   WHERE d.id=? AND bp.enabled=1 AND p.enabled=1 AND d.state<>'published' AND b.state<>'published' AND ${unpaused}
   AND NOT EXISTS (SELECT 1 FROM consent_state cs WHERE cs.dataset=b.id AND cs.paused=1)
   AND EXISTS (SELECT 1 FROM trial_orders o WHERE o.dataset=b.id AND o.commitment=b.commitment AND o.state='paid' AND o.buyer=?)`,
   [baseline,candidate,req.wallet]);
  const versions=await access();
  if(!versions)return res.status(404).json({error:'An eligible paid baseline and an opted-in candidate are required'});
  const [base,next]=await Promise.all([baseline,candidate].map(async id=>parseBenchmark((await storage.get(id)).content)));
  const categories=overlapBands(base,next);
  if(!categories.length)return res.status(409).json({error:'No shared category has at least ten distinct prompts in both benchmarks'});
  const reserved=await db.query('INSERT INTO trial_overlap_usage(buyer,candidate) VALUES(?,?) ON CONFLICT(buyer,candidate) DO NOTHING RETURNING candidate',[req.wallet,candidate]);
  if(!reserved.rows.length)return res.status(409).json({error:'This wallet already checked this candidate version'});
  const current=await access();
  if(!current||Object.keys(versions).some(key=>current[key]!==versions[key])){
   await db.query('DELETE FROM trial_overlap_usage WHERE buyer=? AND candidate=?',[req.wallet,candidate]);
   return res.status(409).json({error:'Benchmark permissions changed'});
  }
  res.json({baselineCommitment:versions.baseline_commitment,candidateCommitment:versions.candidate_commitment,categories});
 });
 const gates=await installReleaseGates(app,{db,env});
 const active=new Set();
 const info=o=>({id:o.id,dataset:o.dataset,pooled:o.dataset===o.id,impact:o.terms===IMPACT_TERMS,router:o.terms===ROUTER_TERMS,price:String(o.price),models:JSON.parse(o.models),state:o.state,signature:o.signature,created:Number(o.created),expires:Number(o.expires)});
 const result=async o=>{
  const scorecard=await storage.get(o.id);
  return {...info(o),sourceCommitment:o.commitment,scorecard,terms:o.terms,
   summary:JSON.parse(o.summary),releaseGate:await gates.receipt(o,scorecard)};
 };
 app.get('/api/blind-trials',async(req,res)=>res.json({enabled,releaseGates:gates.available,models:TRIAL_MODELS,routerModels:routingModels,impactTerms:IMPACT_TERMS,terms:TRIAL_TERMS,poolTerms:POOL_TERMS,offers:(await db.query(`SELECT d.id,d.title,d.preview,d.commitment,p.owner,p.price,p.cases,p.categories,it.tool AS impact_tool,it.unit_price AS impact_unit_price,CASE WHEN po.dataset IS NULL THEN 0 ELSE 1 END AS pooled FROM datasets d JOIN trial_policies p ON p.dataset=d.id LEFT JOIN trial_pool_opt_ins po ON po.dataset=d.id AND po.consented=p.consented LEFT JOIN trial_impact_tools it ON it.dataset=p.dataset AND it.consented=p.consented WHERE p.enabled=1 AND ${unpaused} ORDER BY p.consented DESC LIMIT 100`)).rows.map(o=>({...o,price:String(o.price),impact_unit_price:o.impact_unit_price==null?null:String(o.impact_unit_price),categories:JSON.parse(o.categories)})),blockers:enabled?[]:['Verified confidential inference and mainnet query payments must be ready.']}));
 app.post('/api/datasets/:id/trial-policy',authenticated,async(req,res)=>{
  const id=uuid.parse(req.params.id),body=z.object({enabled:z.boolean(),price:z.number().int().min(10000).max(1000000000),consent:z.literal(true),pool:z.boolean().default(false),overlap:z.boolean().optional(),impactTool:uuid.optional()}).parse(req.body);
  const d=await db.one('SELECT * FROM datasets WHERE id=? AND owner=?',[id,req.wallet]);if(!d)return res.status(404).json({error:'Dataset not found'});
  if(!body.enabled){await db.query('UPDATE trial_policies SET enabled=0 WHERE dataset=? AND owner=?',[id,req.wallet]);await db.query('DELETE FROM trial_pool_opt_ins WHERE dataset=?',[id]);await db.query('INSERT INTO audit(id,wallet,action,resource,created) VALUES(?,?,?,?,?)',[randomUUID(),req.wallet,'trial-disabled',id,Date.now()]);return res.json({ok:true})}
  if(d.state==='published')return res.status(409).json({error:'Unpublish the file-download listing first. A blind benchmark must not also sell its answer key.'});
  const qp=await db.one('SELECT enabled FROM query_policies WHERE dataset=?',[id]);if(qp?.enabled)return res.status(409).json({error:'Disable ordinary answer access before enabling this blind benchmark'});
  const cases=parseBenchmark((await storage.get(id)).content),categories=[...new Set(cases.map(c=>c.category))];
  let tool;
  if(body.impactTool){
   tool=await db.one(availableTool,[body.impactTool,req.wallet]);
   if(!tool||tool.dataset===id)return res.status(409).json({error:'Choose your own private tool on a separate dataset'});
   try{for(const item of cases)validateInput(JSON.parse(tool.fields),item.toolInput)}
   catch{return res.status(400).json({error:'Every benchmark case needs toolInput matching the selected tool schema'})}
  }
  const consented=Date.now();
  await db.query('INSERT INTO trial_policies(dataset,owner,price,enabled,cases,categories,consented) VALUES(?,?,?,?,?,?,?) ON CONFLICT(dataset) DO UPDATE SET price=excluded.price,enabled=excluded.enabled,cases=excluded.cases,categories=excluded.categories,consented=excluded.consented',[id,req.wallet,body.price,1,cases.length,JSON.stringify(categories),consented]);if(body.pool)await db.query('INSERT INTO trial_pool_opt_ins(dataset,consented) VALUES(?,?) ON CONFLICT(dataset) DO UPDATE SET consented=excluded.consented',[id,consented]);
  else await db.query('DELETE FROM trial_pool_opt_ins WHERE dataset=?',[id]);
  if(body.overlap)await db.query('INSERT INTO trial_overlap_permissions(dataset,consented) VALUES(?,?) ON CONFLICT(dataset) DO UPDATE SET consented=excluded.consented WHERE trial_overlap_permissions.consented<=excluded.consented',[id,consented]);
  if(tool)await db.query('INSERT INTO trial_impact_tools(dataset,tool,unit_price,consented) VALUES(?,?,?,?) ON CONFLICT(dataset) DO UPDATE SET tool=excluded.tool,unit_price=excluded.unit_price,consented=excluded.consented',[id,tool.id,tool.price,consented]);
  else await db.query('DELETE FROM trial_impact_tools WHERE dataset=? AND NOT EXISTS (SELECT 1 FROM trial_policies p WHERE p.dataset=? AND p.consented<>?)',[id,id,consented]);
  await db.query('INSERT INTO audit(id,wallet,action,resource,created) VALUES(?,?,?,?,?)',[randomUUID(),req.wallet,'trial-enabled',id,Date.now()]);res.json({ok:true,cases:cases.length,categories});
 });
 app.get('/api/my/trial-policies',authenticated,async(req,res)=>res.json((await db.query('SELECT p.dataset,p.price,p.enabled,p.cases,p.categories,it.tool AS impact_tool,CASE WHEN op.dataset IS NULL THEN 0 ELSE 1 END AS overlap,CASE WHEN po.dataset IS NULL THEN 0 ELSE 1 END AS pooled FROM trial_policies p LEFT JOIN trial_overlap_permissions op ON op.dataset=p.dataset AND op.consented=p.consented LEFT JOIN trial_pool_opt_ins po ON po.dataset=p.dataset AND po.consented=p.consented LEFT JOIN trial_impact_tools it ON it.dataset=p.dataset AND it.consented=p.consented WHERE p.owner=?',[req.wallet])).rows.map(o=>({...o,price:String(o.price),categories:JSON.parse(o.categories)}))));
 const prepareTrial=async(wallet,input,watchGuard)=>{
  const respond=(status,data)=>({status,data});
  if(!enabled)return respond(503,{error:'Verified confidential trials are not ready'});
  const body=z.object({dataset:uuid.optional(),datasets:z.array(uuid).min(2).max(3).optional(),models:z.array(z.string().max(200)).min(2).max(3),router:routerSchema.optional(),impact:z.boolean().default(false),consent:z.literal(true),version:z.union([z.literal(0),z.literal(1)]).default(0),releaseGate:releaseGateSchema.optional()}).strict().parse(input);
  if(body.router){
   if(!routingModels.length)return respond(503,{error:'Three verified router models are required'});
   if(body.datasets||body.impact||body.releaseGate||watchGuard||body.models.length!==3||
    new Set(body.models).size!==3||body.models.some(model=>!routingModels.includes(model)))
    return respond(400,{error:'Use all three verified router models and one private benchmark'});
  }else if(body.models.length!==2||body.models.some(model=>!TRIAL_MODELS.includes(model))){
   return respond(400,{error:'Choose two supported trial models'});
  }
  if(!body.router&&new Set(body.models).size!==(body.impact?1:2))return respond(400,{error:body.impact?'Choose the same model for both runs':'Choose two distinct models'});
  const pooled=Boolean(body.datasets);
  if(Boolean(body.dataset)===pooled)return respond(400,{error:'Choose either a single benchmark or a pool'});
  const ids=pooled?[...new Set(body.datasets)].sort():[body.dataset];
  if(pooled&&ids.length!==body.datasets.length)return respond(400,{error:'Choose distinct benchmark versions'});
  if(body.impact&&(pooled||body.releaseGate||watchGuard))return respond(400,{error:'Impact Trials use one benchmark and one model'});
  if(pooled&&body.releaseGate)return respond(400,{error:'Release gates require a single benchmark'});
  const select=dataset=>db.one(`SELECT d.id,d.title,d.owner,d.commitment,p.price AS trial_price,p.cases,p.categories,p.consented,it.tool AS impact_tool,it.unit_price AS impact_unit_price,po.consented AS pool_consent
    FROM datasets d JOIN trial_policies p ON p.dataset=d.id LEFT JOIN trial_pool_opt_ins po ON po.dataset=d.id AND po.consented=p.consented
    LEFT JOIN trial_impact_tools it ON it.dataset=p.dataset AND it.consented=p.consented
    WHERE d.id=? AND p.enabled=1 AND ${unpaused}${pooled?' AND po.dataset IS NOT NULL':''}`,[dataset]);
  const sources=await Promise.all(ids.map(select));
  if(sources.some(source=>!source))return respond(404,{error:'Benchmark unavailable or not opted into pools'});
  const d=sources[0];
  if(watchGuard&&(d.commitment!==watchGuard.commitment||Number(d.trial_price)>watchGuard.maxPrice))return respond(409,{error:'Watch version or price cap no longer matches'});
  if(sources.some(source=>source.owner===wallet))return respond(409,{error:'Choose benchmarks owned by other contributors'});
  if(new Set(sources.map(source=>source.owner)).size!==ids.length)return respond(400,{error:'Choose benchmarks from distinct contributors'});
  const tool=body.impact&&d.impact_tool?await db.one(availableTool,[d.impact_tool,d.owner]):null;
  if(body.impact&&!tool)return respond(404,{error:'This benchmark has no available private tool for Impact Trials'});
  if(tool&&String(tool.price)!==String(d.impact_unit_price))return respond(409,{error:'The contributor must reconfirm the tool price'});
  const toolCost=tool?Number(tool.price)*Number(d.cases):0;
  const price=sources.reduce((sum,source)=>sum+Number(source.trial_price),toolCost);
  const impactParams=tool?[d.id,tool.id,d.consented,d.trial_price,d.commitment,tool.id,d.owner,tool.commitment,tool.price]:[];
  const checkImpact=async()=>{
   if(!await db.one('SELECT 1 AS allowed WHERE '+impactGuard,impactParams))throw Error('Impact Trial consent or pricing changed');
  };
  if(price>1000000000)return respond(400,{error:'The trial price exceeds 1,000 USDC'});
  if(sources.reduce((sum,source)=>sum+Number(source.cases),0)>30)return respond(400,{error:'Choose up to 30 cases in total'});
  if(body.releaseGate&&!gates.available)return respond(503,{error:'Release gate signing is unavailable'});
  if(body.releaseGate?.category&&!JSON.parse(d.categories).includes(body.releaseGate.category))return respond(400,{error:'Choose a category offered by this benchmark'});
  const previous=await db.one(`SELECT o.id FROM trial_orders o WHERE o.buyer=? AND o.state='prepared'
    AND (o.dataset IN (${ids.map(()=>'?').join(',')}) OR EXISTS (SELECT 1 FROM trial_pool_sources ps WHERE ps.order_id=o.id AND ps.dataset IN (${ids.map(()=>'?').join(',')}))) LIMIT 1`,[wallet,...ids,...ids]);
  if(previous)return respond(409,{error:'Resolve your existing trial payment in trial history first'});
  const checkPoolConsent=async source=>{
   const current=await select(source.id);
   if(!current||current.pool_consent!==source.pool_consent||current.trial_price!==source.trial_price||current.commitment!==source.commitment)throw Error('Pool consent or pricing changed');
  };
  if(active.has(wallet))return respond(409,{error:'A trial is already preparing'});active.add(wallet);const id=randomUUID();let stored=false;
  try{
   // Limits are persistent across restarts and shared by all model pairs.
   const day=Math.floor(Date.now()/86400000),buyerSlot=hash('buyer:'+wallet+':'+day);
   const reserved=await db.query('INSERT INTO trial_quota(slot,created) VALUES(?,?) ON CONFLICT(slot) DO NOTHING RETURNING slot',[buyerSlot,Date.now()]);if(!reserved.rows.length)return respond(429,{error:'One trial preparation per buyer per day; try tomorrow'});
   const reservedSlots=[buyerSlot];
   for(const dataset of ids){
    const prefix=hash('benchmark:'+dataset+':'+day);
    let capacity=false;
    for(let n=0;n<20;n++){
     const slot=prefix+':'+n;
     const r=await db.query('INSERT INTO trial_quota(slot,created) VALUES(?,?) ON CONFLICT(slot) DO NOTHING RETURNING slot',[slot,Date.now()]);
     if(r.rows.length){reservedSlots.push(slot);capacity=true;break}
    }
    if(!capacity){
     for(const slot of reservedSlots)await db.query('DELETE FROM trial_quota WHERE slot=?',[slot]);
     return respond(429,{error:'Benchmark daily trial capacity reached'});
    }
   }
   if(body.releaseGate)await gates.save(id,body.releaseGate);
   await db.query('INSERT INTO trial_jobs(id,buyer,state,created) VALUES(?,?,?,?)',[id,wallet,'running',Date.now()]);
   void (async()=>{try{
   const batches=await Promise.all(sources.map(async source=>({
    source,cases:parseBenchmark((await storage.get(source.id)).content)
   })));
   const cases=batches.flatMap(batch=>batch.cases.map(c=>pooled?{...c,category:'Combined',source:batch.source}:c));
   if(cases.length>30||await isPaused(db,d.id))throw Error('Dataset access unavailable');
   let impact;
   if(tool){
    await checkImpact();
    const {content:source}=await storage.get(tool.dataset);
    const fields=JSON.parse(tool.fields);
    if(cases.length!==Number(d.cases))throw Error('Benchmark case count changed');
    const inputs=new Map(cases.map(item=>[item,validateInput(fields,item.toolInput)]));
    impact={tool:tool.name,toolCommitment:tool.commitment,toolCost,invoke:item=>runTool({tool,input:inputs.get(item),source,env})};
   }
   const checkRouterConsent=async()=>{
    const current=await select(d.id);
    if(!current||current.consented!==d.consented||current.commitment!==d.commitment||String(current.trial_price)!==String(d.trial_price))throw Error('Benchmark consent or pricing changed');
   };
   const scorecard=await evaluateBenchmark({cases,models:body.models,env,infer,impact,router:body.router,beforeCase:body.router?checkRouterConsent:tool?checkImpact:pooled?c=>checkPoolConsent(c.source):undefined});
   const poolSources=pooled?allocatePoolPayouts(batches.map(({source,cases})=>({
    dataset:source.id,title:source.title,owner:source.owner,commitment:source.commitment,cases:cases.length
   })),price):undefined;
   const commitment=pooled?hash(JSON.stringify(poolSources)):d.commitment;
   const terms=body.router?ROUTER_TERMS:tool?IMPACT_TERMS:pooled?POOL_TERMS:TRIAL_TERMS;
   await storage.put(id,scorecard);stored=true;
   const built=await build({buyer:wallet,seller:d.owner,platform:env.PLATFORM_WALLET,price,id,commitment:hash(commitment+'\n'+JSON.stringify(scorecard)),license:terms,version:body.version,rpcUrl:env.SOLANA_RPC_URL,trialContributors:poolSources});
   if(pooled){
    for(const source of sources)await checkPoolConsent(source);
    for(const source of poolSources)await db.query('INSERT INTO trial_pool_sources(order_id,dataset,owner,amount) VALUES(?,?,?,?)',[id,source.dataset,source.owner,source.amount]);
    built.summary.poolSources=poolSources;
   }
   if(tool)built.summary.impactToolCost=String(toolCost);
   const now=Date.now();
   const routerParams=body.router?[d.id,d.commitment,d.trial_price,d.consented]:[];
   const allowed=body.router?`EXISTS (SELECT 1 FROM datasets d JOIN trial_policies p ON p.dataset=d.id
    WHERE d.id=? AND d.commitment=? AND p.enabled=1 AND p.price=? AND p.consented=? AND ${unpaused})`:tool?impactGuard:pooled?sources.map(()=>`EXISTS (
    SELECT 1 FROM datasets d JOIN trial_policies p ON p.dataset=d.id
    JOIN trial_pool_opt_ins po ON po.dataset=d.id AND po.consented=p.consented
    WHERE d.id=? AND d.commitment=? AND p.enabled=1 AND p.price=? AND po.consented=? AND ${unpaused}
   )`).join(' AND '):'1=1';
   const order=await db.query(`INSERT INTO trial_orders(id,buyer,dataset,owner,price,commitment,models,terms,summary,message,tx,quote,state,created,expires)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${allowed} RETURNING id`,
    [id,wallet,pooled?id:d.id,d.owner,price,commitment,JSON.stringify(body.models),terms,JSON.stringify(built.summary),built.message,built.transaction,JSON.stringify(built),'prepared',now,now+120000,
     ...routerParams,...impactParams,...(pooled?sources.flatMap(source=>[source.id,source.commitment,source.trial_price,source.pool_consent]):[])]);
   if(!order.rows.length)throw Error('Benchmark consent or pricing changed');
   await db.query("UPDATE trial_jobs SET state='ready' WHERE id=?",[id]);
   }catch{if(!await db.one('SELECT id FROM trial_orders WHERE id=?',[id])){if(stored)await storage.remove(id).catch(()=>{});if(pooled)await db.query('DELETE FROM trial_pool_sources WHERE order_id=?',[id]);}await db.query("UPDATE trial_jobs SET state='failed' WHERE id=?",[id]);}finally{active.delete(wallet)}})().catch(()=>{});
   return respond(202,{id,state:'running'});
  }catch(e){active.delete(wallet);throw e}finally{if(!await db.one("SELECT id FROM trial_jobs WHERE id=? AND state='running'",[id]))active.delete(wallet)}
 };
 app.post('/api/trial-orders',authenticated,async(req,res)=>{const r=await prepareTrial(req.wallet,req.body);res.status(r.status).json(r.data)});
 await installRegressionWatch(app,{db,storage,authenticated,enabled,prepareTrial});
 app.get('/api/trial-jobs/:id',authenticated,async(req,res)=>{const j=await db.one('SELECT * FROM trial_jobs WHERE id=? AND buyer=?',[uuid.parse(req.params.id),req.wallet]);if(!j)return res.status(404).json({error:'Trial preparation not found'});if(j.state!=='ready')return res.json({id:j.id,state:j.state,...(j.state==='failed'?{error:'Trial did not complete with verified receipts. No payment was prepared; retry tomorrow.'}:{})});const o=await db.one('SELECT * FROM trial_orders WHERE id=?',[j.id]);res.json({id:j.id,state:'ready',transaction:o.tx,summary:JSON.parse(o.summary),terms:o.terms,simulation:true})});
 app.post('/api/trial-orders/:id/payment',authenticated,async(req,res)=>{
  if(!enabled)return res.status(503).json({error:'Verified trials are not ready'});
  const o=await db.one('SELECT * FROM trial_orders WHERE id=? AND buyer=?',[uuid.parse(req.params.id),req.wallet]);if(!o)return res.status(404).json({error:'Trial not found'});if(o.state==='paid')return res.json({paid:true});
  const key='quote:'+o.id;if(active.has(key))return res.status(409).json({error:'Quote already preparing'});active.add(key);
  try{const previous=JSON.parse(o.quote),rpc=rpcClient(env.SOLANA_RPC_URL);
   if(await rpc('getBlockHeight',[{commitment:'finalized'}])<=previous.lastValidBlockHeight)return res.json({id:o.id,...previous,terms:o.terms});
   if(!Number.isSafeInteger(previous.quoteSlot)||await rpc('getFirstAvailableBlock')>previous.quoteSlot)throw Error('History unavailable; recover with your transaction signature');
   let before,complete=false;for(let page=0;page<10&&!complete;page++){
    const history=await rpc('getSignaturesForAddress',[o.buyer,{commitment:'finalized',limit:100,before}]);
    for(const entry of history){if(entry.slot<previous.quoteSlot){complete=true;break}if(!entry.err&&entry.memo?.includes('DataLoom:v1:'+o.id+':')){await verify(entry.signature,previous.message,env.SOLANA_RPC_URL);await db.query("UPDATE trial_orders SET state='paid',signature=? WHERE id=? AND state='prepared'",[entry.signature,o.id]);return res.json({paid:true})}}
    if(history.length<100)complete=true;else before=history.at(-1).signature;
   }
   if(!complete)throw Error('Recover with the existing transaction signature before paying again');
   const poolSources=JSON.parse(o.summary).poolSources;
   const scorecard=await storage.get(o.id),next=await build({buyer:o.buyer,seller:o.owner,platform:env.PLATFORM_WALLET,price:o.price,id:o.id,commitment:hash(o.commitment+'\n'+JSON.stringify(scorecard)),license:o.terms,rpcUrl:env.SOLANA_RPC_URL,trialContributors:poolSources});
   if(poolSources)next.summary.poolSources=poolSources;
   if(scorecard.impact)next.summary.impactToolCost=scorecard.impact.toolCost;
   const update=await db.query("UPDATE trial_orders SET quote=?,message=?,tx=?,summary=?,expires=? WHERE id=? AND state='prepared' AND message=? RETURNING id",[JSON.stringify(next),next.message,next.transaction,JSON.stringify(next.summary),Date.now()+120000,o.id,o.message]);if(!update.rows.length)throw Error('Payment state changed; refresh history');
   res.json({id:o.id,...next,terms:o.terms});
  }finally{active.delete(key)}
 });
 app.get('/api/my/trial-orders',authenticated,async(req,res)=>res.json((await db.query('SELECT * FROM trial_orders WHERE buyer=? ORDER BY created DESC LIMIT 100',[req.wallet])).rows.map(info)));
 app.get('/api/my/trial-earnings',authenticated,async(req,res)=>{
  const {rows}=await db.query(`SELECT id,summary,signature,created,NULL AS amount FROM trial_orders WHERE owner=? AND dataset<>id AND state='paid'
   UNION ALL SELECT o.id,o.summary,o.signature,o.created,p.amount FROM trial_pool_sources p JOIN trial_orders o ON o.id=p.order_id
   WHERE p.owner=? AND o.state='paid' ORDER BY created DESC LIMIT 100`,[req.wallet,req.wallet]);
  res.json(rows.map(o=>({id:o.id,contributorAmount:String(o.amount??JSON.parse(o.summary).sellerAmount),signature:o.signature,created:Number(o.created)})));
 });
 app.get('/api/trial-orders/:id',authenticated,async(req,res)=>{const o=await db.one('SELECT * FROM trial_orders WHERE id=? AND buyer=?',[uuid.parse(req.params.id),req.wallet]);if(!o)return res.status(404).json({error:'Trial not found'});res.json(o.state==='paid'?await result(o):info(o))});
 app.post('/api/trial-orders/:id/confirm',authenticated,async(req,res)=>{
  const id=uuid.parse(req.params.id),signature=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/).parse(req.body.signature);let o=await db.one('SELECT * FROM trial_orders WHERE id=? AND buyer=?',[id,req.wallet]);if(!o)return res.status(404).json({error:'Trial not found'});
  if(o.signature&&o.signature!==signature)return res.status(409).json({error:'Another transaction already confirmed this trial'});
  if(o.state!=='paid'){await verify(signature,o.message,env.SOLANA_RPC_URL);await db.query("UPDATE trial_orders SET state='paid',signature=? WHERE id=? AND state='prepared'",[signature,id]);o=await db.one('SELECT * FROM trial_orders WHERE id=?',[id]);if(o.signature!==signature)return res.status(409).json({error:'Another transaction already confirmed this trial'})}
  res.json(await result(o));
 });
}
