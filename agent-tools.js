import {initDecisionAppeals} from "./decision-appeals.js";
import {initDatasetDiff} from "./dataset-diff.js";
import {initBenchmarkBuilder} from './benchmark-builder.js';
import {initDataEscrow} from './data-escrow.js';
import {initEvidencePacks} from './evidence-packs.js';
import {initAgentRooms} from './agent-rooms.js';
import {initDataRequests} from './data-requests.js';
import {initAgentBatches} from './agent-batches.js';
export function initAgentTools({api,requireIdentity,escape,money,identity,walletState}){
 const el=id=>document.getElementById(id);
 const panel=el('agent-tools'),feedback=el('agent-feedback'),account=el('agent-account');
 const create=el('agent-create'),keyBox=el('agent-key-box'),key=el('agent-key'),result=el('agent-call-result');
 const lines=value=>value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
 const amount=value=>Math.round(Number(value)*1e6);
 const run=async (button,fn)=>{
  button.disabled=true;
  try{await fn()}catch(error){feedback.textContent=error.message}
  finally{button.disabled=false}
 };
 const builder=initBenchmarkBuilder({panel,api,requireIdentity,identity,escape});
 const datasetDiff=initDatasetDiff({panel,api,requireIdentity,identity});
 const escrow=initDataEscrow({panel,api,requireIdentity,identity,escape,money,walletState});
 const packs=initEvidencePacks({panel,api,requireIdentity,identity});
 const appeals=initDecisionAppeals({panel,api,requireIdentity,identity});
 const rooms=initAgentRooms({panel,api,requireIdentity,identity,escape,money});
 const requests=initDataRequests({panel,api,requireIdentity,identity,escape,money});
 async function refresh(viewer){
  await requests.refresh(viewer);
  const [state,datasets]=await Promise.all([api('/api/my/agent-tools'),api('/api/my/datasets')]);
  if(identity()!==viewer)return;
  await rooms.refresh(viewer,state);
  if(identity()!==viewer)return;
  datasetDiff.setDatasets(datasets);
  create.elements.dataset.innerHTML=datasets.filter(d=>d.state!=='published').map(d=>`<option value="${escape(d.id)}">${escape(d.title)}</option>`).join('')||'<option value="">Store a private dataset first</option>';
  el('agent-tool-list').innerHTML=state.tools.map(tool=>`<form class="account-record" data-grant-tool="${escape(tool.id)}">
   <h4>${escape(tool.name)} · ${money(tool.price)} USDC per call</h4><p>${escape(tool.purpose)}</p>
   <label>Agent name<input name="label" minlength="2" maxlength="80" required></label>
   <label>Buyer Solana wallet<input name="buyer" required></label>
   <label>Total USDC cap<input name="cap" type="number" min="0.01" max="1000" step="0.01" required></label>
   <label class="consent"><input name="batch" type="checkbox"> Allow this buyer to submit private batches of up to 200 cases.</label>
   <button class="secondary">Grant access</button></form>`).join('')||'<p>No tools created.</p>';
  el('agent-grant-list').innerHTML=state.grants.map(grant=>`<article class="account-record">
   <h4>${escape(grant.label)} · ${escape(grant.tool.name)}</h4>
   <p>${grant.revoked?'Revoked':'Active'}${grant.batchEnabled?' · Batch access':''} · ${money(grant.reservedOrSpent)} of ${money(grant.cap)} USDC reserved or paid</p>
   <p>Buyer <code>${escape(grant.buyer)}</code></p>
   ${grant.revoked?'':`${grant.buyer===viewer?`<button class="secondary" data-agent-key="${escape(grant.id)}">Create or rotate API key</button>`:''}
     ${grant.owner===viewer?`<button class="secondary" data-memory-policy="${escape(grant.id)}">Set memory retention</button><button class="secondary" data-evidence-policy="${escape(grant.id)}">Set evidence disclosure</button>`:''}
    <button class="secondary" data-agent-revoke="${escape(grant.id)}">Revoke access</button>`}
  </article>`).join('')||'<p>No agent grants.</p>';
  el('agent-calls').innerHTML=state.calls.map(call=>`<article class="account-record"><h4>${escape(call.name)} · ${escape(call.state)}</h4>
   ${call.state==='paid'?`<button class="secondary" data-agent-result="${escape(call.id)}">View paid result</button>`:
    call.state==='prepared'?`<form data-agent-confirm="${escape(call.id)}"><label>Existing Solana signature<input name="signature" required></label><button class="secondary">Verify payment</button></form>
     <button class="secondary" data-agent-recover="${escape(call.id)}">Recover or release expired checkout</button>`:''}
   </article>`).join('');
  batches.render(state,viewer);
  account.hidden=false;
  feedback.textContent=state.enabled?'Verified confidential inference and Solana USDC payments are ready.':'Agent calls require verified confidential inference and Solana USDC payments.';
 }
 function showCall(call){
  result.textContent=call.state==='paid'?JSON.stringify({output:call.output,evidence:call.evidence,source:call.source},null,2):
   call.state==='expired'?'Expired checkout released. Its reserved amount is available again.':'Checkout is still valid. Verify any existing payment before submitting another call.';
 }
 const batches=initAgentBatches({api,requireIdentity,escape,money,identity,walletState,refresh});
 el('agent-refresh').onclick=event=>run(event.currentTarget,async()=>refresh(await requireIdentity()));
 panel.addEventListener('submit',event=>{
  const form=event.target;
  if(form!==create&&!form.dataset.grantTool&&!form.dataset.agentConfirm)return;
  event.preventDefault();
  void run(event.submitter||form.querySelector('button'),async()=>{
   const viewer=await requireIdentity(),data=new FormData(form);
   if(form===create){
    const fields=lines(data.get('fields')).map(line=>{
     const parts=line.split(':').map(value=>value.trim());
     if(parts.length!==2)throw Error('Use one name:type per line');
     return {name:parts[0],type:parts[1]};
    });
    await api('/api/my/agent-tools',{dataset:data.get('dataset'),name:data.get('name'),purpose:data.get('purpose'),
     fields,decisions:lines(data.get('decisions')),price:amount(data.get('price')),consent:true});
   }else if(form.dataset.grantTool){
    await api('/api/my/agent-tools/'+form.dataset.grantTool+'/grants',{label:data.get('label'),buyer:data.get('buyer').trim(),cap:amount(data.get('cap')),batch:data.has('batch')});
   }else{
    const call=await api('/api/agent/v1/calls/'+form.dataset.agentConfirm+'/confirm',{signature:data.get('signature').trim()});
    if(identity()===viewer)showCall(call);
   }
   form.reset();
   await refresh(viewer);
  });
 });
 panel.addEventListener('click',event=>{
  const button=event.target.closest('[data-evidence-policy],[data-memory-policy],[data-agent-key],[data-agent-revoke],[data-agent-result],[data-agent-recover]');
  if(!button)return;
  void run(button,async()=>{
   const viewer=await requireIdentity();
   if(button.dataset.evidencePolicy){
    const value=prompt('Evidence permission: days,maxReasonChars. Days 0 disables downloads; maxReasonChars 0 discloses decisions only. Example: 7,200');
    if(value===null)return;
    const [days,maxReasonChars]=value.split(',').map(Number);
    if(!Number.isInteger(days)||days<0||days>30||!Number.isInteger(maxReasonChars)||maxReasonChars<0||maxReasonChars>2000)throw Error('Use days 0–30 and reason characters 0–2000.');
    await api('/api/my/agent-grants/'+button.dataset.evidencePolicy+'/evidence-policy',{days,maxReasonChars});
    feedback.textContent='Evidence disclosure updated.';return;
   }
   if(button.dataset.memoryPolicy){
    const value=prompt('Allow agents to retain paid decisions for how many days? Enter 0 to stop retrieval, or 1–30.');
    if(value===null)return;
    const days=Number(value);
    if(!Number.isInteger(days)||days<0||days>30)throw Error('Enter a whole number from 0 to 30');
    await api('/api/my/agent-grants/'+button.dataset.memoryPolicy+'/memory-policy',{days});
    feedback.textContent='Memory retention updated to '+days+' days.';
    return;
   }
   const {agentKey,agentRevoke,agentResult,agentRecover}=button.dataset;
   if(agentKey){
    const data=await api('/api/my/agent-grants/'+agentKey+'/key',{});
    if(identity()===viewer){key.value=data.key;keyBox.hidden=false;key.focus();key.select()}
   }else if(agentRevoke){
    await api('/api/my/agent-grants/'+agentRevoke+'/revoke',{});
    key.value='';keyBox.hidden=true;
    await refresh(viewer);
   }else{
    const call=agentRecover?await api('/api/agent/v1/calls/'+agentRecover+'/recover',{}):await api('/api/agent/v1/calls/'+agentResult);
    if(identity()===viewer)showCall(call);
    if(agentRecover)await refresh(viewer);
   }
  });
 });
 document.addEventListener('loom-identity-change',()=>{
  key.value='';keyBox.hidden=true;result.textContent='';account.hidden=true;feedback.textContent='';
  batches.clear();requests.clear();rooms.clear();packs.clear();escrow.clear();builder.clear();datasetDiff.clear();appeals.clear();
  for(const id of ['agent-tool-list','agent-grant-list','agent-calls'])el(id).replaceChildren();
 });
}
