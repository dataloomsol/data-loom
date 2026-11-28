export function initExclusivity({panel,api,requireIdentity,identity,money,beginPurchase}) {
  const section = document.createElement('section');
  section.hidden = true;
  section.innerHTML = `<h3>Proof of Exclusivity</h3>
    <p>Reserve an active draft for one buyer at its saved price. The version stays reserved after the license ends.</p>
    <form data-create>
      <label>Draft dataset version ID<input name="dataset" required></label>
      <label>Buyer wallet address<input name="buyer" required></label>
      <label>Permitted use<select name="use">
        <option value="research">Research</option>
        <option value="commercial-analysis">Commercial analysis</option>
        <option value="model-evaluation">Model evaluation</option>
        <option value="model-training">Model training</option>
      </select></label>
      <label>Market or territory<input name="market" maxlength="80" required></label>
      <label>License starts (local time)<input name="start" type="datetime-local" required></label>
      <label>License ends (local time)<input name="end" type="datetime-local" required></label>
      <label class="consent"><input name="consent" type="checkbox" required> Permanently reserve this version and allow the paid proof to disclose its scope</label>
      <button>Create exclusive offer</button>
    </form>
    <form data-view>
      <label>Offer ID<input name="id" required></label>
      <button>Review offer</button>
    </form>
    <p role="status"></p>
    <button data-checkout type="button" hidden>Review USDC payment</button>
    <a data-proof hidden>Open attested proof JSON</a>
    <p><a href="/tools/proof-of-exclusivity.md">Scope and verification guide</a></p>`;
  panel.append(section);
  const base = '/api/exclusivity';
  const status = section.querySelector('[role=status]');
  const create = section.querySelector('[data-create]');
  const view = section.querySelector('[data-view]');
  const checkout = section.querySelector('[data-checkout]');
  const proof = section.querySelector('[data-proof]');
  api(base+'/status').then(config=>{
    section.hidden = !config.enabled;
    create.hidden = !config.checkout;
  }).catch(()=>{});

  let offer;
  function clear() {
    offer = null;
    status.textContent = '';
    checkout.hidden = proof.hidden = true;
    proof.removeAttribute('href');
  }
  async function run(button,action) {
    button.disabled = true;
    try {
      await requireIdentity();
      const viewer = identity();
      const result = await action();
      if (identity()===viewer && result) result();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  create.onsubmit = event=>{
    event.preventDefault();
    clear();
    const fields = new FormData(create);
    run(event.submitter,async()=>{
      const result = await api(base,{
        dataset:fields.get('dataset').trim(),buyer:fields.get('buyer').trim(),use:fields.get('use'),
        market:fields.get('market'),startsAt:new Date(fields.get('start')).getTime(),
        endsAt:new Date(fields.get('end')).getTime(),consent:fields.has('consent')
      });
      return ()=>{
        view.elements.namedItem('id').value = result.id;
        status.textContent = 'Offer created. Share this ID with the designated buyer: '+result.id;
      };
    });
  };
  view.onsubmit = event=>{
    event.preventDefault();
    clear();
    run(event.submitter,async()=>{
      const result = await api(base+'/'+encodeURIComponent(new FormData(view).get('id').trim()));
      return ()=>{
        offer = result;
        const range = [result.startsAt,result.endsAt].map(time=>new Date(time).toLocaleString()).join(' – ');
        status.textContent = `${result.title} · ${money(result.price)} USDC · ${result.use} in ${result.market} · ${range}. ${result.terms}`;
        checkout.hidden = !result.canBuy;
        proof.hidden = !result.paid;
        if (result.paid) proof.href = base+'/'+encodeURIComponent(result.id)+'/proof';
      };
    });
  };
  checkout.onclick = ()=>{
    if (!offer) return;
    const current = offer;
    run(checkout,async()=>{await beginPurchase(current.dataset,{...current,exclusive:true});});
  };
  return {clear};
}
