export function initPrivateValidation({panel,api,requireIdentity,identity}) {
  const section = document.createElement('section');
  section.hidden = true;
  section.innerHTML = `<h3>Private Data Validation</h3>
    <p>Check every row in a private JSON dataset and download an attested pass/fail report.</p>
    <form>
      <label>Private dataset version ID<input name="dataset" required></label>
      <label>Check<select name="type"><option value="required-field">Required field</option><option value="date-range">Date range</option></select></label>
      <label>Field name<input name="field" required maxlength="100"></label>
      <fieldset hidden><legend>Inclusive date range</legend>
        <label>From<input type="date" name="from" disabled required></label>
        <label>To<input type="date" name="to" disabled required></label>
      </fieldset>
      <label class="consent"><input type="checkbox" name="consent" required> Authorize validation and creation of a report containing the rule and result</label>
      <button>Validate private dataset</button>
    </form>
    <p role="status"></p>
    <button type="button" class="secondary" data-download hidden>Download report and attestation</button>
    <p><a href="/tools/private-data-validation.md">Report verification guide</a></p>`;
  panel.append(section);
  const form = section.querySelector('form');
  const dates = section.querySelector('fieldset');
  const status = section.querySelector('[role=status]');
  const button = form.querySelector('button');
  const download = section.querySelector('[data-download]');
  let revision = 0, result;

  api('/api/private-validation/status').then(config => {section.hidden = !config.enabled;}).catch(() => {});

  function clearReport() {
    revision++;
    result = null;
    download.hidden = true;
    status.textContent = '';
  }

  function syncDates() {
    const range = form.elements.type.value === 'date-range';
    dates.hidden = !range;
    form.elements.from.disabled = form.elements.to.disabled = !range;
  }

  form.oninput = () => {clearReport();syncDates();};
  form.onsubmit = async event => {
    event.preventDefault();
    clearReport();
    const current = revision;
    button.disabled = true;
    try {
      const wallet = await requireIdentity();
      if (current !== revision || identity() !== wallet) return;
      const fields = new FormData(form);
      const rule = {type:fields.get('type'),field:fields.get('field').trim()};
      if (rule.type === 'date-range') {
        rule.from = fields.get('from');
        rule.to = fields.get('to');
        if (rule.from > rule.to) throw Error('Start date must precede or equal end date.');
      }
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
      const data = await api('/api/my/private-validation',{
        dataset:fields.get('dataset').trim(),rule,nonce,consent:fields.has('consent')
      });
      if (current !== revision || identity() !== wallet) return;
      result = data;
      status.textContent = data.report.passed ? 'Passed. Every row met the rule.' : 'Failed. At least one row did not meet the rule.';
      download.hidden = false;
    } catch (error) {
      if (current === revision) status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };

  download.onclick = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'data-loom-validation.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  };

  return {clear() { form.reset();clearReport();syncDates(); }};
}
