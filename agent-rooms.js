export function initAgentRooms({panel,api,requireIdentity,identity,escape,money}){
 const section=document.createElement('section');
 section.innerHTML='<h3>Private Data Rooms for Agents</h3><p>Combine active grants for at least two private datasets. Each contributor retains control of their source. Room calls share a spending cap and expire together.</p><form data-room-create><label>Project name<input name="name" required minlength="2" maxlength="80"></label><label>Licensed tools<select name="grants" multiple required size="4"></select></label><label>Shared cap in USDC<input name="cap" type="number" min="0.01" max="1000" step="0.01" required></label><label>Expires in days<input name="days" type="number" min="1" max="30" value="7" required></label><p>The selected tools’ contributor-approved purposes become the room’s permitted tasks.</p><button>Create room</button></form><div data-rooms></div><p data-room-feedback role="status"></p><label hidden data-room-key-label>Room API key<input readonly data-room-key></label>';
 panel.append(section);
 const form=section.querySelector('form'),list=section.querySelector('[data-rooms]'),feedback=section.querySelector('[data-room-feedback]'),keyLabel=section.querySelector('[data-room-key-label]'),key=section.querySelector('[data-room-key]');
 let grants=[];
 async function refresh(viewer,state){
  grants=state.grants.filter(g=>g.buyer===viewer&&!g.revoked);
  const {rooms}=await api('/api/my/agent-rooms');
  if(identity()!==viewer)return;
  form.elements.grants.innerHTML=grants.map(g=>`<option value="${escape(g.id)}">${escape(g.tool.name)} · ${money(g.tool.price)} USDC</option>`).join('');
  form.querySelector('button').disabled=grants.length<2;
  list.innerHTML=rooms.map(r=>`<article class="account-record"><h4>${escape(r.name)}</h4><p>${money(r.reservedOrSpent)} of ${money(r.cap)} USDC reserved or spent · expires ${new Date(r.expires).toLocaleString()}</p><p>${r.tasks.map(escape).join(' · ')}</p><p>${r.grants.map(g=>escape(g.name)+(g.revoked?' (revoked)':'')).join(', ')}</p>${r.revoked?'Revoked':`<button data-room-key-id="${escape(r.id)}">Create or rotate room key</button><button class="secondary" data-room-revoke="${escape(r.id)}">Revoke room</button>`}</article>`).join('')||'<p>No private data rooms.</p>';
 }
 form.addEventListener('submit',async event=>{
  event.preventDefault();const button=form.querySelector('button');button.disabled=true;
  try{
   const viewer=await requireIdentity(),data=new FormData(form),selected=data.getAll('grants');
   if(selected.length<2)throw Error('Select tools from at least two datasets.');
   const tasks=[...new Set(grants.filter(g=>selected.includes(g.id)).map(g=>g.tool.purpose))];
   await api('/api/my/agent-rooms',{name:data.get('name'),grants:selected,tasks,cap:Math.round(Number(data.get('cap'))*1e6),days:Number(data.get('days'))});
   if(identity()===viewer){feedback.textContent='Room created.';await refresh(viewer,await api('/api/my/agent-tools'));}
  }catch(error){feedback.textContent=error.message;}
  finally{button.disabled=false;}
 });
 section.addEventListener('click',async event=>{
  const button=event.target.closest('[data-room-key-id],[data-room-revoke]');if(!button)return;
  button.disabled=true;
  try{
   const viewer=await requireIdentity();
   const id=button.dataset.roomKeyId||button.dataset.roomRevoke;
   const response=await api('/api/my/agent-rooms/'+id+(button.dataset.roomKeyId?'/key':'/revoke'),{});
   if(identity()!==viewer)return;
   key.value=response.key||'';keyLabel.hidden=!response.key;
   if(response.key){key.focus();key.select();}
   await refresh(viewer,await api('/api/my/agent-tools'));
  }catch(error){feedback.textContent=error.message;}
  finally{button.disabled=false;}
 });
 return {refresh,clear(){list.replaceChildren();form.elements.grants.replaceChildren();key.value='';keyLabel.hidden=true;feedback.textContent='';grants=[];}};
}
