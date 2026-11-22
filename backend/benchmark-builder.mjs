import {randomUUID,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {parseBenchmark} from './blind-trials.mjs';
import {hash,analyze} from './security.mjs';
import {unpaused} from './consent-ledger.mjs';
const field=z.string().min(1).max(64).refine(x=>!['__proto__','constructor','prototype'].includes(x));
export const builderConfig=z.object({promptField:field.default('prompt'),answerField:field.default('expectedAnswer'),categoryField:field.default('category'),answerFormat:z.enum(['text','number','boolean','choice']).default('text'),choices:z.array(z.string().trim().min(1).max(500)).max(20).default([]),categories:z.array(z.string().trim().min(2).max(40)).max(4).default([]),balance:z.boolean().default(true),maxCases:z.number().int().min(5).max(20).default(20)}).strict();
const normalize=x=>x.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
export function buildBenchmark(content,options){
 const config=builderConfig.parse(options);if(config.answerFormat==='choice'&&(config.choices.length<2||new Set(config.choices.map(normalize)).size!==config.choices.length))throw Error('Choice answers require 2–20 distinct options');
 if(new Set(config.categories).size!==config.categories.length)throw Error('Select distinct categories');
 const rows=z.array(z.record(z.string(),z.json())).min(1).max(10000).parse(JSON.parse(content));
 const errors=[],duplicates=[],unique=[],seen=new Map();let excluded=0;
 for(const [index,row]of rows.entries()){
  const category=row[config.categoryField]??'General';
  if(typeof category!=='string'||category.trim().length<2||category.trim().length>40){errors.push({row:index+1,field:'category',issue:'Use a category of 2–40 characters'});continue;}
  if(config.categories.length&&!config.categories.includes(category.trim())){excluded++;continue;}
  const prompt=row[config.promptField],raw=row[config.answerField];let answer;
  if(typeof prompt!=='string'||prompt.trim().length<3||prompt.trim().length>2000){errors.push({row:index+1,field:'prompt',issue:'Use a prompt of 3–2000 characters'});continue;}
  if(config.answerFormat==='number'){
   if(typeof raw==='number'&&Number.isFinite(raw))answer=String(raw);
   else if(typeof raw==='string'&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw.trim())&&Number.isFinite(Number(raw)))answer=String(Number(raw));
  }else if(config.answerFormat==='boolean'){
   if(typeof raw==='boolean')answer=String(raw);else if(typeof raw==='string'&&/^(true|false)$/i.test(raw.trim()))answer=raw.trim().toLowerCase();
  }else if(typeof raw==='string'&&raw.trim().length>0&&raw.trim().length<=500){
   answer=raw.trim();if(config.answerFormat==='choice')answer=config.choices.find(c=>normalize(c)===normalize(answer));
  }
  if(!answer||answer.length>500){errors.push({row:index+1,field:'answer',issue:'Answer does not match the selected format or length'});continue;}
  const key=normalize(prompt),previous=seen.get(key);
  if(previous){const conflict=normalize(previous.answer)!==normalize(answer);duplicates.push({row:index+1,firstRow:previous.row,conflicting:conflict});if(conflict)errors.push({row:index+1,field:'answer',issue:'Duplicate prompt has conflicting expected answers'});continue;}
  seen.set(key,{row:index+1,answer});unique.push({prompt:prompt.trim(),expectedAnswer:answer,category:category.trim()});
 }
 const groups=new Map();for(const c of unique){if(!groups.has(c.category))groups.set(c.category,[]);groups.get(c.category).push(c);}
 for(const cat of config.categories)if(!groups.has(cat))groups.set(cat,[]);
 const counts=[...groups].map(([category,cases])=>({category,available:cases.length,selected:0}));
 if(groups.size>4||groups.size===0)errors.push({field:'categories',issue:'Select 1–4 categories'});
 if(groups.size*5>config.maxCases)errors.push({field:'maxCases',issue:'Allow at least five cases per included category'});
 for(const c of counts)if(c.available<5)errors.push({field:'categories',category:c.category,issue:'At least five distinct valid prompts are required per category'});
 const cases=[];
 if(!errors.length){
  if(config.balance){const n=Math.min(Math.floor(config.maxCases/groups.size),...counts.map(x=>x.available));for(const c of counts){c.selected=n;cases.push(...groups.get(c.category).slice(0,n));}}
  else {for(const c of counts){c.selected=5;cases.push(...groups.get(c.category).slice(0,5));}let added=true;while(cases.length<config.maxCases&&added){added=false;for(const c of counts){const next=groups.get(c.category)[c.selected];if(next&&cases.length<config.maxCases){cases.push(next);c.selected++;added=true;}}}}
  parseBenchmark(JSON.stringify(cases));
 }
 const report={schema:'data-loom-benchmark-build-v1',valid:errors.length===0,sourceRows:rows.length,selectedCases:cases.length,excludedByCategory:excluded,uniqueValidPrompts:unique.length,duplicateCount:duplicates.length,duplicates,errors,categories:counts,balance:config.balance,answerFormat:config.answerFormat,scoring:'Unicode-normalized, case-insensitive exact match with collapsed whitespace; numeric and boolean answers are stored as canonical strings.',scope:'Deterministic preparation checks. Not verification of factual correctness or benchmark representativeness.'};
 return {config,report,cases,contentHash:hash(content)};
}
export async function installBenchmarkBuilder(app,{db,storage,authenticated}){
 await db.query('CREATE TABLE IF NOT EXISTS benchmark_builds(dataset TEXT PRIMARY KEY,source TEXT NOT NULL,source_commitment TEXT NOT NULL,report_object TEXT NOT NULL,owner TEXT NOT NULL,created BIGINT NOT NULL)');
 const schema=z.object({dataset:z.string().uuid(),config:builderConfig}).strict();
 const load=async(req,input)=>{const row=await db.one(`SELECT * FROM datasets d WHERE d.id=? AND d.owner=? AND d.state<>'published' AND ${unpaused}`,[input.dataset,req.wallet]);if(!row)throw Error('Your active private source dataset is required');const source=await storage.get(row.id);if(!source.salt||hash(source.salt+'\n'+source.content)!==row.commitment)throw Error('Source commitment verification failed');const result=buildBenchmark(source.content,input.config);return {row,result,reportHash:hash(JSON.stringify({source:row.id,commitment:row.commitment,contentHash:result.contentHash,config:result.config,report:result.report}))};};
 app.get('/api/benchmark-builder/status',(req,res)=>res.json({enabled:true,maxInputRows:10000,minCases:5,maxCases:20,minCasesPerCategory:5,maxCategories:4,paidTrialsAutoEnabled:false,requiresOnchainDeployment:false}));
 app.post('/api/my/benchmark-builder/analyze',authenticated,async(req,res)=>{const body=schema.parse(req.body);try{const {row,result,reportHash}=await load(req,body);res.set('Cache-Control','no-store');res.json({source:row.id,sourceCommitment:row.commitment,report:result.report,reportHash});}catch(e){res.status(400).json({error:e.message});}});
 app.post('/api/my/benchmark-builder/save',authenticated,async(req,res)=>{
  const body=schema.extend({title:z.string().trim().min(3).max(160),reportHash:z.string().regex(/^[a-f0-9]{64}$/),consent:z.literal(true)}).parse(req.body);
  let loaded;try{loaded=await load(req,body);}catch(e){return res.status(400).json({error:e.message});}
  const {row,result,reportHash}=loaded;if(reportHash!==body.reportHash)return res.status(409).json({error:'Source or configuration changed. Analyze again before saving.'});if(!result.report.valid)return res.status(422).json({error:'Resolve validation errors before saving',report:result.report});
  const content=JSON.stringify(result.cases),analysis=analyze(content),old=await db.one('SELECT id,commitment FROM datasets WHERE owner=? AND fingerprint=?',[req.wallet,analysis.fingerprint]);if(old)return res.status(409).json({error:'This selected dataset version already exists. Review its existing access policies before reusing it.',id:old.id});
  const id=randomUUID(),reportObject=randomUUID(),salt=randomBytes(32).toString('hex'),commitment=hash(salt+'\n'+content),now=Date.now();analysis.lineage={parentId:row.id,parentCommitment:row.commitment,parentLicense:row.license,transformation:'filtered'};
  const key=await storage.put(id,{content,salt,license:row.license,owner:req.wallet});try{await storage.put(reportObject,{source:row.id,sourceCommitment:row.commitment,reportHash,report:result.report,config:result.config});}catch(e){await storage.remove(id);throw e;}
  try{await db.transaction(async tx=>{const current=await tx.one(`SELECT id FROM datasets d WHERE d.id=? AND d.owner=? AND d.commitment=? AND ${unpaused}`,[row.id,req.wallet,row.commitment]);if(!current)throw Error('Source permissions changed');if(await tx.one('SELECT id FROM datasets WHERE owner=? AND fingerprint=?',[req.wallet,analysis.fingerprint]))throw Error('This benchmark version was saved concurrently. Refresh Account.');await tx.query('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,req.wallet,body.title,'Research','Private evaluation set prepared with contributor-approved deterministic validation.','Private benchmark; prompts and reference answers are not included in this preview.',key,commitment,analysis.fingerprint,row.price,row.license,'draft',now,JSON.stringify(analysis)]);await tx.query('INSERT INTO benchmark_builds VALUES(?,?,?,?,?,?)',[id,row.id,row.commitment,reportObject,req.wallet,now]);await tx.query('INSERT INTO audit(id,wallet,action,resource,created) VALUES(?,?,?,?,?)',[randomUUID(),req.wallet,'benchmark-build-consented',id,now]);});}catch(e){await storage.remove(id);await storage.remove(reportObject);throw e;}
  res.status(201).json({id,commitment,reportHash,source:row.id,cases:result.cases.length,trialEnabled:false});
 });
 app.get('/api/my/benchmark-builder/:id/report',authenticated,async(req,res)=>{const row=await db.one('SELECT * FROM benchmark_builds WHERE dataset=? AND owner=?',[z.string().uuid().parse(req.params.id),req.wallet]);if(!row)return res.status(404).json({error:'Build report not found'});res.set('Cache-Control','no-store');res.json(await storage.get(row.report_object));});
}
