export function initByom({panel,api,requireIdentity,identity}) {
  const section = document.createElement('section');
  section.hidden = true;
  section.innerHTML = `<h3>Bring Your Own Model</h3>
    <p>Evaluate a JSON linear text classifier on a private benchmark. The scorecard reports an accuracy band.</p>
    <p><a href="/tools/bring-your-own-model.md">Model format and verification guide</a></p>
    <form data-grant>
      <label>Benchmark dataset ID<input name="dataset" required></label>
      <label>Buyer wallet<input name="buyer" required></label>
      <label class="consent"><input type="checkbox" required> Authorize this wallet to receive one aggregate scorecard</label>
      <button name="permission" value="grant">Grant access</button>
      <button name="permission" value="revoke" formnovalidate>Revoke access</button>
    </form>
    <form data-run>
      <label>Benchmark dataset ID<input name="dataset" required></label>
      <label>Classifier JSON file<input name="model" type="file" accept=".json,application/json" required></label>
      <label class="consent"><input type="checkbox" required> Submit this model to the protected runtime for evaluation</label>
      <button value="run">Run benchmark</button>
      <button value="retrieve" formnovalidate>Retrieve scorecard</button>
    </form>
    <p role="status"></p><pre hidden></pre>
    <button type="button" data-download hidden>Download scorecard and attestation</button>`;
  panel.append(section);
  const grant = section.querySelector('[data-grant]');
  const run = section.querySelector('[data-run]');
  const status = section.querySelector('[role=status]');
  const report = section.querySelector('pre');
  const download = section.querySelector('[data-download]');
  let revision = 0, result;
  api('/api/byom/status').then(config => {section.hidden = !config.enabled;}).catch(() => {});

  function clearResult() {
    result = null;
    report.textContent = '';
    report.hidden = download.hidden = true;
  }

  async function submit(event, action) {
    event.preventDefault();
    const button = event.submitter || event.currentTarget.querySelector('button');
    const current = ++revision;
    button.disabled = true;
    status.textContent = '';
    clearResult();
    try {
      const wallet = await requireIdentity();
      const currentSession = () => current === revision && identity() === wallet;
      if (currentSession()) await action(button, currentSession);
    } catch (error) {
      if (current === revision) status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  grant.onsubmit = event => submit(event, async (button, currentSession) => {
    const enabled = button.value === 'grant';
    await api('/api/byom/grants',{dataset:grant.elements.dataset.value.trim(),
      buyer:grant.elements.buyer.value.trim(),enabled,consent:true});
    if (currentSession()) status.textContent = enabled ? 'Benchmark access granted.' : 'Benchmark access revoked.';
  });

  run.onsubmit = event => submit(event, async (button, currentSession) => {
    const dataset = run.elements.dataset.value.trim();
    const file = run.elements.model.files[0];
    let data;
    if (button.value === 'retrieve') {
      data = await api('/api/byom/scorecards/' + encodeURIComponent(dataset));
    } else {
      if (!file || file.size > 250000) throw Error('Select a JSON model file smaller than 250 KB.');
      const model = JSON.parse(await file.text());
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)),byte => byte.toString(16).padStart(2,'0')).join('');
      if (!currentSession()) return;
      data = await api('/api/byom/runs',{dataset,model,nonce,consent:true});
      if (currentSession()) run.elements.model.value = '';
    }
    if (!currentSession()) return;
    result = data;
    const {lower,upper,upperInclusive} = data.scorecard.accuracyPercent;
    report.textContent = `Accuracy band: ${lower}% to ${upperInclusive ? '' : 'under '}${upper}%\nBenchmark commitment: ${data.scorecard.sourceCommitment}\nModel hash: ${data.scorecard.modelHash}`;
    report.hidden = download.hidden = false;
  });

  download.onclick = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'data-loom-byom-' + result.scorecard.id + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  };

  return {clear() { revision++; grant.reset(); run.reset(); status.textContent = ''; clearResult(); }};
}
