export function initSealedAuctions({panel,api,requireIdentity,identity,money,beginPurchase}) {
  const section = document.createElement('section');
  section.hidden = true;
  section.innerHTML = `<h3>Sealed Data Auctions</h3>
    <form data-create>
      <label>Draft dataset version ID<input name="dataset" required></label>
      <label>Reserve in USDC<input name="reserve" type="number" min="0.01" max="1000" step="0.000001" required></label>
      <label>Available licenses<input name="slots" type="number" min="1" max="50" required></label>
      <label>Closes at (local time)<input name="close" type="datetime-local" required></label>
      <label class="consent"><input type="checkbox" required> Publish the preview and auction rules and reserve this version for the auction</label>
      <button>Create auction</button>
    </form>
    <form data-bid>
      <label>Auction ID<input name="id" required></label>
      <label>Bid in USDC<input name="price" type="number" min="0.01" max="1000" step="0.000001"></label>
      <button value="view">View auction</button>
      <button value="bid">Submit sealed bid</button>
      <button value="finalize">Finalize closed auction</button>
      <button value="mine">View my bid</button>
    </form>
    <p role="status"></p>
    <a data-result hidden>Open auction and attestation JSON</a>
    <button data-pay hidden type="button">Review winning bid payment</button>
    <p><a href="/tools/sealed-data-auctions.md">Auction rules and verification guide</a></p>`;
  panel.append(section);
  const create = section.querySelector('[data-create]');
  const bid = section.querySelector('[data-bid]');
  const status = section.querySelector('[role=status]');
  const result = section.querySelector('[data-result]');
  const pay = section.querySelector('[data-pay]');
  let revision = 0;
  let checkout;
  let checkoutEnabled = false;
  const base = '/api/sealed-auctions';
  api(base+'/status').then(config => {
    checkoutEnabled = config.checkout;
    section.hidden = !config.enabled;
  }).catch(() => {});
  function clear() {
    revision++;
    status.textContent = '';
    result.hidden = pay.hidden = true;
    checkout = null;
  }
  async function run(button,action,signIn=true) {
    clear();
    const current = revision;
    button.disabled = true;
    try {
      const wallet = signIn ? await requireIdentity() : identity();
      const isCurrent = () => current === revision && wallet === identity();
      if (isCurrent()) await action(isCurrent);
    } catch (error) {
      if (current === revision) status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  create.onsubmit = event => {
    event.preventDefault();
    const fields = new FormData(create);
    return run(event.submitter ?? create.querySelector('button'),async current => {
      const opened = await api(base,{dataset:fields.get('dataset').trim(),
        reserveMicroUsdc:Math.round(Number(fields.get('reserve'))*1e6),
        licenseSlots:Number(fields.get('slots')),closesAt:new Date(fields.get('close')).getTime(),consent:true});
      if (!current()) return;
      bid.elements.id.value = opened.id;
      result.href = opened.path;
      result.hidden = false;
      status.textContent = 'Auction open. Share its ID and rules: '+opened.id;
    });
  };
  bid.oninput = clear;
  bid.onsubmit = event => {
    event.preventDefault();
    const fields = new FormData(bid);
    const chosen = event.submitter ?? bid.querySelector('button');
    const action = chosen.value;
    const url = base+'/'+encodeURIComponent(fields.get('id').trim());
    return run(chosen,async current => {
      if (action === 'bid') {
        if (!fields.get('price')) throw Error('Enter a bid in USDC.');
        const accepted = await api(url+'/bids',{amountMicroUsdc:Math.round(Number(fields.get('price'))*1e6)});
        if (current()) status.textContent = 'Bid sealed. Your receipt tag is '+accepted.tag;
        return;
      }
      if (action === 'finalize') await api(url+'/finalize',{});
      const auction = await api(url);
      const own = action === 'mine' ? await api(url+'/my-bid') : null;
      if (!current()) return;
      result.href = url;
      result.hidden = false;
      status.textContent = own ? 'Your bid: '+money(own.price)+' USDC · '+(own.won?'Winner':own.finalized?'Not selected':'Awaiting result')+' · '+own.tag
        : auction.title+' · '+auction.state+' · '+auction.rules.licenseSlots+' licenses · '+money(auction.rules.reserveMicroUsdc)+
          ' USDC reserve · pay your bid · earliest bid breaks ties · closes '+new Date(auction.rules.closesAt).toLocaleString();
      if (checkoutEnabled && own?.won) {checkout = auction;pay.hidden = false;}
    },action!=='view');
  };
  pay.onclick = () => {
    const auction = checkout;
    if (auction) return run(pay,async () => beginPurchase(auction.dataset,auction));
  };
  return {clear() {create.reset();bid.reset();clear();}};
}
