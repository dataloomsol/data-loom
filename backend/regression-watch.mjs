import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {isPaused} from './consent-ledger.mjs';
const uuid=z.string().uuid(),day=86400000;
export function compareTrials(baseline,current,threshold){
 if(baseline.scoring!==current.scoring)throw Error('Scoring method changed');
 return baseline.models.map(b=>{const c=current.models.find(m=>m.model===b.model);if(!c||c.total!==b.total)throw Error('Benchmark or model mismatch');
  const deltaPoints=Math.round((c.accuracy-b.accuracy)*10000)/100;
  return {model:b.model,baselineAccuracy:b.accuracy,currentAccuracy:c.accuracy,deltaPoints,regressed:deltaPoints<0&&-deltaPoints>=threshold,categories:Object.entries(b.categories).map(([name,v])=>{const n=c.categories[name];if(!n||n.total!==v.total)throw Error('Category mismatch');return {name,deltaPoints:Math.round((n.correct/n.total-v.correct/v.total)*10000)/100}})};
 });
}
export async function installRegressionWatch(app,{db,storage,authenticated,enabled,prepareTrial,schedule=true,now=Date.now}){
 await db.query('CREATE TABLE IF NOT EXISTS regression_watches(id TEXT PRIMARY KEY,buyer TEXT NOT NULL,baseline TEXT NOT NULL UNIQUE,dataset TEXT NOT NULL,commitment TEXT NOT NULL,cadence INTEGER NOT NULL,threshold INTEGER NOT NULL,max_price BIGINT NOT NULL,paused INTEGER NOT NULL,next_run BIGINT NOT NULL,notice TEXT NOT NULL,created BIGINT NOT NULL)');
 await db.query('CREATE TABLE IF NOT EXISTS regression_runs(id TEXT PRIMARY KEY,watch TEXT NOT NULL,created BIGINT NOT NULL)');
 let busy=false;
 async function tick(){if(busy||!enabled)return;busy=true;try{
  const due=(await db.query('SELECT * FROM regression_watches WHERE paused=0 AND next_run<=? ORDER BY next_run LIMIT 20',[now()])).rows;
  for(const w of due){
   // Claim each due interval before any asynchronous inference. A restart cannot duplicate it.
   const claim=await db.query('UPDATE regression_watches SET next_run=? WHERE id=? AND paused=0 AND next_run=? RETURNING id',[now()+Number(w.cadence)*day,w.id,w.next_run]);if(!claim.rows.length)continue;
   let notice='';try{
    const p=await db.one('SELECT d.commitment,p.price,p.enabled FROM datasets d JOIN trial_policies p ON p.dataset=d.id WHERE d.id=?',[w.dataset]);
    if(!p||!p.enabled||await isPaused(db,w.dataset))notice='Contributor has paused or disabled new evaluations.';
    else if(p.commitment!==w.commitment)notice='Dataset version changed. Create a new baseline.';
    else if(Number(p.price)>Number(w.max_price))notice='Current price exceeds your per-run cap.';
    else {const b=await db.one('SELECT models FROM trial_orders WHERE id=?',[w.baseline]);const r=await prepareTrial(w.buyer,{dataset:w.dataset,models:JSON.parse(b.models),consent:true},{commitment:w.commitment,maxPrice:Number(w.max_price)});
     if(r.status===202){await db.query('INSERT INTO regression_runs(id,watch,created) VALUES(?,?,?)',[r.data.id,w.id,now()]);notice='Evaluation preparing. Review trial history for checkout. Each run needs wallet approval.';}else notice=r.data.error;
    }
   }catch{notice='Evaluation could not start. Existing scorecards are preserved.'}
   await db.query('UPDATE regression_watches SET notice=? WHERE id=?',[notice,w.id]);
  }
 }finally{busy=false}}
 app.get('/api/regression-watch',async(q,s)=>s.json({enabled,cadences:['daily','weekly'],payments:'Wallet approval required for every run',modelVersions:'Compares configured model IDs over time. Exact model weight versions are not attested.'}));
 app.post('/api/regression-watches',authenticated,async(q,s)=>{
  const b=z.object({baseline:uuid,cadence:z.enum(['daily','weekly']),threshold:z.number().int().min(1).max(100),maxPrice:z.number().int().min(10000).max(1000000000),consent:z.literal(true)}).strict().parse(q.body);
  const o=await db.one("SELECT * FROM trial_orders WHERE id=? AND buyer=? AND state='paid'",[b.baseline,q.wallet]);if(!o||o.dataset===o.id||JSON.parse(o.models).length!==2||(await storage.get(o.id)).impact)return s.status(404).json({error:'A paid single-benchmark baseline scorecard is required'});
  if(await db.one('SELECT id FROM regression_watches WHERE baseline=?',[o.id]))return s.status(409).json({error:'This baseline already has a watch'});
  const count=await db.one('SELECT COUNT(*) AS total FROM regression_watches WHERE buyer=?',[q.wallet]);if(Number(count.total)>=3)return s.status(409).json({error:'Maximum three saved watches per wallet. Remove one first.'});
  if(b.maxPrice<Number(o.price))return s.status(400).json({error:'Price cap must cover the baseline price'});
  const id=randomUUID(),cadence=b.cadence==='daily'?1:7;
  await db.query('INSERT INTO regression_watches(id,buyer,baseline,dataset,commitment,cadence,threshold,max_price,paused,next_run,notice,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,q.wallet,o.id,o.dataset,o.commitment,cadence,b.threshold,b.maxPrice,0,now()+cadence*day,'Scheduled. Every new scorecard requires separate wallet payment.',now()]);s.json({id});
 });
 app.post('/api/regression-watches/:id',authenticated,async(q,s)=>{const b=z.object({paused:z.boolean()}).strict().parse(q.body);const w=await db.one('SELECT cadence FROM regression_watches WHERE id=? AND buyer=?',[uuid.parse(q.params.id),q.wallet]);if(!w)return s.status(404).json({error:'Watch not found'});const r=await db.query('UPDATE regression_watches SET paused=?,next_run=? WHERE id=? AND buyer=? RETURNING id',[Number(b.paused),now()+Number(w.cadence)*day,uuid.parse(q.params.id),q.wallet]);if(!r.rows.length)return s.status(404).json({error:'Watch not found'});s.json({ok:true})});
 app.post('/api/regression-watches/:id/remove',authenticated,async(q,s)=>{const id=uuid.parse(q.params.id),r=await db.query('DELETE FROM regression_watches WHERE id=? AND buyer=? RETURNING id',[id,q.wallet]);if(!r.rows.length)return s.status(404).json({error:'Watch not found'});await db.query('DELETE FROM regression_runs WHERE watch=?',[id]);s.json({ok:true})});
 app.get('/api/my/regression-watches',authenticated,async(q,s)=>{
  const watches=(await db.query('SELECT w.*,d.title FROM regression_watches w JOIN datasets d ON d.id=w.dataset WHERE w.buyer=? ORDER BY w.created DESC',[q.wallet])).rows,out=[];
  for(const w of watches){const baseline=await storage.get(w.baseline),runs=(await db.query('SELECT r.id,r.created,j.state AS job_state,o.state AS order_state,o.commitment FROM regression_runs r LEFT JOIN trial_jobs j ON j.id=r.id LEFT JOIN trial_orders o ON o.id=r.id WHERE r.watch=? ORDER BY r.created DESC LIMIT 30',[w.id])).rows,history=[];
   for(const r of runs){const item={id:r.id,created:Number(r.created),state:r.order_state||r.job_state||'failed'};if(item.state==='paid'){if(r.commitment!==w.commitment)throw Error('Benchmark version mismatch');item.comparison=compareTrials(baseline,await storage.get(r.id),Number(w.threshold));item.alert=item.comparison.some(m=>m.regressed)}history.push(item)}
   out.push({id:w.id,title:w.title,baseline:w.baseline,commitment:w.commitment,cadence:Number(w.cadence),threshold:Number(w.threshold),maxPrice:String(w.max_price),paused:!!w.paused,nextRun:Number(w.next_run),notice:w.notice,runs:history});
  }s.json({enabled,watches:out});
 });
 if(schedule){const timer=setInterval(()=>void tick().catch(()=>{}),60000);timer.unref();app.on('loom-close',()=>clearInterval(timer));}
 return {tick};
}
