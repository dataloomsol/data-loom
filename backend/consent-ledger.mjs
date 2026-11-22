import {DATALOOM} from './settlement.mjs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

export const unpaused = 'NOT EXISTS (SELECT 1 FROM consent_state c WHERE c.dataset=d.id AND c.paused=1)';
export async function isPaused(db,id) {
  return Boolean(await db.one('SELECT dataset FROM consent_state WHERE dataset=? AND paused=1',[id]));
}

export function installConsentLedger(app,{db,authenticated,licenses,bountyTerms,gapTerms}) {
  app.get('/api/my/consent-ledger',authenticated,async(req,res)=>{
    const wallet=req.wallet;
    const {rows:datasets}=await db.query(`SELECT d.id,d.title,d.commitment,d.license,d.state,d.created,
      COALESCE(c.paused,0) AS paused,c.changed,q.enabled AS queries,q.consented AS query_consent,
      t.enabled AS trials,t.consented AS trial_consent
      FROM datasets d LEFT JOIN consent_state c ON c.dataset=d.id
      LEFT JOIN query_policies q ON q.dataset=d.id LEFT JOIN trial_policies t ON t.dataset=d.id
      WHERE d.owner=? ORDER BY d.created DESC`,[wallet]);
    res.json(datasets.map(d=>({...d,licenseTerms:licenses[d.license]})));
  });

  app.get('/api/datasets/:id/consent-ledger',authenticated,async(req,res)=>{
    const id=z.string().uuid().parse(req.params.id);
    const before=z.coerce.number().int().positive().optional().parse(req.query.before);
    const d=await db.one('SELECT id,license FROM datasets WHERE id=? AND owner=?',[id,req.wallet]);
    if(!d)return res.status(404).json({error:'Dataset not found'});
    const {rows}=await db.query(`
      SELECT o.id,'Dataset license' AS kind,o.state,o.created,o.signature,o.seller_amount AS amount,l.terms,NULL AS detail
        FROM orders o LEFT JOIN licenses l ON l.order_id=o.id WHERE o.dataset=?
      UNION ALL SELECT o.id,'AI answer',o.state,o.created,o.signature,o.seller_amount,r.terms,r.summary
        FROM query_orders o LEFT JOIN query_receipts r ON r.order_id=o.id WHERE o.dataset=?
      UNION ALL SELECT o.id,'Blind model trial',o.state,o.created,o.signature,NULL,o.terms,o.summary
        FROM trial_orders o WHERE o.dataset=?
      UNION ALL SELECT o.id,'Private benchmark pool',o.state,o.created,o.signature,p.amount,o.terms,NULL
        FROM trial_pool_sources p JOIN trial_orders o ON o.id=p.order_id WHERE p.dataset=? AND p.owner=?
      UNION ALL SELECT c.id,CASE WHEN b.id IS NULL THEN 'Private inference tool' ELSE 'Private batch inference' END,CASE WHEN c.signature IS NULL THEN 'prepared' ELSE 'paid' END,c.created,c.signature,(COALESCE(b.price,t.price)*70)/100,NULL,NULL
        FROM agent_calls c JOIN agent_grants g ON g.id=c.grant_id JOIN agent_tools t ON t.id=g.tool LEFT JOIN agent_batches b ON b.id=c.id
        WHERE t.dataset=? AND t.owner=? AND c.signature IS NOT NULL
      UNION ALL SELECT r.id,CASE WHEN g.id IS NULL THEN 'Bounty report' ELSE 'Dataset gap cases' END,b.state,r.created,b.signature,NULL,NULL,b.award
        FROM bounty_reports r JOIN bounties b ON b.id=r.bounty LEFT JOIN bounty_gaps g ON g.id=b.id WHERE r.dataset=?
      UNION ALL SELECT a.id,'Licensed download','used',a.created,NULL,NULL,
        (SELECT l.terms FROM licenses l WHERE l.dataset=a.resource AND l.buyer=a.wallet ORDER BY l.created LIMIT 1),NULL
        FROM audit a WHERE a.resource=? AND a.action='download' AND a.wallet<>?
      UNION ALL SELECT a.id,'Owner AI query','used',a.created,NULL,NULL,'Owner authorized conventional AI processing for this request.',NULL
        FROM audit a WHERE a.wallet=? AND a.action='external-ai-query' AND (',' || a.resource || ',') LIKE ?
      UNION ALL SELECT a.id,'Permission change',a.action,a.created,NULL,NULL,NULL,NULL
        FROM audit a WHERE a.resource=? AND a.wallet=? AND a.action IN ('pause-use','resume-use','publish','stop-future-sales','query-enabled','query-disabled','trial-enabled','trial-disabled')
    `,[id,id,id,id,req.wallet,id,req.wallet,id,id,req.wallet,req.wallet,'%,'+id+',%',id,req.wallet]);
    const events=rows.map(({detail,...row})=>{
      let terms=row.terms,amount=0n,state=row.state,signature=row.signature;
      const currency=row.kind==='AI answer'&&detail&&JSON.parse(detail).mint===DATALOOM?'DATALOOM':'USDC';
      if(row.kind==='Dataset license')terms||=licenses[d.license];
      if(row.kind==='Licensed download')terms||=licenses[d.license];
      if(row.kind==='Bounty report'||row.kind==='Dataset gap cases'){
        const award=detail?JSON.parse(detail):null;
        const index=award?.selected.indexOf(row.id)??-1;
        terms=award?.terms||(row.kind==='Dataset gap cases'?gapTerms:bountyTerms);
        if(index<0){state=row.state==='open'?'submitted':'not selected';signature=null;}
        else if(row.state==='paid'){
          const share=BigInt(award.summary.sellerAmount),count=BigInt(award.selected.length);
          amount=share/count+(BigInt(index)<share%count?1n:0n);
        }
      } else if(signature&&(state==='paid'||state==='answered')){
        amount=BigInt(row.amount??JSON.parse(detail).sellerAmount);
      }
      return {...row,created:Number(row.created),state,terms,signature,currency,amount:String(amount)};
    });
    const totals={USDC:0n,DATALOOM:0n};
    for(const event of events)totals[event.currency]+=BigInt(event.amount);
    events.sort((a,b)=>b.created-a.created||a.id.localeCompare(b.id));
    const page=before===undefined?events:events.filter(e=>e.created<=before);
    const end=page.length>50?page.findIndex((e,i)=>i>=50&&e.created!==page[49].created):page.length;
    const length=end<0?page.length:end;
    res.json({total:String(totals.USDC),totals:{USDC:String(totals.USDC),DATALOOM:String(totals.DATALOOM)},events:page.slice(0,length),nextBefore:page[length]?.created??null});
  });

  app.post('/api/datasets/:id/consent-pause',authenticated,async(req,res)=>{
    const id=z.string().uuid().parse(req.params.id);
    const {paused}=z.object({paused:z.boolean()}).strict().parse(req.body);
    const now=Date.now();
    const {rows}=await db.query(`INSERT INTO consent_state(dataset,paused,changed)
      SELECT id,?,? FROM datasets WHERE id=? AND owner=?
      ON CONFLICT(dataset) DO UPDATE SET paused=excluded.paused,changed=excluded.changed
      WHERE consent_state.paused<>excluded.paused RETURNING dataset`,[Number(paused),now,id,req.wallet]);
    if(rows.length)await db.query('INSERT INTO audit(id,wallet,action,resource,created) VALUES(?,?,?,?,?)',[randomUUID(),req.wallet,paused?'pause-use':'resume-use',id,now]);
    else if(!await db.one('SELECT id FROM datasets WHERE id=? AND owner=?',[id,req.wallet]))return res.status(404).json({error:'Dataset not found'});
    res.json({paused});
  });
}
