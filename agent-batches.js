import bs58 from 'bs58';

export function initAgentBatches({api,requireIdentity,escape,money,identity,walletState,refresh}){
 const el=id=>document.getElementById(id);
 const panel=el('agent-batch-panel'),form=el('agent-batch-create'),history=el('agent-batch-history'),feedback=el('agent-batch-feedback');
 const base='/api/agent/v1/batches';
 let grants=[],draft;
 const key=id=>'loom.agent.batch.signature.'+id;
 const schema=()=>{
  const tool=grants.find(grant=>grant.id===form.elements.grant.value)?.tool;
  el('agent-batch-schema').textContent=tool?'Fields per case: '+Object.entries(tool.inputSchema.properties)
   .map(([name,field])=>name+' ('+field.type+')').join(', ')+'. '+money(tool.price)+' USDC per case.':'Ask the contributor for a batch-enabled grant.';
 };
 form.elements.grant.onchange=schema;
 const run=async(button,action)=>{
  button.disabled=true;
  try{await action()}catch(error){feedback.textContent=error.message}
  finally{button.disabled=false}
 };
 const render=(state,viewer)=>{
  const previous=form.elements.grant.value;
  grants=state.grants.filter(g=>g.buyer===viewer&&g.batchEnabled&&!g.revoked);
  form.elements.grant.innerHTML=grants.map(g=>`<option value="${escape(g.id)}">${escape(g.label)} · ${escape(g.tool.name)}</option>`).join('')||
   '<option value="">No batch-enabled grants</option>';
  if(grants.some(g=>g.id===previous))form.elements.grant.value=previous;
  form.querySelector('button').disabled=!state.enabled||!grants.length;
  schema();
  history.innerHTML=(state.batches||[]).map(batch=>`<article class="account-record">
   <h4>${escape(batch.name)} · ${batch.caseCount} cases</h4>
   <p>${escape(batch.state)} · ${money(batch.price)} USDC</p>
   ${batch.state==='ready'?`<button type="button" data-batch-pay="${escape(batch.id)}">Review &amp; pay</button>
    <button type="button" data-batch-cancel="${escape(batch.id)}">Cancel batch</button>`:''}
   ${batch.state==='prepared'?`<button type="button" data-batch-pay="${escape(batch.id)}">Review &amp; pay</button>
    <button type="button" data-batch-recover="${escape(batch.id)}">Check payment or expiry</button>
    <form data-batch-confirm="${escape(batch.id)}"><label>Existing Solana signature<input name="signature" required></label><button>Verify payment</button></form>`:''}
   ${batch.state==='paid'?`<button type="button" data-batch-download="${escape(batch.id)}">Download decisions &amp; receipts</button>`:''}
   ${batch.state==='failed'?'<p>The batch did not complete. Its USDC allowance was released.</p>':''}
  </article>`).join('')||'<p>No batches submitted.</p>';
 };
 const clear=()=>{
  grants=[];draft=null;form.reset();form.elements.grant.replaceChildren();history.replaceChildren();feedback.textContent='';schema();
 };
 function download(result){
  if(result.state!=='paid'||!Array.isArray(result.results))throw Error('A finalized payment is required for the batch download');
  const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
  const link=document.createElement('a');
  link.href=url;link.download='data-loom-batch-'+result.id+'.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 el('agent-batch-refresh').onclick=event=>run(event.currentTarget,async()=>refresh(await requireIdentity()));
 form.onsubmit=event=>{
  event.preventDefault();
  void run(event.submitter||form.querySelector('button'),async()=>{
   const viewer=await requireIdentity(),data=new FormData(form),file=data.get('cases'),grant=data.get('grant');
   if(file.size>512000)throw Error('Choose a JSON file under 500 KB');
   let cases;
   try{cases=JSON.parse(await file.text())}catch{throw Error('Upload a JSON array of cases')}
   if(!Array.isArray(cases)||cases.length<2||cases.length>200)throw Error('Provide 2–200 case objects');
   const bytes=new TextEncoder().encode(grant+'\n'+JSON.stringify(cases));
   const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
   if(draft?.fingerprint!==fingerprint)draft={fingerprint,requestId:crypto.randomUUID()};
   const result=await api(base,{grant,requestId:draft.requestId,cases});
   if(identity()!==viewer)return;
   draft=null;form.elements.cases.value='';
   feedback.textContent=result.state==='running'?'Batch accepted. Refresh history to check when it is ready for payment.':
    'Batch status: '+result.state+'. See batch history.';
   await refresh(viewer);
  });
 };
 async function confirm(id,signature){
  return api('/api/agent/v1/calls/'+id+'/confirm',{signature});
 }
 history.addEventListener('submit',event=>{
  const id=event.target.dataset.batchConfirm;
  if(!id)return;
  event.preventDefault();
  void run(event.submitter||event.target.querySelector('button'),async()=>{
   const viewer=await requireIdentity();
   const result=await confirm(id,new FormData(event.target).get('signature').trim());
   if(identity()!==viewer)return;
   localStorage.removeItem(key(id));await refresh(viewer);download(result);
  });
 });
 history.addEventListener('click',event=>{
  const button=event.target.closest('[data-batch-pay],[data-batch-download],[data-batch-recover],[data-batch-cancel]');
  if(!button)return;
  void run(button,async()=>{
   const viewer=await requireIdentity();
   const {batchPay,batchDownload,batchRecover,batchCancel}=button.dataset;
   if(batchDownload){const result=await api(base+'/'+batchDownload);if(identity()===viewer)download(result);return}
   if(batchCancel){
    await api(base+'/'+batchCancel+'/cancel',{});await refresh(viewer);
    feedback.textContent='Batch cancelled and its USDC allowance released.';return;
   }
   if(batchRecover){
    const result=await api('/api/agent/v1/calls/'+batchRecover+'/recover',{});
    if(identity()!==viewer)return;
    if(result.state==='paid'||result.state==='ready')localStorage.removeItem(key(batchRecover));
    await refresh(viewer);
    feedback.textContent=result.state==='paid'?'Payment recovered. The batch can now be downloaded.':result.state==='ready'?
     'Previous quote expired. Review a new checkout or cancel the batch.':'Quote is still valid. Verify any payment you already sent.';
    return;
   }
   const {wallet,account}=walletState();
   if(account?.address!==viewer||!wallet?.features['solana:signAndSendTransaction'])throw Error('Connect the signed-in Solana wallet first');
   if(localStorage.getItem(key(batchPay)))throw Error('A payment signature is already saved. Check payment or enter the signature from your wallet.');
   const quote=await api(base+'/'+batchPay+'/checkout',{});
   if(identity()!==viewer||walletState().account?.address!==viewer)throw Error('Wallet changed');
   if(quote.state==='paid'){download(quote);return}
   if(!quote.simulation||quote.state!=='prepared')throw Error('Checkout simulation is unavailable');
   const s=quote.summary;
   if(!window.confirm(`Pay ${money(s.price)} USDC on Solana mainnet for ${quote.caseCount} decisions? Contributor: ${money(s.sellerAmount)} USDC (${s.seller}). Data Loom: ${money(s.platformAmount)} USDC (${s.platform}). Your wallet also pays network fees and any token account rent.`))return;
   const sent=await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({account,chain:'solana:mainnet',
    transaction:Uint8Array.from(atob(quote.transaction),c=>c.charCodeAt(0))});
   if(!sent?.[0]?.signature)throw Error('No signature returned. Check wallet history before retrying.');
   const signature=bs58.encode(sent[0].signature);
   localStorage.setItem(key(batchPay),signature);
   try{
    const result=await confirm(batchPay,signature);
    localStorage.removeItem(key(batchPay));
    if(identity()===viewer){await refresh(viewer);download(result)}
   }catch{if(identity()===viewer){await refresh(viewer);feedback.textContent='Payment submitted. Check payment or verify the existing signature once it finalizes.'}}
  });
 });
 return {render,clear};
}
