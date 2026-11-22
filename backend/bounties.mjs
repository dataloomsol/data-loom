import {parseBenchmark} from './blind-trials.mjs';
import {isPaused} from './consent-ledger.mjs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash} from './security.mjs';
import {buildPayment,verifyPayment,rpcClient} from './settlement.mjs';
const uuid=z.string().uuid();
export const BOUNTY_TERMS='Answer Bounty v1. Contributor-authored reports for internal use. No dataset download or training rights. Selected contributors share 70%, platform 30%.';
export const GAP_BOUNTY_TERMS='Dataset Gap Bounty v1. Selected evaluation cases are licensed to the buyer for internal model evaluation. No redistribution, training rights or source dataset access. Selected contributors share 70%, platform 30%.';
export async function installBounties(app,{db,storage,env,authenticated,payments,build=buildPayment,verify=verifyPayment}){
 await db.query('CREATE TABLE IF NOT EXISTS bounties (id TEXT PRIMARY KEY, buyer TEXT NOT NULL, question TEXT NOT NULL, criteria TEXT NOT NULL, price BIGINT NOT NULL, created BIGINT NOT NULL, state TEXT NOT NULL, award TEXT, signature TEXT UNIQUE)');
 await db.query('CREATE TABLE IF NOT EXISTS bounty_reports (id TEXT PRIMARY KEY, bounty TEXT NOT NULL, owner TEXT NOT NULL, dataset TEXT NOT NULL, commitment TEXT NOT NULL, preview TEXT NOT NULL, created BIGINT NOT NULL, UNIQUE(bounty,owner))');
 await db.query('CREATE TABLE IF NOT EXISTS bounty_gaps (id TEXT PRIMARY KEY, trial_order TEXT)');
 const termsFor=b=>b.kind==='gap'?GAP_BOUNTY_TERMS:BOUNTY_TERMS;
 const lookup=id=>db.one("SELECT b.*,CASE WHEN g.id IS NULL THEN 'answer' ELSE 'gap' END AS kind FROM bounties b LEFT JOIN bounty_gaps g ON g.id=b.id WHERE b.id=?",[uuid.parse(id)]);
 app.get('/api/bounties',async(req,res)=>res.json((await db.query("SELECT b.id,b.buyer,b.question,b.criteria,b.price,b.created,b.state,b.signature,CASE WHEN g.id IS NULL THEN 'answer' ELSE 'gap' END AS kind FROM bounties b LEFT JOIN bounty_gaps g ON g.id=b.id ORDER BY b.created DESC LIMIT 100")).rows));
 app.post('/api/bounties',authenticated,async(req,res)=>{
  if(!payments)return res.status(503).json({error:'USDC payments unavailable'});
  const b=z.object({question:z.string().trim().min(8).max(600),criteria:z.string().trim().min(8).max(1000),price:z.number().int().min(10000).max(1000000000),kind:z.enum(['answer','gap']).default('answer'),trial:uuid.optional()}).strict().parse(req.body);
  if(b.trial&&(b.kind!=='gap'||!await db.one("SELECT id FROM trial_orders WHERE id=? AND buyer=? AND state='paid' AND signature IS NOT NULL",[b.trial,req.wallet])))return res.status(404).json({error:'Paid trial not found'});
  const id=randomUUID();
  if(b.kind==='gap')await db.query('INSERT INTO bounty_gaps(id,trial_order) VALUES(?,?)',[id,b.trial||null]);
  try{await db.query("INSERT INTO bounties(id,buyer,question,criteria,price,created,state) VALUES(?,?,?,?,?,?,'open')",[id,req.wallet,b.question,b.criteria,b.price,Date.now()]);}catch(error){if(b.kind==='gap')await db.query('DELETE FROM bounty_gaps WHERE id=?',[id]);throw error;}res.status(201).json({id});
 });
 app.get('/api/bounties/:id',async(req,res)=>{
  const b=await lookup(req.params.id);if(!b)return res.sendStatus(404);
  const reports=(await db.query('SELECT id,owner,preview,created FROM bounty_reports WHERE bounty=? ORDER BY created',[b.id])).rows;
  const award=b.award?JSON.parse(b.award):null;
  if(b.state==='paid'&&req.wallet===b.buyer){for(const r of reports)if(award.selected.includes(r.id)){const submission=await storage.get(r.id);if(b.kind==='gap')r.cases=submission.cases;else r.answer=submission.answer;}}
  res.json({id:b.id,state:b.state,kind:b.kind,terms:termsFor(b),reports,selected:award?.selected||[],signature:b.signature});
 });
 app.post('/api/bounties/:id/reports',authenticated,async(req,res)=>{
  const b=await lookup(req.params.id);if(!b||b.state!=='open'||b.buyer===req.wallet)return res.status(409).json({error:'This bounty cannot accept your submission'});
  const body=z.object({dataset:uuid,preview:z.string().trim().min(8).max(400),answer:z.string().trim().min(20).max(b.kind==='gap'?100000:12000),consent:z.literal(true)}).parse(req.body);
  const d=await db.one('SELECT commitment FROM datasets WHERE id=? AND owner=?',[body.dataset,req.wallet]);if(!d)return res.status(403).json({error:'Choose a dataset you own'});
  if(await isPaused(db,body.dataset))return res.status(409).json({error:'Dataset access is paused'});
  let submission={answer:body.answer};
  if(b.kind==='gap'){
   try{submission={cases:parseBenchmark(body.answer)};}
   catch{return res.status(400).json({error:'Submit a JSON array of 5–20 cases with prompt and expectedAnswer. Each category needs at least five cases.'});}
  }
  const id=randomUUID();await storage.put(id,submission);
  try{const result=await db.query("INSERT INTO bounty_reports(id,bounty,owner,dataset,commitment,preview,created) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM bounties WHERE id=? AND state='open') AND NOT EXISTS (SELECT 1 FROM consent_state WHERE dataset=? AND paused=1) ON CONFLICT(bounty,owner) DO NOTHING RETURNING id",[id,b.id,req.wallet,body.dataset,d.commitment,body.preview,Date.now(),b.id,body.dataset]);
   if(!result.rows.length){await storage.remove(id);return res.status(409).json({error:'Bounty closed or you already submitted'});}
  }catch(e){await storage.remove(id);throw e}
  res.status(201).json({id});
 });
 app.post('/api/bounties/:id/award',authenticated,async(req,res)=>{
  const b=await lookup(req.params.id);if(!b||b.buyer!==req.wallet)return res.sendStatus(403);
  if(!payments||b.state==='paid')return res.status(409).json({error:'Bounty cannot be awarded'});
  const previous=b.award?JSON.parse(b.award):null;
  if(previous){
   const rpc=rpcClient(env.SOLANA_RPC_URL);
   if(await rpc('getBlockHeight',[{commitment:'finalized'}])<=previous.lastValidBlockHeight)return res.json(previous);
   // Before replacing an expired quote, rule out a payment finalized while the buyer was offline.
   if(!Number.isSafeInteger(previous.quoteSlot)||await rpc('getFirstAvailableBlock')>previous.quoteSlot)return res.status(409).json({error:'Payment history unavailable. Recover with your transaction signature.'});
   let before,complete=false;
   for(let page=0;page<10&&!complete;page++){
    const history=await rpc('getSignaturesForAddress',[b.buyer,{commitment:'finalized',limit:100,before}]);
    for(const entry of history){
     if(entry.slot<previous.quoteSlot){complete=true;break;}
     if(!entry.err&&entry.memo?.includes('DataLoom:v1:'+b.id+':')){
      await verify(entry.signature,previous.message,env.SOLANA_RPC_URL);
      await db.query("UPDATE bounties SET state='paid',signature=? WHERE id=? AND state='awarded'",[entry.signature,b.id]);
      return res.json({paid:true,signature:entry.signature});
     }
    }
    if(history.length<100)complete=true;else before=history.at(-1).signature;
   }
   if(!complete)return res.status(409).json({error:'Recover this award with its transaction signature.'});
  }
  const selected=z.array(uuid).min(1).max(5).parse(previous?.selected||req.body.selected).sort();
  if(new Set(selected).size!==selected.length)return res.sendStatus(400);
  const owners=[];for(const id of selected){const report=await db.one('SELECT owner FROM bounty_reports WHERE bounty=? AND id=?',[b.id,id]);if(!report)return res.sendStatus(400);owners.push(report.owner);}
  const terms=termsFor(b);
  const tx=await build({buyer:b.buyer,seller:owners[0],platform:env.PLATFORM_WALLET,price:b.price,id:b.id,commitment:hash(selected.join(',')),license:terms,bountyOwners:owners,rpcUrl:env.SOLANA_RPC_URL});
  const award={...tx,selected,owners,terms};const update=previous
   ?await db.query("UPDATE bounties SET award=? WHERE id=? AND state='awarded' AND award=? RETURNING id",[JSON.stringify(award),b.id,b.award])
   :await db.query("UPDATE bounties SET award=?,state='awarded' WHERE id=? AND state='open' RETURNING id",[JSON.stringify(award),b.id]);
  if(!update.rows.length)return res.status(409).json({error:'Award changed. Refresh the bounty.'});res.json(award);
 });
 app.post('/api/bounties/:id/confirm',authenticated,async(req,res)=>{
  const b=await lookup(req.params.id);if(!b||b.buyer!==req.wallet||!b.award)return res.sendStatus(403);
  const signature=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/).parse(req.body.signature);
  if(b.state==='paid'&&b.signature!==signature)return res.sendStatus(409);
  if(b.state!=='paid'){await verify(signature,JSON.parse(b.award).message,env.SOLANA_RPC_URL);await db.query("UPDATE bounties SET state='paid',signature=? WHERE id=? AND state='awarded'",[signature,b.id]);}
  res.json({paid:true,signature});
 });
}
