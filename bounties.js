import bs58 from 'bs58';
export function initBounties({api,requireIdentity,escape,money,identity,walletState}){
 const element=id=>document.getElementById(id);
 const list=element('bounty-list'),detail=element('bounty-detail'),feedback=element('bounty-feedback');
 const createForm=element('bounty-create');
 const draftNote=element('gap-draft-note');
 let offers=[],current=null,loaded,trialId=null;
 const resetTrial=()=>{trialId=null;draftNote.hidden=true;draftNote.textContent='';};
 createForm.elements.kind.onchange=resetTrial;
 document.addEventListener('loom-gap-bounty-draft',event=>{
  const {id,category}=event.detail;
  trialId=id;
  createForm.elements.kind.value='gap';
  createForm.elements.question.value='Request new evaluation cases for '+category;
  createForm.elements.criteria.value='Provide 5–20 original evaluation cases with clear prompts and reference answers. Describe the intended language, scenarios, and coverage.';
  draftNote.textContent='Draft from your paid trial. Review the public brief before publishing. The trial ID and scorecard stay private.';
  draftNote.hidden=false;
  createForm.closest('details').open=true;
  createForm.scrollIntoView({behavior:'smooth',block:'start'});
  createForm.elements.question.focus({preventScroll:true});
 });
 const run=async fn=>{try{feedback.textContent='';await fn();}catch(e){feedback.textContent=e.message;}};
 async function refresh(){
  offers=await api('/api/bounties');
  list.innerHTML=offers.length?offers.map(b=>`<p><button type="button" data-bounty="${escape(b.id)}">${escape(b.question)}</button> · ${b.kind==='gap'?'Dataset Gap':'Answer'} · ${money(b.price)} USDC · ${escape(b.state)}</p>`).join(''):'<p>No bounties yet. Publish the first question.</p>';
 }
 async function open(id){
  const b=offers.find(x=>x.id===id);if(!b)return;
  const viewer=identity();const data=await api('/api/bounties/'+id);if(identity()!==viewer)return;current=b;loaded=data;
  const buyer=identity()===b.buyer, gap=b.kind==='gap';
  detail.innerHTML=`<p class="eyebrow">${gap?'DATASET GAP BOUNTY':'ANSWER BOUNTY'}</p><h3>${escape(b.question)}</h3><p>${escape(b.criteria)}</p><p>${escape(data.terms)}</p><p>Total offer: ${money(b.price)} USDC · ${escape(data.state)}</p>
  <p>Public proposals · ${data.reports.length}</p>
  ${data.reports.map(r=>`<article><label>${buyer&&data.state==='open'?`<input type="checkbox" name="award-report" value="${escape(r.id)}">`:''}${escape(r.preview)}</label><small>Contributor: ${escape(r.owner)}</small>${r.answer?`<p>${escape(r.answer)}</p>`:''}${r.cases?`<button type="button" data-cases="${escape(r.id)}">Download ${r.cases.length} evaluation cases</button>`:''}</article>`).join('')}
  ${data.state==='open'&&!buyer?`<button data-act="submit">${gap?'Contribute private cases':'Contribute a report'}</button>`:''}
  ${buyer&&data.reports.length&&data.state!=='paid'?'<button data-act="award">Review award and pay</button>':''}
  ${buyer&&data.state==='awarded'?'<form id="bounty-recover"><label>Submitted transaction signature<input name="signature" required></label><button>Verify payment</button></form>':''}
  ${!identity()?'<button data-act="login">Sign in to manage</button>':''}
  ${data.signature?`<p><a href="https://explorer.solana.com/tx/${encodeURIComponent(data.signature)}">View finalized payment</a></p>`:''}`;
 }
 async function sync(){await refresh();if(current)await open(current.id);}
 element('bounty-refresh').onclick=()=>run(sync);
 list.onclick=e=>{if(e.target.dataset.bounty)void run(()=>open(e.target.dataset.bounty));};
 createForm.onsubmit=e=>{e.preventDefault();const f=e.target;void run(async()=>{
  await requireIdentity();const fields=new FormData(f);const price=Math.round(Number(fields.get('reward'))*1e6);
  const {id}=await api('/api/bounties',{question:fields.get('question'),criteria:fields.get('criteria'),price,kind:fields.get('kind'),...(trialId?{trial:trialId}:{})});
  f.reset();resetTrial();await refresh();await open(id);feedback.textContent='Bounty published. Payment is due when you award reports.';
 });};
 detail.onclick=e=>{
  const download=e.target.closest('[data-cases]');
  if(download){
   const report=loaded?.reports.find(r=>r.id===download.dataset.cases);
   if(!report?.cases||identity()!==current?.buyer)return;
   const url=URL.createObjectURL(new Blob([JSON.stringify(report.cases,null,2)],{type:'application/json'}));
   const link=document.createElement('a');
   link.href=url;
   link.download='dataloom-gap-'+report.id+'.json';
   link.click();
   setTimeout(()=>URL.revokeObjectURL(url),1000);
   return;
  }
  const action=e.target.dataset.act;if(!action)return;void run(async()=>{
  const me=await requireIdentity();if(action==='login')return open(current.id);
  if(action==='submit'){
   if(me===current.buyer)return open(current.id);
   const datasets=await api('/api/my/datasets');if(!datasets.length)throw Error('Save a dataset in your account before submitting a report.');
   const gap=current.kind==='gap';
   e.target.disabled=true;detail.insertAdjacentHTML('beforeend',`<form id="bounty-report"><label>Your dataset<select name="dataset">${datasets.map(d=>`<option value="${escape(d.id)}">${escape(d.title)}</option>`).join('')}</select></label><label>Public proposal<textarea name="preview" minlength="8" maxlength="400" required></textarea></label><label>${gap?'Private cases JSON (5–20 cases, with prompt, expectedAnswer and optional category)':'Private report for the buyer'}<textarea name="answer" minlength="20" maxlength="${gap?100000:12000}" required></textarea></label><label><input type="checkbox" required> ${gap?'I own these cases and authorize delivery to the buyer for internal model evaluation after payment.':'I authorize delivery of this report after payment. My source file stays private.'}</label><button>${gap?'Submit private cases':'Submit report'}</button></form>`);return;
  }
  if(action==='award'){
   const selected=loaded.state==='awarded'?loaded.selected:[...detail.querySelectorAll('[name="award-report"]:checked')].map(el=>el.value);
   if(!selected.length||selected.length>5)throw Error('Select one to five reports to receive the award.');
   const {wallet,account}=walletState();const feature=wallet?.features['solana:signAndSendTransaction'];
   if(!feature||account?.address!==me)throw Error('Connect the buyer wallet to pay this award.');
   if(!window.confirm(`Award ${money(current.price)} USDC? The selected ${selected.length} contributor(s) share 70%. Data Loom receives 30%. You also pay Solana fees and any token-account rent. Preparing locks your selection.`))return;
   e.target.disabled=true;
   try{const award=await api('/api/bounties/'+current.id+'/award',{selected});if(award.paid)return sync();
    const result=await feature.signAndSendTransaction({account,chain:'solana:mainnet',transaction:Uint8Array.from(atob(award.transaction),c=>c.charCodeAt(0))});
    const signature=bs58.encode(result[0].signature);localStorage.setItem('loom.bounty.tx.'+current.id,signature);
    await api('/api/bounties/'+current.id+'/confirm',{signature});await sync();
   }finally{await open(current.id);const field=detail.querySelector('[name="signature"]');if(field)field.value=localStorage.getItem('loom.bounty.tx.'+current.id)||'';}
  }
 });};
 detail.onsubmit=e=>{e.preventDefault();const f=e.target;void run(async()=>{
  const data=Object.fromEntries(new FormData(f));await requireIdentity();
  if(f.id==='bounty-report')await api('/api/bounties/'+current.id+'/reports',{...data,consent:true});
  else if(f.id==='bounty-recover')await api('/api/bounties/'+current.id+'/confirm',data);
  await sync();
 });};
 document.addEventListener('loom-identity-change',()=>{detail.replaceChildren();loaded=null;resetTrial();});
 window.addEventListener('hashchange',()=>{if(location.hash==='#marketplace')void run(sync);});
 element('bounty-board').addEventListener('focusin',()=>{if(!offers.length&&!list.textContent)void run(refresh);},{once:true});
 document.addEventListener('click',e=>{if(e.target.closest('[data-view="marketplace"]'))void run(sync);});
 if(location.hash==='#marketplace')void run(refresh);
}
