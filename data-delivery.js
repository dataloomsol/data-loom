export function initDataDelivery({panel,api,requireIdentity,identity}) {
  const section = document.createElement('section');
  section.hidden = true;
  section.innerHTML = `<h3>Private Data Delivery Webhooks</h3>
    <p>Receive a signed notification when a contributor releases a direct update that meets your checks.</p>
    <form data-subscribe>
      <label>Licensed parent version ID<input name="parent" required></label>
      <label>Minimum rows<input name="minimumRows" type="number" min="1" max="10000" value="1" required></label>
      <label>Required field in every row (optional)<input name="requiredField" maxlength="100"></label>
      <button>Save subscription</button>
    </form>
    <button type="button" data-list>Show my subscriptions</button>
    <ul data-subscriptions></ul>
    <form data-release>
      <label>Derived dataset version ID<input name="version" required></label>
      <label class="consent"><input type="checkbox" required> Share version metadata and passing check results with subscribed license holders</label>
      <button>Release update notification</button>
    </form>
    <p role="status"></p>
    <p><a href="/tools/private-data-delivery.md">Webhook setup and signature guide</a></p>`;
  panel.append(section);
  const subscribe = section.querySelector('[data-subscribe]');
  const release = section.querySelector('[data-release]');
  const list = section.querySelector('[data-subscriptions]');
  const status = section.querySelector('[role=status]');
  let revision = 0;

  api('/api/data-delivery/status').then(config => {section.hidden = !config.enabled;}).catch(() => {});

  async function run(button,action) {
    const current = ++revision;
    button.disabled = true;
    status.textContent = '';
    try {
      const wallet = await requireIdentity();
      const isCurrent = () => revision === current && identity() === wallet;
      if (isCurrent()) await action(isCurrent);
    } catch (error) {
      if (current === revision) status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function refresh(isCurrent) {
    const result = await api('/api/data-delivery/subscriptions');
    if (!isCurrent()) return;
    list.replaceChildren();
    if (!result.destinationConfigured) status.textContent = 'No approved webhook endpoint is configured for this wallet.';
    for (const subscription of result.subscriptions) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Unsubscribe';
      button.onclick = () => run(button,async current => {
        await api('/api/data-delivery/subscriptions/'+subscription.id,undefined,'DELETE');
        await refresh(current);
      });
      item.append(subscription.parent+' · minimum '+subscription.checks.minimumRows+' rows'+
        (subscription.checks.requiredField ? ' · required field '+subscription.checks.requiredField : '')+' ',button);
      list.append(item);
    }
    if (result.destinationConfigured && !result.subscriptions.length) status.textContent = 'No subscriptions.';
  }

  subscribe.onsubmit = event => {
    event.preventDefault();
    const fields = new FormData(subscribe);
    const requiredField = fields.get('requiredField').trim();
    return run(event.submitter ?? subscribe.querySelector('button'),async current => {
      await api('/api/data-delivery/subscriptions',{parent:fields.get('parent').trim(),
        checks:{minimumRows:Number(fields.get('minimumRows')),...(requiredField && {requiredField})}});
      await refresh(current);
      if (current()) status.textContent = 'Subscription saved.';
    });
  };

  release.onsubmit = event => {
    event.preventDefault();
    const version = new FormData(release).get('version').trim();
    return run(event.submitter ?? release.querySelector('button'),async current => {
      await api('/api/data-delivery/releases',{version,consent:true});
      if (current()) status.textContent = 'Release accepted. Matching subscribers will be notified.';
    });
  };
  const show = section.querySelector('[data-list]');
  show.onclick = () => run(show,refresh);

  return {clear() {revision++;subscribe.reset();release.reset();list.replaceChildren();status.textContent = '';}};
}
