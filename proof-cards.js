export function initProofCards({api,toast}){
 const dialog=document.createElement('dialog');
 dialog.innerHTML='<form method="dialog"><button>Close</button></form><h2>Share Proof Card</h2><p>Anyone with the link can see the dataset version, purchase terms and recorded verification status.</p><label><input type="checkbox"> Publish the answer text on this card</label><p><button data-save>Create link</button> <button data-revoke>Revoke link</button></p><p><a target="_blank" rel="noopener noreferrer"></a> <button data-copy>Copy link</button></p><p role="status"></p>';
 document.body.append(dialog);
 const checkbox=dialog.querySelector('input'),save=dialog.querySelector('[data-save]'),revoke=dialog.querySelector('[data-revoke]'),copy=dialog.querySelector('[data-copy]'),link=dialog.querySelector('a'),note=dialog.querySelector('[role=status]');
 let endpoint;
 function render(state){
  checkbox.checked=state.includeAnswer;save.textContent=state.path?'Save sharing settings':'Create link';
  revoke.hidden=copy.hidden=link.hidden=!state.path;
  link.removeAttribute('href');link.textContent='';
  if(state.path){link.href=new URL(state.path,location.origin).href;link.textContent='Open published card ↗';}
 }
 document.addEventListener('loom-identity-change',()=>{endpoint=null;if(dialog.open)dialog.close();});
 document.addEventListener('click',async e=>{
  const button=e.target.closest('[data-proof-card]');if(!button)return;
  const target='/api/query-orders/'+encodeURIComponent(button.dataset.proofCard)+'/proof-card';endpoint=target;
  try{const state=await api(target);if(endpoint!==target)return;render(state);note.textContent='';dialog.showModal();}catch(err){toast(err.message);}
 });
 async function update(remove){
  const target=endpoint;save.disabled=revoke.disabled=true;
  try{const state=remove?await api(target,undefined,'DELETE'):await api(target,{includeAnswer:checkbox.checked});if(endpoint===target){render(state);note.textContent=remove?'Link revoked.':'Sharing settings saved.';}}
  catch(err){note.textContent=err.message;}finally{save.disabled=revoke.disabled=false;}
 }
 save.onclick=()=>update(false);revoke.onclick=()=>update(true);
 copy.onclick=async()=>{try{await navigator.clipboard.writeText(link.href);note.textContent='Link copied.';}catch{note.textContent=link.href;}};
}
