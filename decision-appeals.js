export function initDecisionAppeals({panel, api, requireIdentity, identity}) {
  const base = '/api/my/decision-appeals';
  const section = document.createElement('section');
  section.innerHTML = `<h3>Private Decision Appeals</h3>
    <p>Ask the dataset contributor to review an eligible paid decision. Appeal notes are shared with that contributor.</p>
    <form>
      <label>Paid call ID<input name="call" required></label>
      <label>Reason for appeal<textarea name="note" minlength="3" maxlength="2000" required></textarea></label>
      <label class="consent"><input type="checkbox" name="consent" required> Share this note with the contributor</label>
      <button>Open appeal</button>
    </form>
    <button type="button" class="secondary" data-refresh>Refresh appeals</button>
    <p role="status"></p><div data-appeals></div>`;
  panel.append(section);
  const form = section.querySelector('form');
  const list = section.querySelector('[data-appeals]');
  const status = section.querySelector('[role=status]');
  let revision = 0;

  function appendText(parent, tag, value) {
    const node = document.createElement(tag);
    node.textContent = value;
    parent.append(node);
    return node;
  }

  async function run(button, task) {
    const current = revision;
    button.disabled = true;
    status.textContent = '';
    try {
      const wallet = await requireIdentity();
      if (current === revision && identity() === wallet) await task(wallet);
    } catch (error) {
      if (current === revision) status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function addForm(card, label, field, submit) {
    const controls = document.createElement('form');
    const caption = appendText(controls, 'label', label);
    const entry = document.createElement(field === 'note' ? 'textarea' : 'input');
    entry.required = true;
    entry.maxLength = field === 'note' ? 2000 : 36;
    caption.append(entry);
    const button = appendText(controls, 'button', label);
    controls.onsubmit = event => {
      event.preventDefault();
      run(button, wallet => submit(entry.value.trim(), wallet));
    };
    card.append(controls);
  }

  function render(item) {
    const card = document.createElement('article');
    card.className = 'account-record';
    appendText(card, 'h4', `${item.role === 'buyer' ? 'Your appeal' : 'Appeal to review'} · ${item.state.replaceAll('-', ' ')}`);
    appendText(card, 'p', 'Call ' + item.call);
    for (const [label, key] of [['Issue','issue'],['Evidence request','question'],['Evidence','evidence'],['Resolution','resolution']]) {
      if (item[key]) appendText(card, 'p', label + ': ' + item[key]);
    }
    function action(label, name) {
      addForm(card, label, 'note', async (note, wallet) => {
        await api(`${base}/${item.id}/action`, {action: name, note});
        await refresh(wallet);
      });
    }
    if (item.role === 'reviewer') {
      if (item.state === 'open') action('Request evidence', 'request-evidence');
      if (['open','evidence-submitted'].includes(item.state)) action('Record resolution', 'resolve');
    } else {
      if (item.state === 'evidence-requested') action('Submit evidence', 'submit-evidence');
      appendText(card, 'p', 'To compare decisions, run and pay for the same input under the same grant, then enter the later call ID.');
      const result = appendText(card, 'p', '');
      addForm(card, 'Compare a later paid call', 'call', async (call, wallet) => {
        const comparison = await api(`${base}/${item.id}/compare`, {call});
        if (identity() === wallet && card.isConnected) {
          result.textContent = `${comparison.original.decision} → ${comparison.rerun.decision}. Receipts ${comparison.original.receipt} and ${comparison.rerun.receipt}.`;
        }
      });
    }
    list.append(card);
  }

  async function refresh(wallet) {
    if (identity() !== wallet) return;
    const current = revision;
    const {appeals} = await api(base);
    if (revision !== current || identity() !== wallet) return;
    list.replaceChildren();
    for (const item of appeals) render(item);
    if (!appeals.length) appendText(list, 'p', 'No appeals yet.');
  }

  form.onsubmit = event => {
    event.preventDefault();
    run(form.querySelector('button'), async wallet => {
      const body = new FormData(form);
      await api(base, {call: body.get('call').trim(), note: body.get('note'), consent: body.has('consent')});
      if (identity() === wallet) form.reset();
      await refresh(wallet);
    });
  };
  const button = section.querySelector('[data-refresh]');
  button.onclick = () => run(button, refresh);

  return {clear() { revision++; form.reset(); list.replaceChildren(); status.textContent = ''; }};
}
