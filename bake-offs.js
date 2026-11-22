export function initBakeOffs({api,requireIdentity,escape}) {
  const panel = document.querySelector('#bake-off-panel');
  const find = selector => panel.querySelector(selector);
  const status = find('[data-bake-status]');
  const output = find('[data-bake-results]');
  const open = find('[data-bake-open]');
  const create = find('[data-bake-create]');
  const datasets = find('[data-bake-datasets]');
  let models = [], selected;
  const route = id => '/api/bake-offs/'+encodeURIComponent(id);

  async function run(button, action) {
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
      status.textContent = '';
      await action();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function score(entry) {
    if (entry.state !== 'complete') return escape(entry.state);
    const cost = entry.reportedCostUsd == null ? 'Cost unavailable' :
      new Intl.NumberFormat('en', {style:'currency',currency:'USD',maximumFractionDigits:8}).format(entry.reportedCostUsd);
    return `${entry.correct}/${entry.total} correct · ${entry.averageLatencyMs} ms avg · ${escape(cost)} · ${entry.verifiedReceipts} verified receipts`;
  }

  async function load(id) {
    selected = null;
    output.replaceChildren();
    const data = await api(route(id));
    selected = data.id;
    open.elements.id.value = data.id;
    const rows = data.entries ?? (data.own ? [data.own] : []);
    output.innerHTML = `<h4>${escape(data.title)}</h4><p>Share ID <code>${escape(data.id)}</code></p>
      ${rows.map(entry => `<p><strong>${escape(entry.label)}</strong> · ${escape(entry.model)}<br>${score(entry)}
        ${entry.state==='submitted'&&entry.id?` <button class="secondary" data-bake-evaluate="${escape(entry.id)}">Run evaluation</button>`:''}</p>`).join('')}
      ${data.role==='sponsor'?`<button class="secondary" data-bake-publish="${!data.published}">${data.published?'Withdraw rankings':'Publish rankings'}</button>`:''}
      ${data.role==='vendor'&&!data.own&&!data.published&&models.length?`<form data-bake-entry>
        <label>Public entry label<input name="label" maxlength="60" required></label>
        <label>Model<select name="model">${models.map(model=>`<option>${escape(model)}</option>`).join('')}</select></label>
        <label>Candidate instructions (optional)<textarea name="prompt" maxlength="4000"></textarea></label>
        <label class="consent"><input type="checkbox" required> I agree that the sponsor may publish my entry label, model and aggregate results.</label>
        <button>Submit candidate</button></form>`:''}
      ${data.rankings?`<h4>${data.published?'Published rankings':'Private rankings preview'}</h4><ol>${data.rankings.map(row=>`<li>${escape(row.label)} · ${escape(row.model)}<br>${score(row)}</li>`).join('')}</ol>`:''}`;
  }

  datasets.onclick = () => run(datasets, async () => {
    await requireIdentity();
    const list = await api('/api/bake-offs/datasets');
    create.elements.dataset.innerHTML = list.length ? list.map(item =>
      `<option value="${escape(item.id)}">${escape(item.title)}</option>`).join('') :
      '<option value="">Enable your own private benchmark first</option>';
  });
  create.onsubmit = event => {
    event.preventDefault();
    void run(event.submitter, async () => {
      await requireIdentity();
      const form = new FormData(create);
      const data = await api('/api/bake-offs', {title:form.get('title'),dataset:form.get('dataset'),
        vendors:form.get('vendors').trim().split(/[\s,]+/)});
      await load(data.id);
    });
  };
  find('[data-bake-sign-in]').onclick = event => run(event.currentTarget, async () => {
    await requireIdentity();
    if (open.elements.id.value.trim()) await load(open.elements.id.value.trim());
  });
  open.onsubmit = event => {
    event.preventDefault();
    void run(event.submitter, () => load(open.elements.id.value.trim()));
  };
  output.onsubmit = event => {
    if (!event.target.matches('[data-bake-entry]')) return;
    event.preventDefault();
    void run(event.submitter, async () => {
      const id = selected;
      const form = new FormData(event.target);
      await api(route(id)+'/entries', {label:form.get('label'),model:form.get('model'),prompt:form.get('prompt'),consentToPublish:true});
      await load(id);
    });
  };
  output.onclick = event => {
    const button = event.target.closest('[data-bake-evaluate],[data-bake-publish]');
    if (!button) return;
    void run(button, async () => {
      const id = selected;
      if (button.dataset.bakeEvaluate) {
        await api(route(id)+'/evaluate/'+encodeURIComponent(button.dataset.bakeEvaluate), {});
      } else {
        await api(route(id)+'/publication', {published:button.dataset.bakePublish==='true'});
      }
      await load(id);
    });
  };
  document.addEventListener('loom-identity-change', () => {
    output.replaceChildren();
    selected = null;
  });
  void api('/api/bake-offs/status').then(data => {
    models = data.models;
    if (!data.available) status.textContent = 'Verified evaluations are currently unavailable.';
  }).catch(error => { status.textContent = error.message; });
}
