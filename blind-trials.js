import bs58 from 'bs58';
export function initBlindTrials({api,requireIdentity,escape,money,identity,walletState}){
 const el=id=>document.getElementById(id),panel=el('blind-trials'),feedback=el('trial-feedback');let market=null,viewer=null;
 const run=async fn=>{try{await fn()}catch(e){feedback.textContent=e.message}};
 const overlapForm=el('overlap-form'),overlapResult=el('overlap-result');
 el('overlap-load').onclick=()=>void run(async()=>{
  const wallet=await requireIdentity();
  const options=await api('/api/my/overlap-options');
  if(wallet!==identity())return;
  overlapResult.textContent=!options.enabled?'Confidential compute is unavailable.':
   !options.baseline.length||!options.candidates.length?'A paid baseline and an opted-in candidate are required.':'';
  overlapForm.hidden=Boolean(overlapResult.textContent);
  for(const name of ['baseline','candidate']){
   overlapForm.elements[name].replaceChildren(...options[name==='candidate'?'candidates':name].map(item=>new Option(item.title,item.id)));
  }
 });
 overlapForm.onsubmit=event=>{
  event.preventDefault();
  void run(async()=>{
   const wallet=await requireIdentity(),button=event.submitter;
   button.disabled=true;
   try{
    const report=await api('/api/my/overlap-check',Object.fromEntries(new FormData(overlapForm)));
    if(wallet!==identity())return;
    overlapResult.replaceChildren(...report.categories.map(({category,band})=>{
     const row=document.createElement('p');row.textContent=category+' · '+band+' overlap';return row;
    }));
   }catch(error){if(wallet===identity())overlapResult.textContent=error.message}
   finally{button.disabled=false}
  });
 };
 const receiptKey=id=>'loom.trial.signature.'+id;
 const clear=()=>{viewer=null;overlapForm.hidden=true;overlapResult.replaceChildren();el('trial-mode').value='single';syncMode();el('trial-gate-enabled').checked=false;el('trial-gate-revision').value='';syncGate();el('regression-watch-form').hidden=true;el('watch-baseline').value='';el('trial-history').replaceChildren();el('trial-scorecard').replaceChildren();el('trial-policies').replaceChildren();el('trial-earnings').replaceChildren();el('regression-watches').replaceChildren()};
 async function load(){market=await api('/api/blind-trials');el('trial-readiness').textContent=market.enabled?'Confidential receipts required · Solana mainnet USDC':'Trials unavailable: '+market.blockers.join(' ');
  el('trial-model-a').innerHTML=el('trial-model-b').innerHTML=market.models.map(m=>`<option>${escape(m)}</option>`).join('');el('trial-model-b').selectedIndex=1;

  const selected=new Set(selectedPool().map(o=>o.id));
  el('trial-pool-offers').innerHTML=market.offers.filter(o=>o.pooled).map(o=>`<label><input type="checkbox" value="${escape(o.id)}" ${selected.has(o.id)?'checked':''}> ${escape(o.title)} · ${o.cases} cases · ${money(o.price)} USDC</label>`).join('')||'<p>No contributors have opted into pooled runs yet.</p>';
  syncMode();
  if(!market.releaseGates)el('trial-gate-enabled').checked=false;
  syncGate();
  loadGateCategories();
 }
 const poolMode=()=>el('trial-mode').value==='pool';
 const routerMode=()=>el('trial-mode').value==='router';
 const impactMode=()=>el('trial-mode').value==='impact';
 const selectedBenchmark=()=>market?.offers.find(offer=>offer.id===el('trial-benchmark').value);
 function syncImpact(){
  const offer=selectedBenchmark(),summary=el('trial-impact-summary');
  summary.hidden=!impactMode();
  if(!impactMode())return;
  const toolCost=offer?Number(offer.impact_unit_price)*Number(offer.cases):0;
  summary.textContent=offer?`Same model with and without the private tool. ${money(Number(offer.price)+toolCost)} USDC total, including ${money(toolCost)} USDC for tool calls.`:'No contributors have enabled Impact Trials yet.';
  el('trial-prepare').disabled=(router&&models.length!==3)||!market?.enabled||!offer||Number(offer.price)+toolCost>1e9;
 }
 function selectedPool(){
  const ids=new Set(Array.from(el('trial-pool-offers').querySelectorAll(':checked'),input=>input.value));
  return market?.offers.filter(o=>o.pooled&&ids.has(o.id))||[];
 }
 function syncMode(){
  const pool=poolMode(),impact=impactMode(),offers=selectedPool();
  const picker=el('trial-benchmark'),previous=picker.value;
  const benchmarks=market?.offers.filter(offer=>!impact||offer.impact_tool)||[];
  picker.replaceChildren(...(benchmarks.length?benchmarks.map(offer=>new Option(`${offer.title} · ${offer.cases} cases · ${money(offer.price)} USDC benchmark fee`,offer.id)):[new Option('No eligible private benchmarks','')]));
  if(benchmarks.some(offer=>offer.id===previous))picker.value=previous;
  const router=routerMode(),models=market?.routerModels||[];
  el('trial-model-a').closest('label').parentElement.hidden=router;
  el('trial-router-settings').hidden=!router;
  el('trial-router-settings').disabled=!router;
  el('trial-router-models').textContent=models.length===3?'All three models run the same benchmark.':'The router needs three verified Phala models.';
  const rates=el('trial-router-rates');
  if(rates.dataset.models!==JSON.stringify(models)){
   rates.dataset.models=JSON.stringify(models);
   rates.innerHTML=models.map(model=>`<label>${escape(model)}<input type="number" min="0.000001" max="1000" step="0.000001" required></label>`).join('');
  }
  el('trial-model-a-label').textContent=impact?'Model':'Model A';
  el('trial-model-b-picker').hidden=impact;
  const price=offers.reduce((sum,o)=>sum+Number(o.price),0);
  const cases=offers.reduce((sum,o)=>sum+Number(o.cases),0);
  const distinct=new Set(offers.map(o=>o.owner)).size===offers.length;
  el('trial-single-picker').hidden=pool;
  el('trial-benchmark').disabled=pool;
  el('trial-pool-picker').hidden=!pool;
  el('trial-pool-picker').disabled=!pool;
  el('trial-pool-summary').textContent=`${offers.length} benchmarks · ${cases} cases · ${money(price)} USDC${distinct?'':' · Choose different contributors'}`;
  el('trial-release-gate').hidden=pool||impact||router||!market?.releaseGates;
  el('trial-prepare').disabled=(router&&models.length!==3)||!market?.enabled||(pool?(offers.length<2||offers.length>3||cases>30||price>1e9||!distinct):!market.offers.length);
  syncGate();
  syncImpact();
  loadGateCategories();
 }
 el('trial-mode').onchange=syncMode;
 el('trial-pool-offers').onchange=syncMode;
 function syncGate(){
  const enabled=!poolMode()&&!impactMode()&&!routerMode()&&el('trial-gate-enabled').checked;
  el('trial-gate-rules').hidden=!enabled;
  el('trial-gate-rules').disabled=!enabled;
 }
 function loadGateCategories(){
  const offer=market?.offers.find(o=>o.id===el('trial-benchmark').value);
  el('trial-gate-category').innerHTML='<option value="">Overall accuracy only</option>'+
   (offer?.categories||[]).map(c=>`<option>${escape(c)}</option>`).join('');
  el('trial-gate-drop').disabled=true;
 }
 el('trial-gate-enabled').onchange=syncGate;
 el('trial-benchmark').onchange=()=>{loadGateCategories();syncImpact()};
 el('trial-gate-category').onchange=()=>{el('trial-gate-drop').disabled=!el('trial-gate-category').value};
 function gateInput(){
  if(poolMode()||impactMode()||routerMode()||!el('trial-gate-enabled').checked)return undefined;
  const category=el('trial-gate-category').value;
  return {
   revision:el('trial-gate-revision').value,
   minimumAccuracy:Number(el('trial-gate-minimum').value),
   ...(category?{category,maxDrop:Number(el('trial-gate-drop').value)}:{}),
  };
 }
 function renderGate(receipt){
  if(!receipt)return;
  const result=JSON.parse(receipt.payload);
  const gate=document.createElement('section');
  gate.className='account-record';
  gate.innerHTML=`<h4>Private Release Gate · ${escape(result.verdict.toUpperCase())}</h4>
   <p>Release revision: <code>${escape(result.policy.revision)}</code></p>
   <p>Minimum accuracy: ${result.policy.minimumAccuracy}% · ${result.checks[0].passed?'Pass':'Fail'}</p>
   ${result.policy.category?`<p>${escape(result.policy.category)} · maximum ${result.policy.maxDrop} percentage-point drop · ${result.checks[1].passed?'Pass':'Fail'}</p>`:''}
   <button type="button">Download signed receipt</button>
   <details><summary>Check this result in CI</summary>
   <p>Save the verifier in your repository and pin Data Loom’s public key in DATALOOM_GATE_PUBLIC_KEY. Use your release commit SHA and this trial ID as expected inputs.</p>
   <p><a href="/tools/verify-release-gate.mjs" download>Download Node verifier</a> · <a href="/api/release-gates" target="_blank" rel="noopener">Data Loom signing key</a></p>
   <p><code>node verify-release-gate.mjs receipt.json ${escape(result.trial)} "$GITHUB_SHA"</code></p>
   </details>`;
  gate.querySelector('button').onclick=()=>{
   const url=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)],{type:'application/json'}));
   const link=document.createElement('a');
   link.href=url;
   link.download='receipt.json';
   link.click();
   setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  el('trial-scorecard').append(gate);
 }
 async function account(){const me=await requireIdentity();viewer=me;const [datasets,policies,history,earnings,toolAccount]=await Promise.all([api('/api/my/datasets'),api('/api/my/trial-policies'),api('/api/my/trial-orders'),api('/api/my/trial-earnings'),api('/api/my/agent-tools')]);if(identity()!==me)return;
  el('trial-policies').innerHTML=datasets.map(d=>{const p=policies.find(p=>p.dataset===d.id);return `<form data-trial-policy="${escape(d.id)}"><h4>${escape(d.title)}</h4><p>${p?.enabled?'Benchmark enabled':'Not enabled'} · ${p?.cases||'5–20'} cases</p><label>Price per two-model trial / USDC<input name="price" type="number" min="0.01" max="1000" step="0.01" value="${money(p?.price||1000000)}" required></label><label><input name="consent" type="checkbox" required> I own these cases and authorize confidential model evaluation and public aggregate scores/categories. Reference answers must remain private.</label><label><input name="pool" type="checkbox" ${p?.pooled?'checked':''}> Allow this version in Private Benchmark Pools. The contributor share is split by case count.</label><label><input name="overlap" type="checkbox" ${p?.overlap?'checked':''}> Allow buyers to compare this version with their paid benchmark and see category overlap bands.</label><label>Private tool for Impact Trials<select name="impactTool"><option value="">Disabled</option>${toolAccount.tools.filter(t=>t.dataset!==d.id).map(t=>`<option value="${escape(t.id)}" ${t.id===p?.impact_tool?'selected':''}>${escape(t.name)} · ${money(t.price)} USDC per case</option>`).join('')}</select></label><p>Choosing a tool authorizes its use with this benchmark’s typed toolInput objects. The benchmark and tool must use separate private datasets you own.</p><button name="action" value="enable">Save benchmark permissions</button> <button name="action" value="disable" formnovalidate>Disable new trials</button></form>`}).join('')||'<p>Store a private evaluation dataset in Account first.</p>';
  el('trial-history').innerHTML=history.map(o=>`<article class="account-record"><h4>${o.router?'Model Router':o.impact?'Impact Trial':o.pooled?'Pool':'Trial'} ${escape(o.id.slice(0,8))}</h4><p>${escape(o.state)} · ${money(o.price)} USDC · ${escape(o.models.join(' vs '))}</p>${o.state==='paid'?`<button data-trial-result="${escape(o.id)}">View scorecard</button>`:`<button data-trial-pay="${escape(o.id)}">Review / refresh payment</button><form data-trial-recover="${escape(o.id)}"><label>Existing transaction signature<input name="signature" value="${escape(localStorage.getItem(receiptKey(o.id))||'')}" required></label><button>Verify existing payment</button></form>`}</article>`).join('')||'<p>No trials purchased.</p>';
  await loadWatches();
  el('trial-earnings').innerHTML=earnings.map(o=>`<p>${money(o.contributorAmount)} USDC · <a href="https://explorer.solana.com/tx/${encodeURIComponent(o.signature)}" target="_blank" rel="noopener noreferrer">Finalized receipt ↗</a></p>`).join('')||'<p>No finalized benchmark earnings yet.</p>';
 }
 function scorecard(r){if(identity()!==viewer)return;const s=r.scorecard;if(!s)throw Error('Scorecard is released after finalized payment only');el('trial-scorecard').innerHTML=`<h3>${r.router?'Private Model Router scorecard':r.impact?'Data Impact Trial scorecard':r.pooled?'Private Benchmark Pool scorecard':'Blind trial scorecard'}</h3><p>${escape(s.scoring)}</p>${s.impact?`<p>${escape(s.impact.tool)} · ${money(s.impact.toolCost)} USDC in tool calls</p><p>Accuracy change: ${(100*s.impact.accuracyDelta).toFixed(1)} percentage points</p>${Object.entries(s.impact.categoryDeltas).map(([category,delta])=>`<p>${escape(category)} · ${(100*delta).toFixed(1)} percentage points</p>`).join('')}`:`<p>Winner: ${escape(s.winner)}</p>`}<p>${r.pooled?'Pool commitment':'Dataset version commitment'}: ${escape(r.sourceCommitment)}</p>${r.pooled?`<details><summary>Benchmark versions and payouts</summary>${r.summary.poolSources.map(source=>`<p>${escape(source.title)} · ${source.cases} cases · ${money(source.amount)} USDC<br><code>${escape(source.commitment)}</code></p>`).join('')}</details>`:''}<div class="trial-score-grid">${s.models.map(m=>`<article class="account-record"><h4>${m.condition==='baseline'?'Baseline · ':m.condition==='assisted'?'With tool · ':''}${escape(m.model)}</h4><strong>${Math.round(m.accuracy*100)}% · ${m.correct}/${m.total}</strong><p>${m.averageLatencyMs} ms mean (includes verification)</p>${Object.entries(m.categories).map(([c,v])=>`<p>${escape(c)}: ${v.correct}/${v.total}</p>`).join('')}<details><summary>${m.receipts.length+(m.toolReceipts?.length||0)} verified inference receipts</summary>${[...m.receipts,...(m.toolReceipts||[])].map(x=>`<p>${escape(x.receiptId)} · ${escape(x.verifiedAt)}</p>`).join('')}</details></article>`).join('')}</div><p>${escape(s.note)}</p>${r.pooled||r.impact||r.router?'':'<button type="button" id="create-regression-watch">Watch this benchmark</button> <button type="button" id="draft-gap-bounty">Draft a dataset gap bounty</button>'}`;
 if(s.router){
  const recommendations=document.createElement('section');
  recommendations.innerHTML=`<h3>Recommended models by category</h3>
   <p>Minimum accuracy: ${s.router.minimumAccuracy}%. Costs are your estimates per 1,000 requests.</p>
   ${s.router.categories.map(({category,recommendation:m})=>`<p><strong>${escape(category)}</strong> · ${m?`${escape(m.model)} · ${m.correct}/${m.total} · $${money(m.cost)}`:'No model meets the threshold'}</p>`).join('')}`;
  el('trial-scorecard').prepend(recommendations);
 }
 if(!r.pooled&&!r.impact&&!r.router){
 el('create-regression-watch').onclick=()=>{el('watch-baseline').value=r.id;el('watch-max-price').value=money(r.price);el('regression-watch-form').hidden=false;el('regression-watch-form').scrollIntoView({behavior:'smooth',block:'start'})};
 const categories=Object.entries(s.models[0].categories).map(([name,first])=>{
  const second=s.models[1].categories[name];
  return {name,accuracy:(first.correct+second.correct)/(first.total+second.total)};
 }).sort((a,b)=>a.accuracy-b.accuracy);
 el('draft-gap-bounty').onclick=()=>{
  if(identity()!==viewer)return;
  document.dispatchEvent(new CustomEvent('loom-gap-bounty-draft',{detail:{id:r.id,category:categories[0]?.name||'this benchmark'}}));
 };
 }
 renderGate(r.releaseGate);
 el('trial-scorecard').scrollIntoView({behavior:'smooth',block:'start'})}
 async function pay(order,button){const me=await requireIdentity(),{wallet,account:acct}=walletState();viewer=me;if(acct?.address!==me||!wallet?.features['solana:signAndSendTransaction'])throw Error('Connect the signed-in buyer wallet before payment');if(order.paid){await account();return}
  const s=order.summary;
  const payouts=s.poolSources?s.poolSources.map(source=>`${source.title}: ${money(source.amount)} USDC (${source.owner})`).join('\n'):`Contributor: ${money(s.sellerAmount)} USDC (${s.seller})`;
  if(!window.confirm(`Trial: ${money(s.price)} USDC on Solana mainnet. \n${payouts}\nData Loom: ${money(s.platformAmount)} USDC (${s.platform}). You pay network fees and any account rent. Aggregate scorecard only; no source files. Review and sign?`)){await account();return}
  button.disabled=true;try{const old=localStorage.getItem(receiptKey(order.id));if(old)throw Error('A signature is already saved. Verify it from history before paying again.');const result=await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({account:acct,chain:'solana:mainnet',transaction:Uint8Array.from(atob(order.transaction),c=>c.charCodeAt(0))});if(!result?.[0]?.signature)throw Error('No signature returned. Check wallet history before retrying');const signature=bs58.encode(result[0].signature);localStorage.setItem(receiptKey(order.id),signature);const r=await api('/api/trial-orders/'+order.id+'/confirm',{signature});await account();scorecard(r);feedback.textContent='Finalized payment verified. Scorecard unlocked.'}finally{button.disabled=false}
 }
 async function loadWatches(){const me=identity(),data=await api('/api/my/regression-watches');if(identity()!==me)return;el('regression-watches').innerHTML=data.watches.map(w=>`<article class="account-record"><h4>${escape(w.title)}</h4><p>${w.paused?'Paused':w.cadence===1?'Daily':'Weekly'} · alert at ${w.threshold} percentage-point drop · cap ${money(w.maxPrice)} USDC/run</p><p>Next check: ${escape(new Date(w.nextRun).toLocaleString())}</p><p>${escape(w.notice)}</p><details><summary>Baseline dataset version</summary><p>${escape(w.commitment)}</p></details>${w.runs.map(r=>`<div class="account-record"><p>${escape(new Date(r.created).toLocaleString())} · ${escape(r.state)}</p>${r.comparison?`<strong>${r.alert?'Regression detected':'No threshold regression'}</strong>${r.comparison.map(m=>`<p>${escape(m.model)}: ${Math.round(m.currentAccuracy*100)}% (${m.deltaPoints>0?'+':''}${m.deltaPoints} pp vs baseline)</p>${m.categories.map(c=>`<p>${escape(c.name)}: ${c.deltaPoints>0?'+':''}${c.deltaPoints} pp</p>`).join('')}`).join('')}<button data-trial-result="${escape(r.id)}">View verified scorecard</button>`:r.state==='prepared'?`<button data-trial-pay="${escape(r.id)}">Review payment to unlock comparison</button>`:'<p>Results stay hidden until finalized payment. Failed runs do not prepare payment.</p>'}</div>`).join('')||'<p>No repeat runs yet.</p>'}<button data-watch-id="${escape(w.id)}" data-watch-paused="${w.paused?'false':'true'}">${w.paused?'Resume':'Pause'} watch</button> <button data-watch-remove="${escape(w.id)}">Remove watch</button></article>`).join('')||'<p>Open a paid trial scorecard and choose “Watch this benchmark” to start.</p>'}
 el('regression-watch-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await requireIdentity();const f=new FormData(e.target);await api('/api/regression-watches',{baseline:f.get('baseline'),cadence:f.get('cadence'),threshold:Number(f.get('threshold')),maxPrice:Math.round(Number(f.get('maxPrice'))*1e6),consent:true});e.target.hidden=true;await loadWatches();feedback.textContent='Watch saved. Each repeat evaluation uses current contributor permission and needs its own wallet payment.'})};
 panel.addEventListener('click',e=>{const b=e.target.closest('[data-watch-id],[data-watch-remove]');if(!b)return;void run(async()=>{await requireIdentity();if(b.dataset.watchRemove){await api('/api/regression-watches/'+b.dataset.watchRemove+'/remove',{})}else await api('/api/regression-watches/'+b.dataset.watchId,{paused:b.dataset.watchPaused==='true'});await loadWatches()})});
 el('trial-refresh').onclick=()=>run(load);el('trial-manage').onclick=()=>run(account);
 el('trial-upload').onsubmit=e=>{e.preventDefault();void run(async()=>{await requireIdentity();const f=e.target,button=f.querySelector('button');button.disabled=true;try{const fields=new FormData(f),file=fields.get('file');if(file.size>100000)throw Error('Benchmark file must be under 100 KB');const content=await file.text();let cases;try{cases=JSON.parse(content)}catch{throw Error('Upload a valid JSON array')};if(!Array.isArray(cases)||cases.length<5||cases.length>20)throw Error('Provide 5–20 evaluation cases');const price=Math.round(Number(fields.get('price'))*1e6);const d=await api('/api/datasets',{title:fields.get('title'),description:fields.get('description'),preview:fields.get('description'),category:'Research',content,price,license:'research-v1',consent:true});await api('/api/datasets/'+d.id+'/trial-policy',{enabled:true,price,consent:true});f.reset();await load();await account();feedback.textContent='Private benchmark stored and enabled. Only the deliberate public preview is listed.'}finally{button.disabled=false}})};
 el('trial-form').onsubmit=e=>{e.preventDefault();void run(async()=>{viewer=await requireIdentity();const button=el('trial-prepare');button.disabled=true;try{const {wallet,account:acct}=walletState();if(acct?.address!==identity()||!wallet?.features['solana:signAndSendTransaction'])throw Error('Connect a wallet that supports mainnet payments');if(!routerMode()&&!impactMode()&&el('trial-model-a').value===el('trial-model-b').value)throw Error('Choose distinct models');feedback.textContent='Running model evaluations and verifying each response. This can take several minutes.';const job=await api('/api/trial-orders',{...(poolMode()?{datasets:selectedPool().map(o=>o.id)}:{dataset:el('trial-benchmark').value}),models:routerMode()?market.routerModels:[el('trial-model-a').value,impactMode()?el('trial-model-a').value:el('trial-model-b').value],impact:impactMode(),...(routerMode()?{router:{minimumAccuracy:Number(el('trial-router-min').value),costPerThousandMicros:[...el('trial-router-rates').querySelectorAll('input')].map(input=>Math.round(Number(input.value)*1e6))}}:{}),consent:true,releaseGate:gateInput()});let order;for(;;){await new Promise(r=>setTimeout(r,3000));if(identity()!==viewer)throw Error('Wallet changed. Reopen trial history after processing completes');order=await api('/api/trial-jobs/'+job.id);if(order.state==='failed')throw Error(order.error);if(order.state==='ready')break;}if(order.simulation!==true)throw Error('Payment simulation not verified');feedback.textContent='Evaluation complete. Review payment to unlock the aggregate scorecard.';await pay(order,button)}finally{button.disabled=false;await account()}})};
 panel.addEventListener('submit',e=>{const f=e.target;if(f.dataset.trialPolicy){e.preventDefault();void run(async()=>{const enabled=e.submitter?.value!=='disable',fields=new FormData(f);if(enabled&&!fields.has('consent'))throw Error('Contributor consent is required');const price=Math.round(Number(fields.get('price'))*1e6);await api('/api/datasets/'+f.dataset.trialPolicy+'/trial-policy',{enabled,price,consent:true,pool:fields.has('pool'),overlap:fields.has('overlap'),impactTool:enabled?(fields.get('impactTool')||undefined):undefined});await account();await load();feedback.textContent=enabled?'Private benchmark enabled. Prompts and reference answers stay off the public offer.':'New trials disabled.'})}if(f.dataset.trialRecover){e.preventDefault();void run(async()=>{await requireIdentity();viewer=identity();const r=await api('/api/trial-orders/'+f.dataset.trialRecover+'/confirm',{signature:new FormData(f).get('signature').trim()});await account();scorecard(r)})}});
 panel.addEventListener('click',e=>{const b=e.target.closest('[data-trial-result],[data-trial-pay]');if(!b)return;void run(async()=>{await requireIdentity();viewer=identity();if(b.dataset.trialResult)scorecard(await api('/api/trial-orders/'+b.dataset.trialResult));else await pay(await api('/api/trial-orders/'+b.dataset.trialPay+'/payment',{}),b)})});
 document.addEventListener('loom-identity-change',clear);
 document.addEventListener('click',e=>{if(e.target.closest('[data-view="marketplace"]'))void run(load)});
 window.addEventListener('hashchange',()=>{if(location.hash==='#marketplace')void run(load)});if(location.hash==='#marketplace')void run(load);
}
