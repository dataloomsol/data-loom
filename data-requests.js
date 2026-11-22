export function initDataRequests({panel,api,requireIdentity,identity,escape,money}){
 const section=document.createElement('section');
 section.innerHTML='<h3>Private Data Requests</h3><p>Agents can ask for information under an active grant. Contributor replies are licensed only for the stated task. The buyer pays the tool’s USDC price to receive the reply.</p><div data-request-list></div><p data-request-feedback role="status"></p>';
 panel.append(section);
 const list=section.querySelector('[data-request-list]');
 const feedback=section.querySelector('[data-request-feedback]');
 async function refresh(viewer){
  const {requests}=await api('/api/my/data-requests');
  if(identity()!==viewer)return;
  list.innerHTML=requests.map(row=>`<article class="account-record"><h4>${escape(row.name)} · ${escape(row.state)}</h4><p>Task · ${escape(row.task)}</p><p>${escape(row.question)}</p><p>${money(row.price)} USDC · expires ${new Date(row.expires).toLocaleString()}</p>${
   row.owner===viewer&&row.state==='requested'&&!row.revoked&&row.expires>Date.now()?`<form data-respond="${escape(row.id)}"><label>Private response<textarea name="response" required maxlength="6000"></textarea></label><label><input name="consent" type="checkbox" required> I authorize this response only for the stated task, without training, publication or resale rights.</label><button>Submit private response</button></form>`:''
  }</article>`).join('')||'<p>No private data requests.</p>';
 }
 section.addEventListener('submit',async event=>{
  const form=event.target.closest('[data-respond]');
  if(!form)return;
  event.preventDefault();
  const button=form.querySelector('button');
  button.disabled=true;
  try{
   const viewer=await requireIdentity(),data=new FormData(form);
   await api('/api/my/data-requests/'+form.dataset.respond+'/respond',{response:data.get('response'),consent:data.has('consent')});
   if(identity()===viewer){feedback.textContent='Private response submitted. The buyer can now prepare checkout.';await refresh(viewer);}
  }catch(error){feedback.textContent=error.message;}
  finally{button.disabled=false;}
 });
 return {refresh,clear(){list.replaceChildren();feedback.textContent='';}};
}
