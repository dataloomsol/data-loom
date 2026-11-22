export function initConsentLedger({api,identity,money,refreshMarkets}) {
  const select=document.getElementById('ledger-version');
  const detail=document.getElementById('ledger-detail');
  const feedback=document.getElementById('ledger-feedback');
  const refreshButton=document.getElementById('ledger-refresh');
  let versions=[],generation=0;
  const make=(tag,text)=>{
    const node=document.createElement(tag);
    node.textContent=text;
    return node;
  };
  const date=value=>new Date(Number(value)).toLocaleString();
  const names={'pause-use':'All new use paused','resume-use':'Previous permissions resumed',publish:'File licensing enabled','stop-future-sales':'File licensing disabled','query-enabled':'Paid answers enabled','query-disabled':'Paid answers disabled','trial-enabled':'Blind trials enabled','trial-disabled':'Blind trials disabled'};

  async function show(before) {
    const version=versions.find(d=>d.id===select.value);
    if(!version){detail.replaceChildren();return;}
    const request=++generation;
    const wallet=identity();
    const path='/api/datasets/'+encodeURIComponent(version.id);
    const data=await api(path+'/consent-ledger'+(before===undefined?'':'?before='+before));
    if(request!==generation||wallet!==identity())return;
    if(before===undefined){
      const paused=Number(version.paused)===1;
      const toggle=make('button',paused?'Resume previous permissions':'Pause new use');
      toggle.className='secondary';
      toggle.onclick=async()=>{
        if(!window.confirm(paused?'Resume new use under this version’s saved permissions?':'Pause new use for this version? Existing licenses, receipts, submitted reports, prepared purchases and work already underway remain available.'))return;
        toggle.disabled=true;
        try{
          await api(path+'/consent-pause',{paused:!paused});
          await refresh();
          await refreshMarkets();
        }catch(error){feedback.textContent=error.message;toggle.disabled=false;}
      };
      const commitment=make('code',version.commitment);
      detail.replaceChildren(make('h4',version.title),commitment,
        make('p',paused?'New use paused':'New use follows the saved permissions'),
        make('p',`Saved permissions · File licenses ${version.state==='published'?'on':'off'} · Paid answers ${Number(version.queries)===1?'on':'off'} · Blind trials ${Number(version.trials)===1?'on':'off'}`),
        make('p','Finalized contributor earnings · '+money(data.total)+' USDC'+(Number(data.totals?.DATALOOM)>0?' · '+money(data.totals.DATALOOM)+' DATALOOM':'')),toggle,make('h4','Usage and permission history'));
      if(!data.events.length)detail.append(make('p','No recorded usage or permission changes yet.'));
    }
    for(const event of data.events){
      const entry=make('article','');
      entry.className='account-record';
      entry.append(make('strong',names[event.state]||event.kind+' · '+event.state),make('p',date(event.created)));
      if(event.terms)entry.append(make('p',event.terms));
      if(event.signature){
        const receipt=make('a','View finalized Solana transaction ↗');
        receipt.href='https://explorer.solana.com/tx/'+encodeURIComponent(event.signature);
        receipt.target='_blank';
        receipt.rel='noopener noreferrer';
        entry.append(make('p',money(event.amount)+' '+(event.currency==='DATALOOM'?'DATALOOM':'USDC')+' earned'),receipt);
      }
      detail.append(entry);
    }
    if(data.nextBefore!==null){
      const more=make('button','Older activity');
      more.onclick=async()=>{more.disabled=true;try{await show(data.nextBefore);more.remove();}catch(error){feedback.textContent=error.message;more.disabled=false;}};
      detail.append(more);
    }
  }

  async function refresh() {
    const wallet=identity();
    const request=++generation;
    if(!wallet)return;
    refreshButton.disabled=true;
    try{
      feedback.textContent='';
      const records=await api('/api/my/consent-ledger');
      if(request!==generation||wallet!==identity())return;
      const previous=select.value;
      versions=records;
      select.replaceChildren(...records.map(d=>new Option(d.title+' · '+d.commitment.slice(0,10),d.id)));
      if(records.some(d=>d.id===previous))select.value=previous;
      if(!records.length)feedback.textContent='Save a dataset to start its ledger.';
      await show();
    }catch(error){if(wallet===identity())feedback.textContent=error.message;}
    finally{refreshButton.disabled=false;}
  }
  refreshButton.onclick=refresh;
  select.onchange=()=>{detail.replaceChildren();void show().catch(error=>{feedback.textContent=error.message;});};
  document.addEventListener('loom-identity-change',()=>{
    generation++;
    versions=[];
    select.replaceChildren();
    detail.replaceChildren();
    feedback.textContent='';
  });
  return refresh;
}
