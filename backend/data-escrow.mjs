import {createEscrowChain} from './escrow-chain.mjs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash,validWallet} from './security.mjs';
import {unpaused} from './consent-ledger.mjs';
const uuid=z.string().uuid();
const field=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
export const escrowCriteria=z.object({minRows:z.number().int().min(1).max(10000),maxRows:z.number().int().min(1).max(10000),requiredFields:z.array(z.object({name:field,type:z.enum(['string','number','boolean'])}).strict()).min(1).max(20),minCompletenessBps:z.number().int().min(0).max(10000),maxDuplicateBps:z.number().int().min(0).max(10000),coverage:z.object({field,values:z.array(z.string().min(1).max(100)).min(1).max(20),minPerValue:z.number().int().min(1).max(10000)}).strict().nullable()}).strict().superRefine((x,c)=>{if(x.maxRows<x.minRows)c.addIssue({code:'custom',message:'Maximum rows must cover minimum rows'});if(new Set(x.requiredFields.map(f=>f.name)).size!==x.requiredFields.length)c.addIssue({code:'custom',message:'Duplicate required field'});if(x.coverage&&new Set(x.coverage.values).size!==x.coverage.values.length)c.addIssue({code:'custom',message:'Duplicate coverage category'});});
export const canonical=value=>JSON.stringify(value===null||typeof value!=='object'?value:Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])));
export function evaluateEscrow(content,input){
 const criteria=escrowCriteria.parse(input),rows=z.array(z.record(z.string(),z.json())).min(1).max(10000).parse(JSON.parse(content));
 let complete=0;for(const row of rows)if(criteria.requiredFields.every(f=>typeof row[f.name]===f.type&&(f.type!=='string'||row[f.name].trim().length>0)))complete++;
 const duplicates=rows.length-new Set(rows.map(r=>hash(canonical(r)))).size;
 const coverage=criteria.coverage?criteria.coverage.values.map(value=>({value,count:rows.filter(r=>r[criteria.coverage.field]===value).length})):[];
 const checks={rowCount:rows.length>=criteria.minRows&&rows.length<=criteria.maxRows,completeness:complete*10000>=criteria.minCompletenessBps*rows.length,duplicates:duplicates*10000<=criteria.maxDuplicateBps*rows.length,coverage:coverage.every(x=>x.count>=criteria.coverage.minPerValue)};
 return {schema:'data-loom-data-check-v1',passed:Object.values(checks).every(Boolean),checks,rows:rows.length,completenessBps:Math.floor(complete*10000/rows.length),duplicateBps:Math.floor(duplicates*10000/rows.length),coverage,criteriaHash:hash(canonical(criteria)),contentHash:hash(content),scope:'Deterministic schema, coverage and duplication checks only. Not factual accuracy or an inference receipt.'};
}
export async function installDataEscrow(app,{db,storage,authenticated,env={},chain=createEscrowChain(env)}){
 await db.query('CREATE TABLE IF NOT EXISTS data_escrows(id TEXT PRIMARY KEY,buyer TEXT NOT NULL,contributor TEXT NOT NULL,object_id TEXT NOT NULL,terms_hash TEXT NOT NULL,price BIGINT NOT NULL,deadline BIGINT NOT NULL,accepted INTEGER NOT NULL,submission TEXT,state TEXT NOT NULL,created BIGINT NOT NULL)');
 const schema=z.object({contributor:z.string().refine(validWallet),title:z.string().trim().min(3).max(100),criteria:escrowCriteria,price:z.number().int().min(10000).max(1000000000),days:z.number().int().min(1).max(30),license:z.enum(['research-v1','commercial-v1'])}).strict();
 async function own(req){if(chain&&req.wallet===chain.verifier){const row=await db.one('SELECT * FROM data_escrows WHERE id=?',[uuid.parse(req.params.id)]);const terms=row&&await storage.get(row.object_id);if(terms?.verifier===req.wallet&&terms.program===chain.program)return row;}return db.one('SELECT * FROM data_escrows WHERE id=? AND (buyer=? OR contributor=?)',[uuid.parse(req.params.id),req.wallet,req.wallet]);}
 async function describe(row){const terms=await storage.get(row.object_id);return {id:row.id,buyer:row.buyer,contributor:row.contributor,termsHash:row.terms_hash,price:String(row.price),deadline:Number(row.deadline),accepted:Boolean(row.accepted),state:row.state,...terms};}
 app.get('/api/data-escrow/status',async(req,res)=>{let ready=false;try{if(chain)ready=await chain.verifyProgram();}catch{}res.json({requestsEnabled:true,fundingEnabled:ready,network:ready?'solana:mainnet':'not-deployed',program:chain?.program||null,verifier:chain?.verifier||null,checks:'Deterministic schema, completeness, duplicate limits and category coverage',custody:'USDC held in a separately verified program vault. The agreed verifier authorizes release; direct checkout is never substituted.'});});
 app.post('/api/my/data-escrows',authenticated,async(req,res)=>{
  const b=schema.parse(req.body);if(req.wallet===b.contributor)return res.status(400).json({error:'Choose a different contributor'});
  const id=randomUUID(),object=randomUUID(),now=Date.now(),deadline=Math.floor((now+b.days*86400000)/1000)*1000;
  const terms={title:b.title,criteria:b.criteria,license:b.license,buyer:req.wallet,contributor:b.contributor,price:String(b.price),deadline,split:{contributorBps:7000,platformBps:3000},checksVersion:'data-loom-data-check-v1',program:chain?.program||null,verifier:chain?.verifier||null,platform:chain?.platform||null,settlementTrust:'The named verifier authorizes release after deterministic checks. Its signature is not cryptographic proof of data quality. Delivery uses an encrypted immutable snapshot; granted license rights survive source revocation after release.'};
  await storage.put(object,terms);
  try{await db.query('INSERT INTO data_escrows VALUES(?,?,?,?,?,?,?,0,NULL,?,?)',[id,req.wallet,b.contributor,object,hash(canonical(terms)),b.price,deadline,'draft',now]);}catch(e){await storage.remove(object);throw e;}
  res.status(201).json(await describe(await db.one('SELECT * FROM data_escrows WHERE id=?',[id])));
 });
 app.get('/api/my/data-escrows',authenticated,async(req,res)=>{const {rows}=await db.query('SELECT * FROM data_escrows WHERE buyer=? OR contributor=? OR ?=1 ORDER BY created DESC LIMIT 100',[req.wallet,req.wallet,chain&&req.wallet===chain.verifier?1:0]);const requests=await Promise.all(rows.map(describe));res.json({requests:requests.filter(r=>r.buyer===req.wallet||r.contributor===req.wallet||(r.verifier===req.wallet&&r.program===chain?.program))});});
 app.post('/api/my/data-escrows/:id/accept',authenticated,async(req,res)=>{
  const {termsHash}=z.object({termsHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body),row=await own(req);
  if(!row||row.contributor!==req.wallet)return res.status(404).json({error:'Contributor request not found'});
  if(row.terms_hash!==termsHash||Number(row.deadline)<=Date.now()||row.state!=='draft')return res.status(409).json({error:'Terms changed or request closed'});
  await db.query('UPDATE data_escrows SET accepted=1 WHERE id=? AND state=?',[row.id,'draft']);res.json({accepted:true,termsHash});
 });
 async function checkDataset(req,row){
  const {dataset,consent}=z.object({dataset:uuid,consent:z.literal(true)}).strict().parse(req.body);
  const d=await db.one(`SELECT * FROM datasets d WHERE d.id=? AND d.owner=? AND d.state<>'published' AND ${unpaused}`,[dataset,req.wallet]);
  if(!d||req.wallet!==row.contributor)throw Error('Your active private dataset is required');
  const source=await storage.get(dataset),terms=await storage.get(row.object_id);
  return {dataset:d,source,report:evaluateEscrow(source.content,terms.criteria)};
 }
 app.post('/api/my/data-escrows/:id/preflight',authenticated,async(req,res)=>{
  const row=await own(req);if(!row||!row.accepted||Date.now()>=Number(row.deadline))return res.status(409).json({error:'Accepted, unexpired request required'});
  try{const {report}=await checkDataset(req,row);res.json({report,fundingRequired:true});}catch(e){res.status(400).json({error:e.message});}
 });
 app.post('/api/my/data-escrows/:id/:action',authenticated,async(req,res)=>{
  const action=z.enum(['initialize','accept-vault','fund','submit','release','refund','download','sync']).parse(req.params.action),row=await own(req);
  if(!row)return res.status(404).json({error:'Request not found'});
  if(!chain)return res.status(503).json({error:'Escrow funding is unavailable until the vault program is deployed and verified. No funds moved.'});
  const terms=await storage.get(row.object_id);
  if(hash(canonical(terms))!==row.terms_hash)throw Error('Stored escrow terms integrity failed');
  const state=await chain.state(row,terms);
  const names=['initialized','accepted','funded','released','refunded'];
  if(state.state>=0)await db.query('UPDATE data_escrows SET state=? WHERE id=?',[names[state.state],row.id]);
  const submission=row.submission?await storage.get(row.submission):null;
  if(action==='sync')return res.json({state:state.state<0?'draft':names[state.state],vault:state.vault,report:submission?.report||null,reportHash:submission?.reportHash||null});
  if(action==='download'){
   if(req.wallet!==row.buyer||state.state!==3||!submission||submission.reportHash!==state.reportHash||hash(submission.content)!==submission.report.contentHash)return res.status(403).json({error:'Matching finalized release required before dataset delivery'});
   res.set('Cache-Control','no-store');return res.json({content:submission.content,source:submission.source,report:submission.report,reportHash:submission.reportHash,termsHash:row.terms_hash,license:terms.license,vault:state.vault});
  }
  if(action==='submit'){
   if(req.wallet!==row.contributor||!row.accepted||state.state!==2||Date.now()>=Number(row.deadline))return res.status(409).json({error:'Your funded, accepted, unexpired request required'});
   if(submission)return res.json({submitted:true,report:submission.report,reportHash:submission.reportHash});
   const checked=await checkDataset(req,row);if(!checked.report.passed)return res.status(422).json({error:'Dataset does not meet the agreed criteria',report:checked.report});
   const object=randomUUID(),snapshot={content:checked.source.content,source:{id:checked.dataset.id,commitment:checked.dataset.commitment},report:checked.report,termsHash:row.terms_hash};
   snapshot.reportHash=hash(canonical({request:row.id,termsHash:row.terms_hash,source:snapshot.source,report:snapshot.report}));
   await storage.put(object,snapshot);
   try{const changed=await db.query('UPDATE data_escrows SET submission=? WHERE id=? AND submission IS NULL RETURNING id',[object,row.id]);if(!changed.rows.length){await storage.remove(object);return res.status(409).json({error:'Another immutable submission already exists'});}}catch(e){await storage.remove(object);throw e;}
   return res.status(201).json({submitted:true,report:snapshot.report,reportHash:snapshot.reportHash});
  }
  if(!row.accepted)return res.status(409).json({error:'Contributor must accept the exact terms first'});
  if(action==='release'){
   if(!submission||submission.termsHash!==row.terms_hash||hash(submission.content)!==submission.report.contentHash)throw Error('Immutable submission required');
   const report=evaluateEscrow(submission.content,terms.criteria);
   const expected=hash(canonical({request:row.id,termsHash:row.terms_hash,source:submission.source,report}));
   if(!report.passed||expected!==submission.reportHash)throw Error('Passing, version-bound quality report required');
  }
  const prepared=await chain.prepare(row,terms,action==='accept-vault'?'acceptVault':action,req.wallet,submission?.reportHash);
  res.json(prepared);
 });
}
