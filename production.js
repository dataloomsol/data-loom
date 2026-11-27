import { initBakeOffs } from './bake-offs.js';
import {initAgentTools} from './agent-tools.js';
import {initConsentLedger} from './consent-ledger.js';
import {initBlindTrials} from './blind-trials.js';
import {initProofCards} from './proof-cards.js';
import {initBounties} from './bounties.js';
import { getWallets } from '@wallet-standard/app';
import bs58 from 'bs58';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => {
  try { const n=BigInt(value); return `${n/1000000n}.${String(n%1000000n).padStart(6,'0').replace(/0+$/,'')||'00'}`; } catch {return '—';}
};
const short = value => value ? `${value.slice(0,6)}…${value.slice(-6)}` : '—';
const list = (value, key) => Array.isArray(value) ? value : value?.[key] || [];
const explorer = sig => `https://explorer.solana.com/tx/${encodeURIComponent(sig)}`;
const pendingKey = 'data-loom.pending-payments.v1';

export function initProduction({getReviewedDrafts,toast,show}) {
  let status=null, identity=null, wallet=null, account=null, walletOff=null;
  let published=[], owned=[], orders=[], earnings=[], licenses=[], payment=null, sending=false;
  let drafts=[], accountLoad=0;
  let queryMarket=null, queryOrders=[], queryPolicies=[], queryEarnings=[];
  let pending=[];
  try { pending=JSON.parse(localStorage.getItem(pendingKey)||'[]'); if(!Array.isArray(pending)) pending=[]; } catch {pending=[];}
  function savePending(){try{localStorage.setItem(pendingKey,JSON.stringify(pending));}catch{toast('Browser storage is unavailable. Keep your transaction signature for recovery.');}}
  function remember(order){pending=pending.filter(p=>p.id!==order.id);pending.push(order);savePending();}
  function forget(id){pending=pending.filter(p=>p.id!==id);savePending();}
  async function api(path, body, method) {
    const response=await fetch(path,{method:method||(body===undefined?'GET':'POST'),credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const contentType=response.headers.get('content-type')||'';
    const data=contentType.includes('json')?await response.json():{error:'The service returned an unexpected response.'};
    if(!response.ok) {if(response.status===401){identity=null;renderIdentity();}throw new Error(data.error||data.message||`Request failed (${response.status}).`);}
    return data;
  }
  function feature(name){return status?.[name]===true;}
  async function refreshStatus(){try {status=await api('/api/status');renderStatus();}catch(e){status=null;$('#market-status').textContent='Marketplace service is unavailable. Local imports and review still work.';$('#account-services').textContent=e.message;$('#server-query-run').disabled=true;renderMarket();renderOwned();}}
  function renderStatus(){
    const payments=feature('payments'), listings=feature('listings');
    $('#market-status').innerHTML=`<strong>Solana mainnet</strong> · ${payments?'USDC checkout enabled':'USDC checkout unavailable'} · ${listings?'Listing publication enabled':'Listing publication unavailable'}<br>Contributor proceeds: 70%. Platform: 30%. ${escape((status.blockers||[]).join(' '))}`;
    $('#account-services').innerHTML=`Storage: ${escape(status.storage||'unavailable')} · Payments: ${payments?'enabled':'disabled'} · Confidential AI: ${feature('confidentialQueries')?'enabled':'unavailable'} · Conventional AI: ${feature('conventionalAi')?'configured':'not enabled'}<br>${feature('confidentialQueries')?'Protected query processing; verified inference receipt required.':'Confidential paid queries are not enabled. Encrypted storage does not imply confidential computation.'}`;
    $('#server-query-run').disabled=!feature('conventionalAi');
    $('#server-query-answer').textContent=feature('conventionalAi')?'Select your datasets and explicitly authorize server-side AI processing.':'Conventional AI is not enabled. Use Ask Data Loom for confidential queries when available.';
    renderMarket();renderOwned();
  }
  function renderIdentity(){
    document.dispatchEvent(new Event("loom-identity-change"));
    if(!identity){$('#paid-query-answer').textContent='';queryOrders=[];queryPolicies=[];queryEarnings=[];$('#query-purchase-history').replaceChildren();$('#query-policies').replaceChildren();$('#query-earnings').replaceChildren();}
    $('#account-identity').textContent=identity?`Signed in: ${identity}`:'Not signed in';
    $('#account-signin').hidden=!!identity;$('#account-signout').hidden=!identity;$('#account-content').hidden=!identity;
    $('#wallet').textContent=identity?`✓ ${short(identity)}`:account?`↗ ${short(account.address)}`:'↗ Connect wallet';
  }
  async function session(){try{const me=await api('/api/me');identity=me.wallet||null;}catch{identity=null;}renderIdentity();}
  function compatibleWallets(){return getWallets().get().filter(w=>w.chains.includes('solana:mainnet')&&w.features['standard:connect']&&w.features['solana:signMessage']);}
  function walletChoice(){
    return new Promise((resolve,reject)=>{
      const dialog=$('#wallet-dialog');$('#wallet-options').replaceChildren();$('#wallet-status').textContent='';
      const options=compatibleWallets();
      if(!options.length){$('#wallet-options').textContent='No compatible Solana wallet is installed. Install a Wallet Standard wallet such as Phantom, Solflare or Backpack, then reload.';}
      let done=false;
      const finish=(err,value)=>{if(done)return;done=true;dialog.removeEventListener('close',onClose);dialog.close();err?reject(err):resolve(value)};
      const onClose=()=>finish(new Error('Wallet connection cancelled.'));
      dialog.addEventListener('close',onClose);
      for(const item of options){const button=document.createElement('button');button.className='wallet-option';button.textContent=`${item.name} ↗`;button.onclick=async()=>{button.disabled=true;try{const result=await item.features['standard:connect'].connect();const available=(result.accounts||item.accounts).filter(a=>a.chains.includes('solana:mainnet')&&a.features.includes('solana:signMessage'));if(!available.length)throw Error('This wallet has no account supporting Solana mainnet message signing.');wallet=item;account=available[0];if(walletOff)walletOff();const events=item.features['standard:events'];if(events){walletOff=events.on('change',change=>{if(change.accounts&&!change.accounts.some(a=>a.address===account?.address)){wallet=null;account=null;identity=null;renderIdentity();void api('/api/logout',{}).catch(()=>{});toast('Wallet account changed. Sign in again before using your account.');}})}finish(null,account);}catch(e){$('#wallet-status').textContent=e.message;button.disabled=false;}};$('#wallet-options').append(button);}
      dialog.showModal();
    });
  }
  async function signIn(){
    if(!wallet||!account)await walletChoice();
    const challenge=await api('/api/auth/challenge',{wallet:account.address});
    toast('Review the Data Loom sign-in message in your wallet. No funds move.');
    const signed=await wallet.features['solana:signMessage'].signMessage({account,message:new TextEncoder().encode(challenge.message)});
    if(!signed?.[0]?.signature)throw Error('Wallet did not return a message signature.');
    const result=await api('/api/auth/verify',{id:challenge.id,signature:bs58.encode(signed[0].signature)});
    identity=result.wallet;renderIdentity();await refreshAccount();return identity;
  }
  async function requireIdentity(){if(!identity)await signIn();return identity;}
  $('#wallet').onclick=()=>signIn().catch(e=>toast(e.message));
  $('#account-signin').onclick=()=>signIn().catch(e=>toast(e.message));
  $('#account-signout').onclick=async()=>{try{await api('/api/logout',{});identity=null;owned=[];orders=[];earnings=[];licenses=[];accountLoad++;renderIdentity();renderOwned();renderOrders();$('#server-query-sources').replaceChildren();$('#server-query-answer').textContent='Signed out.';}catch(e){toast(e.message)}};

  async function refreshMarket(){try{published=list(await api('/api/datasets'),'datasets');renderMarket();}catch(e){$('#published-datasets').innerHTML=`<div class="empty">${escape(e.message)}<br>Use Refresh to try again.</div>`;}}
  function renderMarket(){const query=$('#market-search').value.trim().toLowerCase();const filtered=published.filter(d=>`${d.title} ${d.description} ${d.category}`.toLowerCase().includes(query));$('#published-datasets').innerHTML=filtered.length?filtered.map(d=>`<article class="market-card"><p class="eyebrow">${escape(d.category)} / LICENSED DATASET</p><h3>${escape(d.title)}</h3><p>${escape(d.description)}</p><div class="market-preview">${escape(d.preview)}</div><div class="market-meta">Contributor: ${escape(short(d.owner))}<br>License: ${escape(d.license)}<br>Content commitment: ${escape(d.commitment||'')}</div><details class="account-note"><summary>Read license terms</summary><p>${escape(status?.licenses?.[d.license]||'License terms are not available. Checkout remains subject to the order’s displayed terms.')}</p></details><div class="market-price">${money(d.price)} <small>USDC</small></div><button data-buy="${escape(d.id)}" class="primary" ${feature('payments')?'':'disabled'}>${d.owner===identity?'Your dataset':'Review purchase ↗'}</button></article>`).join(''):'<div class="empty">No published datasets match this view.<br>New contributions appear after their owner publishes them.</div>';}
  $('#refresh-market').onclick=async()=>{await refreshStatus();await refreshMarket()};$('#market-search').oninput=renderMarket;
  $('#published-datasets').onclick=e=>{const b=e.target.closest('[data-buy]');if(b)beginPurchase(b.dataset.buy).catch(err=>toast(err.message))};

  function refreshDrafts(){drafts=getReviewedDrafts();const old=$('#publish-source').value;$('#publish-source').innerHTML=drafts.length?drafts.map(d=>`<option value="${escape(d.id)}">${escape(d.title)}</option>`).join(''):'<option value="">No reviewed local drafts — import and review first</option>';if(drafts.some(d=>d.id===old))$('#publish-source').value=old;sourceChanged();}
  function sourceChanged(){const draft=drafts.find(d=>d.id===$('#publish-source').value);$('#publish-title').value=draft?.title||'';$('#publish-consent').checked=false;$('#store-contribution').disabled=!draft;}
  $('#publish-source').onchange=sourceChanged;$('#refresh-drafts').onclick=refreshDrafts;
  function licenseText(){$('#license-description').textContent=status?.licenses?.[$('#publish-license').value]||'Read and confirm the license terms after the service is available.';}
  $('#publish-license').onchange=licenseText;
  $('#contribution-form').addEventListener('input',e=>{if(e.target.id!=='publish-consent')$('#publish-consent').checked=false;});
  $('#contribution-form').onsubmit=async e=>{e.preventDefault();const button=$('#store-contribution');button.disabled=true;try{await requireIdentity();const draft=getReviewedDrafts().find(d=>d.id===$('#publish-source').value);if(!draft?.draft)throw Error('This reviewed local draft is no longer available.');if(!$('#publish-consent').checked)throw Error('Review and authorize the upload first.');const input=$('#publish-price').value;if(!/^\d+(\.\d{1,2})?$/.test(input))throw Error('Use a price with no more than two decimal places.');const [whole,fraction='']=input.split('.');const price=Number(BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0')));if(!Number.isSafeInteger(price)||price<10000||price>1000000000)throw Error('Price must be between 0.01 and 1,000 USDC.');if($('#publish-preview').value.length>800)throw Error('Public preview must be 800 characters or fewer.');await api('/api/datasets',{title:$('#publish-title').value.trim(),description:$('#publish-description').value.trim(),category:$('#publish-category').value,content:draft.draft,preview:$('#publish-preview').value.trim(),price,license:$('#publish-license').value,consent:true,lineage:$('#lineage-parent').value?{parentId:$('#lineage-parent').value,transformation:$('#lineage-transformation').value}:undefined});$('#publish-consent').checked=false;toast('Reviewed copy stored. It is not public until you publish it.');await refreshAccount();}catch(err){toast(err.message)}finally{button.disabled=!getReviewedDrafts().length}};
  async function refreshAccount(){if(!identity)return;const request=++accountLoad;refreshDrafts();licenseText();const results=await Promise.allSettled([api('/api/my/datasets'),api('/api/my/orders'),api('/api/my/earnings'),api('/api/my/licenses')]);if(request!==accountLoad||!identity)return;const [d,o,e,l]=results;owned=d.status==='fulfilled'?list(d.value,'datasets'):[];orders=o.status==='fulfilled'?list(o.value,'orders'):[];earnings=e.status==='fulfilled'?list(e.value,'earnings'):[];licenses=l.status==='fulfilled'?list(l.value,'licenses'):[];renderOwned();renderOrders();renderEarnings();renderAiSources();await Promise.all([refreshQueryAccount(),refreshLedger()]);if(results.some(r=>r.status==='rejected'))toast('Some account records could not be loaded. Reopen Account to retry.');}
  function renderOwned(){
    const parent=$('#lineage-parent'), selected=parent.value;
    parent.innerHTML='<option value="">Original dataset</option>'+owned.map(d=>`<option value="${escape(d.id)}">${escape(d.title)} · ${escape(d.id.slice(0,8))}</option>`).join('');
    if(owned.some(d=>d.id===selected))parent.value=selected;
    $('#owned-datasets').innerHTML=owned.length?owned.map(d=>`<article class="account-record"><h4>${escape(d.title)}</h4><p>${escape(d.state)} · ${money(d.price)} USDC · ${escape(d.license)}</p><p>Commitment: ${escape(d.commitment||'')}</p><div class="record-actions"><button class="secondary" data-lineage="${escape(d.id)}">Lineage receipt</button><button class="secondary" data-download="${escape(d.id)}">Download ↧</button>${d.state==='published'?`<button class="secondary" data-unpublish="${escape(d.id)}">Stop new sales</button>`:`<button class="secondary" data-publish="${escape(d.id)}" ${feature('listings')?'':'disabled'}>Publish listing ↗</button>`}</div><p>Unpublishing stops new purchases. It does not recall copies or remove existing buyers’ access.</p></article>`).join(''):'<p class="account-note">No stored contributions yet.</p>';}
  async function download(id){const response=await fetch(`/api/datasets/${encodeURIComponent(id)}/download`,{credentials:'same-origin'});if(!response.ok){let msg='Download unavailable.';try{msg=(await response.json()).error||msg}catch{}throw Error(msg)}const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`data-loom-${id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('#owned-datasets').onclick=async e=>{const button=e.target.closest('button');if(!button)return;button.disabled=true;try{if(button.dataset.lineage){
      const receipt=await api(`/api/datasets/${encodeURIComponent(button.dataset.lineage)}/lineage`);
      if(!receipt)throw Error('This dataset has no parent version recorded.');
      const url=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)],{type:'application/json'}));
      const link=document.createElement('a');
      link.href=url;
      link.download='data-loom-lineage-'+receipt.datasetId+'.json';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      button.disabled=false;
      return;
    }
    if(button.dataset.download)await download(button.dataset.download);if(button.dataset.publish)await api(`/api/datasets/${encodeURIComponent(button.dataset.publish)}/publish`,{});if(button.dataset.unpublish)await api(`/api/datasets/${encodeURIComponent(button.dataset.unpublish)}/unpublish`,{});await refreshAccount();await refreshMarket();}catch(err){toast(err.message);button.disabled=false}};

  function renderOrders(){const paid=orders.filter(o=>o.state==='paid'||o.state==='confirmed'||o.signature);$('#purchase-history').innerHTML=paid.length?paid.map(o=>`<article class="account-record"><h4>Order ${escape(short(o.id))}</h4><p>${money(o.price)} USDC · ${escape(o.state)}</p><div class="record-actions">${o.signature?`<a href="${explorer(o.signature)}" target="_blank" rel="noopener noreferrer">Transaction ↗</a>`:''}<button class="secondary" data-download="${escape(o.dataset)}">Download dataset ↧</button></div></article>`).join(''):'<p class="account-note">No completed purchases.</p>';const unresolved=pending.filter(o=>o.buyer===identity&&!paid.some(x=>x.id===o.id)&&!queryOrders.some(x=>x.id===o.id&&x.state==='answered'));$('#pending-payments').innerHTML=unresolved.map(o=>`<article class="account-record"><h4>Pending verification / ${escape(short(o.id))}</h4><p>Do not send another payment until this order is resolved. ${o.signature?'A signature was recorded.':'If your wallet sent a transaction, paste its signature below.'}</p><input class="recovery-input" data-signature="${escape(o.id)}" aria-label="Transaction signature" placeholder="Solana transaction signature" value="${escape(o.signature||'')}"><div class="record-actions"><button class="secondary" data-confirm="${escape(o.id)}">Verify payment ↗</button>${!o.signature?`<button class="secondary" data-discard="${escape(o.id)}">Wallet never sent this</button>`:''}</div></article>`).join('');}
  $('#purchase-history').onclick=e=>{const b=e.target.closest('[data-download]');if(b)download(b.dataset.download).catch(err=>toast(err.message))};
  $('#pending-payments').onclick=async e=>{const discard=e.target.closest('[data-discard]');if(discard){if(window.confirm('Only discard if your wallet never submitted a transaction. If it sent one, cancel and paste the signature to recover your license. Discard this unsent attempt?')){forget(discard.dataset.discard);renderOrders();}return;}const b=e.target.closest('[data-confirm]');if(!b)return;b.disabled=true;try{const record=pending.find(p=>p.id===b.dataset.confirm),input=[...document.querySelectorAll('[data-signature]')].find(x=>x.dataset.signature===b.dataset.confirm);const signature=input.value.trim();if(!signature)throw Error('Enter the transaction signature from your wallet.');await confirmOrder(record.id,signature);toast(record.kind==='query'?'Payment verified. Your answer is available in query receipts.':'Payment verified. Your dataset license is available.');}catch(err){toast(err.message);b.disabled=false}};
  function renderEarnings(){const total=earnings.reduce((sum,e)=>{try{return sum+BigInt(e.seller_amount??e.sellerAmount??0)}catch{return sum}},0n);$('#earnings-history').innerHTML=`<p class="market-price">${money(total)} <small>USDC received</small></p>`+(earnings.length?earnings.map(e=>`<div class="account-record"><p>${money(e.seller_amount??e.sellerAmount)} USDC · ${escape(short(e.id))}</p>${e.signature?`<a href="${explorer(e.signature)}" target="_blank" rel="noopener noreferrer">View payment ↗</a>`:''}</div>`).join(''):'<p class="account-note">No verified sales yet. Uploads and previews do not generate earnings.</p>');}
  async function confirmOrder(id,signature){const kind=pending.find(p=>p.id===id)?.kind;const result=await api(`/api/${kind==='query'?'query-orders':'orders'}/${encodeURIComponent(id)}/confirm`,{signature});if(kind==='query')displayQueryAnswer(result);forget(id);await refreshAccount();}
  async function beginPurchase(id,auction){
    await requireIdentity();await refreshStatus();if(!feature('payments'))throw Error('Mainnet payments are not enabled.');const dataset=auction??published.find(d=>d.id===id);if(!dataset)throw Error('Refresh the marketplace before buying.');if(dataset.owner===identity)throw Error('This is your dataset. Download it from Account.');const unresolved=pending.find(p=>p.buyer===identity&&p.dataset===id);if(unresolved){show('account');renderOrders();throw Error('An earlier order needs verification. Resolve it in Account before paying again.');}
    if(!wallet||account?.address!==identity){await walletChoice();if(account.address!==identity){await signIn();throw Error('Wallet account changed. Review the purchase again.');}}
    const sendFeature=wallet.features['solana:signAndSendTransaction'];if(!sendFeature||!account.features.includes('solana:signAndSendTransaction'))throw Error('This wallet cannot submit Solana transactions through Wallet Standard.');
    const supported=sendFeature.supportedTransactionVersions||[];const version=supported.includes(1)?1:supported.includes(0)?0:null;if(version===null)throw Error('This wallet does not support a compatible transaction version.');
    const order=await api('/api/orders',{dataset:id,version,...(auction&&{auction:auction.id})});if(order.simulation!==true)throw Error('The server did not confirm a successful transaction simulation.');
    payment={...order,buyer:identity,dataset:id,terms:order.terms||status?.licenses?.[dataset.license]||'',wallet,account};
    const summary=order.summary;$('#payment-summary').innerHTML=`<div class="payment-row"><strong>Network</strong><span>Solana mainnet · real USDC</span></div><div class="payment-row"><strong>Dataset</strong><span>${escape(dataset.title)}</span></div><div class="payment-row"><strong>Total</strong><span>${money(summary.price)} USDC</span></div><div class="payment-row"><strong>Contributor / 70%</strong><span>${money(summary.sellerAmount)} USDC<br>${escape(summary.seller)}</span></div><div class="payment-row"><strong>Platform / 30%</strong><span>${money(summary.platformAmount)} USDC<br>${escape(summary.platform)}</span></div><div class="payment-row"><strong>Fee payer</strong><span>${escape(summary.feePayer||identity)}</span></div><div class="payment-row"><strong>USDC mint</strong><span>${escape(summary.mint)}</span></div><div class="payment-row"><strong>Estimated network fee</strong><span>${escape(summary.estimatedNetworkFeeLamports??'Unknown')} lamports, plus applicable account rent</span></div><details><summary>License: ${escape(dataset.license)}</summary><p>${escape(payment.terms)}</p></details>`;
    $('#payment-consent').checked=false;$('#payment-send').disabled=true;$('#payment-progress').textContent='Simulation passed. No payment has been signed or sent.';$('#payment-dialog').showModal();
  }
  $('#payment-consent').onchange=()=>$('#payment-send').disabled=!$('#payment-consent').checked||sending||payment?.attempted;
  $('#payment-close').onclick=()=>{if(!sending)$('#payment-dialog').close()};
  $('#payment-dialog').addEventListener('cancel',e=>{if(sending)e.preventDefault()});
  $('#payment-send').onclick=async()=>{
    if(!payment||payment.attempted||sending||!$('#payment-consent').checked)return;payment.attempted=true;sending=true;$('#payment-send').disabled=true;$('#payment-close').disabled=true;
    const current=payment;const record={id:current.id,buyer:current.buyer,dataset:current.dataset,kind:current.kind||'dataset',signature:null,created:Date.now()};remember(record);
    try{if(identity!==current.buyer||account?.address!==current.buyer)throw Error('Wallet changed. Close this payment and start again.');$('#payment-progress').textContent='Review the exact recipients and amounts in your wallet.';const transaction=Uint8Array.from(atob(current.transaction),c=>c.charCodeAt(0));const result=await current.wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({account:current.account,chain:'solana:mainnet',transaction,options:{commitment:'confirmed'}});if(!result?.[0]?.signature)throw Error('No signature was returned. Check wallet history before trying again.');const signature=bs58.encode(result[0].signature);remember({...record,signature});$('#payment-progress').textContent='Transaction submitted. Verifying mainnet settlement…';await confirmOrder(current.id,signature);$('#payment-dialog').close();show('account');toast(current.kind==='query'?'Payment verified. Your answer is available in query receipts.':'Payment verified. Download your licensed dataset from Account.');}catch(err){$('#payment-progress').textContent=`${err.message} Check Account → Purchases & recovery. Do not pay again if your wallet submitted the transaction.`;renderOrders();}finally{sending=false;$('#payment-close').disabled=false;/* Deliberately do not enable resending this quote. */}
  };

  async function refreshQueryMarket(){try{queryMarket=await api('/api/query-market');const offers=queryMarket.offers||[];renderQueryDisclosures();$('#query-market-status').textContent=`${queryMarket.enabled?'Answer purchases enabled':'Answer purchases disabled'}. ${queryMarket.processing||'Conventional AI processing, not confidential compute.'} ${(queryMarket.blockers||[]).join(' ')}`;const previous=$('#paid-query-source').value;$('#paid-query-source').innerHTML=offers.length?offers.map(d=>`<option value="${escape(d.id)}">${escape(d.title)} · ${money(d.price)} USDC</option>`).join(''):'<option value="">No contributor-approved query sources</option>';if(offers.some(x=>x.id===previous))$('#paid-query-source').value=previous;querySourceChanged();$('#paid-query-prepare').disabled=!queryMarket.enabled||!offers.length;}catch(e){queryMarket=null;renderQueryDisclosures();$('#query-market-status').textContent=e.message;$('#paid-query-prepare').disabled=true;}}
  function renderQueryDisclosures(){
    const protectedMode=queryMarket?.confidential===true;
    $('#paid-query-disclosure').textContent=protectedMode?'Purchase one generated answer without a dataset download license. Protected query processing; verified inference receipt required. Separate dataset sales have their own download licenses.':'Purchase one generated answer without receiving a dataset download. Source content is processed by the server and configured AI provider; this is not confidential computing.';
    $('#paid-query-consent-copy').textContent=protectedMode?'I authorize processing this question through the protected backend and verified inference provider. I receive an answer, not a dataset license, and AI answers may be inaccurate.':'I authorize external AI processing of this question. I understand that I receive an answer, not a dataset license, and that AI answers may be inaccurate.';
    $('#paid-query-consent').checked=false;
  }
  const queryCurrency=value=>value==='DATALOOM'?'DATALOOM':'USDC';
  function queryPaymentChanged(){
    const source=queryMarket?.offers?.find(d=>d.id===$('#paid-query-source').value);
    const token=$('#paid-query-currency').value==='DATALOOM';
    const split=!token&&queryMarket?.buyback?'70% contributor / 15% platform / 15% USDC buyback reserve.':'70% contributor / 30% platform.';
    $('#paid-query-preview').textContent=source?`${source.preview||''} Contributor: ${source.owner}. ${split}`:'';
    $('#paid-query-consent').checked=false;$('#paid-query-answer').textContent='';
  }
  function querySourceChanged(){
    const source=queryMarket?.offers?.find(d=>d.id===$('#paid-query-source').value),picker=$('#paid-query-currency');
    picker.replaceChildren(new Option(source?`${money(source.price)} USDC`:'USDC','USDC'));
    if(source?.tokenPrice)picker.append(new Option(`${money(source.tokenPrice)} DATALOOM`,'DATALOOM'));
    queryPaymentChanged();
  }
  $('#query-market-refresh').onclick=refreshQueryMarket;$('#paid-query-source').onchange=querySourceChanged;
  $('#paid-query-currency').onchange=queryPaymentChanged;$('#paid-query-question').oninput=()=>$('#paid-query-consent').checked=false;
  function displayQueryAnswer(result){$('#paid-query-answer').textContent=result.answer?`${result.answer}\n\nSource commitment: ${result.source?.commitment||'Unavailable'}\n${result.processing||'Conventional AI processing'}${result.evidence?.receiptId?'\nInference receipt: '+String(result.evidence.receiptId):''}`:'Answer not yet available.';}
  $('#paid-query-form').onsubmit=async e=>{e.preventDefault();const button=$('#paid-query-prepare');button.disabled=true;try{await requireIdentity();if(!queryMarket?.enabled)throw Error('Query purchases are not enabled.');if(!$('#paid-query-consent').checked)throw Error('Accept the processing terms first.');const dataset=$('#paid-query-source').value;if(pending.some(p=>p.buyer===identity&&p.kind==='query'&&p.dataset===dataset))throw Error('Resolve your pending query payment in Account before preparing another.');if(!wallet||account?.address!==identity){await walletChoice();if(account?.address!==identity){await signIn();throw Error('Account changed. Review your question again.');}}const feature=wallet.features['solana:signAndSendTransaction'];if(!feature||!account.features.includes('solana:signAndSendTransaction'))throw Error('Wallet cannot submit this transaction.');const versions=feature.supportedTransactionVersions||[],version=versions.includes(1)?1:versions.includes(0)?0:null;if(version===null)throw Error('Wallet transaction version unsupported.');$('#paid-query-progress').textContent='Generating and checking the answer before preparing payment. Nothing has been charged.';const order=await api('/api/query-orders',{dataset,question:$('#paid-query-question').value.trim(),consent:true,currency:queryCurrency($('#paid-query-currency').value),version});if(order.simulation!==true)throw Error('Payment simulation was not confirmed.');payment={...order,kind:'query',buyer:identity,dataset,wallet,account};const t=order.summary,currency=queryCurrency(t.currency);$('#payment-summary').innerHTML=`<p class="eyebrow">ONE AI ANSWER / NO DATASET DOWNLOAD</p><div class="payment-row"><strong>Total</strong><span>${money(t.price)} ${currency} · Solana mainnet</span></div><div class="payment-row"><strong>Contributor / 70%</strong><span>${money(t.sellerAmount)} ${currency}<br>${escape(t.seller)}</span></div><div class="payment-row"><strong>Platform fee</strong><span>${money(t.platformAmount)} ${currency}<br>${escape(t.platform)}</span></div>${t.burnAmount?`<div class="payment-row"><strong>Token discount and burn</strong><span>Saved ${money(t.discountAmount)} DATALOOM · Burn ${money(t.burnAmount)} DATALOOM</span></div>`:''}${t.buybackWallet?`<div class="payment-row"><strong>Buyback reserve / 15%</strong><span>${money(t.buybackAmount)} USDC<br>${escape(t.buybackWallet)}</span></div><p>Reserve allocation only. No completed buyback or burn is implied.</p>`:''}<div class="payment-row"><strong>Network fee</strong><span>${escape(t.estimatedNetworkFeeLamports??'Unknown')} lamports + applicable account rent</span></div><p>${escape(order.terms)}</p><p>Answer generated before payment, released after finalized payment verification. ${escape(order.processing||(queryMarket?.confidential?'Protected query processing; verified inference receipt required.':'Conventional AI; not confidential processing.'))}</p>`;$('#payment-consent').checked=false;$('#payment-send').disabled=true;$('#payment-progress').textContent='Simulation passed. Review before signing.';$('#payment-dialog').showModal();$('#paid-query-progress').textContent='Answer prepared. Review the payment dialog.';}catch(err){$('#paid-query-progress').textContent=err.message;}finally{button.disabled=!queryMarket?.enabled;}};
  async function refreshQueryAccount(){try{const [policies,history,receipts]=await Promise.all([api('/api/my/query-policies'),api('/api/my/query-orders'),api('/api/my/query-earnings')]);queryPolicies=list(policies,'policies');queryOrders=list(history,'orders');queryEarnings=list(receipts,'earnings');$('#query-policies').innerHTML=owned.map(d=>{const policy=queryPolicies.find(p=>p.dataset===d.id||p.id===d.id);return `<article class="account-record"><h4>${escape(d.title)}</h4><p>Answer access: ${policy?.enabled?'enabled':'disabled'}</p><label>Price per answer / USDC<input type="number" min="0.01" max="1000" step="0.01" value="${money(policy?.price||100000)}" data-query-price="${escape(d.id)}"></label><label>Optional DATALOOM price per confidential answer<input type="number" min="0.01" max="1000000" step="0.01" value="${policy?.token_price!=null?money(policy.token_price):''}" data-query-token-price="${escape(d.id)}" placeholder="Leave blank to accept USDC only"></label><label class="consent"><input type="checkbox" data-query-consent="${escape(d.id)}"> ${(queryMarket?queryMarket.confidential===true:feature('confidentialQueries'))?'I authorize this source to be processed by the protected backend and verified inference provider to sell generated answers. This permission does not grant dataset download rights.':'I authorize processing this source with the server and external AI provider to sell generated answers.'}</label><button class="secondary" data-query-enable="${escape(d.id)}">Enable answer access</button><button class="secondary" data-query-disable="${escape(d.id)}">Disable new queries</button></article>`}).join('')||'<p>No stored contributions.</p>';$('#query-purchase-history').innerHTML=queryOrders.map(o=>`<article class="account-record"><h4>Query ${escape(short(o.id))}</h4><p>${escape(o.state)} · ${money(o.price)} ${queryCurrency(o.currency)}</p>${o.state==='answered'||o.state==='paid'?`<button class="secondary" data-query-result="${escape(o.id)}">View answer ↗</button> <button class="secondary" data-proof-card="${escape(o.id)}">Share Proof Card</button>`:''}${o.signature?` <a href="${explorer(o.signature)}" target="_blank" rel="noopener noreferrer">Transaction ↗</a>`:''}</article>`).join('')||'<p>No query purchases.</p>';$('#query-earnings').innerHTML=queryEarnings.map(o=>`<p>${money(o.seller_amount||o.sellerAmount)} ${queryCurrency(o.currency)} · ${escape(short(o.id))}${o.signature?` · <a href="${explorer(o.signature)}" target="_blank" rel="noopener noreferrer">Receipt ↗</a>`:''}</p>`).join('')||'<p>No verified query earnings.</p>';renderOrders();}catch(e){$('#query-policies').textContent=e.message;}}
  $('#query-policies').onclick=async e=>{const b=e.target.closest('[data-query-enable],[data-query-disable]');if(!b)return;b.disabled=true;try{const id=b.dataset.queryEnable||b.dataset.queryDisable,enabled=!!b.dataset.queryEnable;const input=[...document.querySelectorAll('[data-query-price]')].find(x=>x.dataset.queryPrice===id),consent=[...document.querySelectorAll('[data-query-consent]')].find(x=>x.dataset.queryConsent===id);if(enabled&&!consent.checked)throw Error('Explicit processing consent is required.');const value=input.value;if(!/^\d+(\.\d{1,2})?$/.test(value))throw Error('Enter a price with up to two decimal places.');const price=Math.round(Number(value)*1000000);if(price<10000||price>1000000000)throw Error('Price must be 0.01–1,000 USDC.');const tokenValue=[...document.querySelectorAll('[data-query-token-price]')].find(x=>x.dataset.queryTokenPrice===id).value;
    const tokenPrice=enabled&&tokenValue?Math.round(Number(tokenValue)*1000000):null;
    if(tokenPrice!==null&&(!/^\d+(\.\d{1,2})?$/.test(tokenValue)||tokenPrice<10000||tokenPrice>1000000000000))throw Error('Enter a DATALOOM price between 0.01 and 1,000,000.');
    await api(`/api/datasets/${encodeURIComponent(id)}/query-policy`,{enabled,price,tokenPrice,consent:true});await refreshQueryAccount();await refreshQueryMarket();toast(enabled?'Answer access enabled.':'New query access disabled.');}catch(err){toast(err.message);b.disabled=false}};
  $('#query-purchase-history').onclick=async e=>{const b=e.target.closest('[data-query-result]');if(!b)return;try{displayQueryAnswer(await api(`/api/query-orders/${encodeURIComponent(b.dataset.queryResult)}`));show('ask');$('#paid-query-answer').scrollIntoView({behavior:'smooth',block:'center'});}catch(err){toast(err.message)}};

  function renderAiSources(){$('#server-query-sources').innerHTML=owned.length?owned.map(d=>`<label class="server-source"><input type="checkbox" value="${escape(d.id)}"><span>${escape(d.title)}</span></label>`).join(''):'<p class="account-note">Store reviewed datasets before asking server-side AI.</p>';$('#server-query-consent').checked=false;}
  $('#server-query-sources').onchange=()=>{$('#server-query-consent').checked=false;$('#server-query-answer').textContent='Source selection changed. Authorize a new request.'};
  $('#server-query-question').oninput=()=>$('#server-query-consent').checked=false;
  $('#server-query-run').onclick=async()=>{const button=$('#server-query-run');button.disabled=true;try{await requireIdentity();if(!feature('conventionalAi'))throw Error('AI service is not configured.');const datasetIds=[...document.querySelectorAll('#server-query-sources input:checked')].map(x=>x.value);if(!datasetIds.length)throw Error('Select your stored datasets first.');if(!$('#server-query-consent').checked)throw Error('Authorize external AI processing before submitting.');const question=$('#server-query-question').value.trim();if(!question)throw Error('Enter a question.');$('#server-query-answer').textContent='Processing with the configured AI provider…';const result=await api('/api/ai/query',{datasetIds,question,consent:true});$('#server-query-answer').textContent=typeof result.answer==='string'?result.answer:JSON.stringify(result,null,2);$('#server-query-consent').checked=false;}catch(e){$('#server-query-answer').textContent=e.message;}finally{button.disabled=!feature('conventionalAi')}};
  const nitoChat = $('#nito-chat');
  api('/api/nito/status').then(config=>{nitoChat.hidden=!config.chatAvailable}).catch(()=>{});
  nitoChat.onsubmit=async event=>{
    event.preventDefault();
    const button=nitoChat.querySelector('button');
    const output=$('#nito-chat-answer');
    button.disabled=true;
    try {
      const buyer=await requireIdentity();
      output.textContent='Waiting for Nito…';
      const reply=await api('/api/nito/chat',{prompt:nitoChat.elements.prompt.value,consent:nitoChat.elements.consent.checked});
      if(buyer===identity)output.textContent=reply.answer;
      else output.textContent='';
    } catch(error) {
      output.textContent=error.message;
    } finally {
      button.disabled=false;
    }
  };
  api('/api/private-sql/status').then(config => { $('#private-sql').hidden = !config.enabled; }).catch(() => {});
  const sqlResult = $('#private-sql-result');
  async function privateSqlAction(button, action) {
    button.disabled = true;
    try {
      await requireIdentity();
      sqlResult.textContent = '';
      await action();
    } catch (error) {
      sqlResult.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  $('#private-sql-grant').onsubmit = event => {
    event.preventDefault();
    const button = event.submitter;
    const fields = Object.fromEntries(new FormData(event.target));
    void privateSqlAction(button, async () => {
      await api('/api/private-sql/grants', {...fields, enabled: button.value === 'grant'});
      sqlResult.textContent = button.value === 'grant' ? 'Permission granted.' : 'Permission revoked.';
    });
  };
  $('#private-sql-load').onclick = event => {
    void privateSqlAction(event.currentTarget, async () => {
      const tables = await api('/api/private-sql/grants');
      $('#private-sql-tables').innerHTML = tables.map(table =>
        `<label><input type="checkbox" value="${escape(table.dataset)}"> ${escape(table.title)} · ${escape(table.policy.column)} = ${escape(table.policy.equals)}</label>`
      ).join('');
      if (!tables.length) sqlResult.textContent = 'No approved tables for this wallet.';
    });
  };
  $('#private-sql-query').onsubmit = event => {
    event.preventDefault();
    const datasets = Array.from($('#private-sql-tables').querySelectorAll('input:checked'), input => input.value);
    void privateSqlAction(event.submitter, async () => {
      const receipt = await api('/api/private-sql/query', {datasets});
      sqlResult.textContent = JSON.stringify(receipt, null, 2);
    });
  };
  const replayForm = $('#agent-replay');
  api('/api/agent-replay/status').then(config => { replayForm.hidden = !config.enabled; }).catch(() => {});
  replayForm.onsubmit = async event => {
    event.preventDefault();
    const button = replayForm.querySelector('button');
    const output = $('#agent-replay-output');
    button.disabled = true;
    output.textContent = '';
    try {
      const trace = JSON.parse($('#agent-replay-input').value);
      const viewer = await requireIdentity();
      const result = await api('/api/agent-replay', trace);
      if (viewer === identity) output.textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      output.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  let nitoEvidenceUrl;
  $('#nito-evidence').onclick=async()=>{
    const button=$('#nito-evidence'), status=$('#nito-status'), download=$('#nito-download');
    button.disabled=true;
    download.hidden=true;
    if(nitoEvidenceUrl)URL.revokeObjectURL(nitoEvidenceUrl);
    try{
      const config=await api('/api/nito/status');
      if(!config.evidenceAvailable)throw Error('Set a Nito API key and encrypted model on the server to fetch evidence.');
      const buyer=await requireIdentity();
      const evidence=await api('/api/nito/attestation',{});
      if(buyer!==identity)return;
      nitoEvidenceUrl=URL.createObjectURL(new Blob([JSON.stringify(evidence,null,2)],{type:'application/json'}));
      download.href=nitoEvidenceUrl;
      download.hidden=false;
      status.textContent='Evidence received for '+evidence.model+'. Hardware verification pending.';
    }catch(error){status.textContent=error.message}
    finally{button.disabled=false}
  };
  initAgentTools({api,requireIdentity,escape,money,beginPurchase,identity:()=>identity,walletState:()=>({wallet,account})});
  initBakeOffs({api,requireIdentity,escape});
  initBlindTrials({api,requireIdentity,escape,money,identity:()=>identity,walletState:()=>({wallet,account})});
  const refreshLedger=initConsentLedger({api,identity:()=>identity,money,refreshMarkets:async()=>{await Promise.all([refreshMarket(),refreshQueryMarket()]);}});
  initProofCards({api,toast});
  initBounties({api,requireIdentity,escape,money,identity:()=>identity,walletState:()=>({wallet,account})});
  document.addEventListener('click',event=>{const el=event.target.closest('[data-view]');if(el?.dataset.view==='marketplace')void refreshMarket();if(el?.dataset.view==='account')void refreshAccount();if(el?.dataset.view==='ask')void refreshQueryMarket();});
  void (async()=>{await refreshStatus();await session();await refreshMarket();await refreshQueryMarket();if(location.hash==='#account')await refreshAccount();})();
  return {refresh:async()=>{await refreshStatus();await session();await refreshMarket();if(identity)await refreshAccount();}};
}
