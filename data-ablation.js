export function initDataAblation({panel,api,requireIdentity,identity}) {
  const section = document.createElement('section');
  section.hidden = true;
  section.innerHTML = `<h3>Confidential Data Ablation</h3>
    <p>Compare the accuracy contribution of several private training datasets on one held-out benchmark.</p>
    <p><a href="/tools/confidential-data-ablation.md">Study formats and verification guide</a></p>
    <form data-study>
      <label>Benchmark dataset version ID<input name="benchmark" required></label>
      <label>Training dataset version IDs, one per line<textarea name="sources" rows="3" required></textarea></label>
      <button>Create study</button>
    </form>
    <form data-permission>
      <label>Study ID<input name="study" required></label>
      <label>Your dataset version ID<input name="dataset" required></label>
      <label>Buyer wallet<input name="buyer" required></label>
      <label>Dataset role<select name="role"><option value="training">Training source</option><option value="benchmark">Held-out benchmark</option></select></label>
      <label class="consent"><input type="checkbox" required> Allow this study to use this version in the selected role and share rounded accuracy differences with the named buyer</label>
      <button value="approve">Approve study</button>
      <button value="revoke" formnovalidate>Revoke approval</button>
    </form>
    <form data-run>
      <label>Study ID<input name="study" required></label>
      <button>Run or retrieve study</button>
    </form>
    <p role="status"></p><ul data-deltas hidden></ul>
    <button type="button" data-download hidden>Download report and attestation</button>`;
  panel.append(section);
  const create = section.querySelector('[data-study]');
  const permission = section.querySelector('[data-permission]');
  const run = section.querySelector('[data-run]');
  const status = section.querySelector('[role=status]');
  const deltas = section.querySelector('[data-deltas]');
  const download = section.querySelector('[data-download]');
  let revision = 0;
  let result;

  api('/api/data-ablation/status').then(config => {section.hidden = !config.enabled;}).catch(() => {});

  function clearResult() {
    revision++;
    result = null;
    status.textContent = '';
    deltas.replaceChildren();
    deltas.hidden = download.hidden = true;
  }

  function bind(form,action) {
    form.oninput = clearResult;
    form.onsubmit = async event => {
      event.preventDefault();
      clearResult();
      const current = revision;
      const fields = Object.fromEntries(new FormData(form));
      const submitter = event.submitter ?? form.querySelector('button');
      submitter.disabled = true;
      try {
        const wallet = await requireIdentity();
        const stillCurrent = () => current === revision && wallet === identity();
        if (stillCurrent()) await action(fields,submitter.value,stillCurrent);
      } catch (error) {
        if (current === revision) status.textContent = error.message;
      } finally {
        submitter.disabled = false;
      }
    };
  }

  bind(create, async (fields,_action,stillCurrent) => {
    const study = await api('/api/data-ablation/studies',{
      benchmark:fields.benchmark.trim(),
      sources:fields.sources.split(/\r?\n/).map(id => id.trim()).filter(Boolean)
    });
    if (!stillCurrent()) return;
    run.elements.study.value = study.id;
    status.textContent = 'Share this study ID with all dataset owners for approval: '+study.id;
  });

  bind(permission, async (fields,action,stillCurrent) => {
    const approve = action === 'approve';
    await api('/api/data-ablation/studies/'+encodeURIComponent(fields.study.trim())+'/permission',{
      dataset:fields.dataset.trim(),buyer:fields.buyer.trim(),role:fields.role,approve
    });
    if (stillCurrent()) status.textContent = approve ? 'Study approved for this dataset version.' : 'Study approval revoked.';
  });

  bind(run, async (fields,_action,stillCurrent) => {
    const document = await api('/api/data-ablation/studies/'+encodeURIComponent(fields.study.trim())+'/run',{});
    if (!stillCurrent()) return;
    result = document;
    for (const {dataset,accuracyDeltaPoints} of document.report.differences) {
      const li = window.document.createElement('li');
      const formatted = accuracyDeltaPoints > 0 ? '+'+accuracyDeltaPoints : String(accuracyDeltaPoints);
      li.textContent = dataset+' · '+formatted+' percentage points';
      deltas.append(li);
    }
    status.textContent = 'Accuracy differences are rounded to the nearest 20 percentage points.';
    deltas.hidden = download.hidden = false;
  });

  download.onclick = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'data-loom-ablation.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  };

  return {clear() {create.reset();permission.reset();run.reset();clearResult();}};
}
