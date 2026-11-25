export function initDataCoverage({panel,api,requireIdentity,identity}) {
  const section = document.createElement('section');
  section.hidden = true;
  section.innerHTML = `<h3>Proof of Data Coverage</h3>
    <p>Share an attested claim about a private dataset version. The proof shows the thresholds and field name you choose.</p>
    <form>
      <label>Private dataset version<select name="dataset" required></select></label>
      <label>Category field<input name="categoryField" maxlength="100" placeholder="region" required></label>
      <label>Minimum categorized records<input name="minRecords" type="number" min="1" max="10000" required></label>
      <label>Minimum distinct categories<input name="minCategories" type="number" min="1" max="10000" required></label>
      <label class="consent"><input type="checkbox" name="consent" required> Share the dataset version, commitment, category field and thresholds with anyone who has the proof link</label>
      <button>Publish coverage proof</button>
      <button type="button" class="secondary" data-unpublish>Unpublish selected version’s proof</button>
    </form>
    <p role="status"></p>
    <p><a data-proof hidden>Open shareable proof</a></p>
    <p><a href="/tools/proof-of-data-coverage.md">Buyer verification guide</a></p>`;
  panel.append(section);
  const form = section.querySelector('form');
  const dataset = form.elements.dataset;
  const status = section.querySelector('[role=status]');
  const proof = section.querySelector('[data-proof]');
  const publish = form.querySelector('button');
  const unpublish = form.querySelector('[data-unpublish]');
  let revision = 0;

  api('/api/data-coverage/status').then(config => {section.hidden = !config.enabled;}).catch(() => {});

  function resetResult() {
    revision++;
    proof.hidden = true;
    proof.removeAttribute('href');
    status.textContent = '';
  }

  async function run(action) {
    resetResult();
    const current = revision;
    const fields = new FormData(form);
    publish.disabled = unpublish.disabled = true;
    try {
      const wallet = await requireIdentity();
      if (current !== revision || identity() !== wallet) return;
      await action(fields,() => current === revision && identity() === wallet);
    } catch (error) {
      if (current === revision) status.textContent = error.message;
    } finally {
      publish.disabled = unpublish.disabled = false;
    }
  }

  form.oninput = resetResult;
  form.onsubmit = event => {
    event.preventDefault();
    return run(async (fields,isCurrent) => {
      const result = await api('/api/my/data-coverage',{
        dataset:fields.get('dataset'),
        categoryField:fields.get('categoryField').trim(),
        minRecords:Number(fields.get('minRecords')),
        minCategories:Number(fields.get('minCategories')),
        consent:fields.has('consent')
      });
      if (!isCurrent()) return;
      proof.href = result.path;
      proof.hidden = false;
      status.textContent = 'Proof published. Share the link with your buyer.';
    });
  };
  unpublish.onclick = () => {
    if (!dataset.value) return;
    return run(async (fields,isCurrent) => {
      await api('/api/my/data-coverage/'+encodeURIComponent(fields.get('dataset')),undefined,'DELETE');
      if (isCurrent()) status.textContent = 'Proof unpublished.';
    });
  };

  return {
    setDatasets(datasets) {
      const selected = dataset.value;
      dataset.replaceChildren(new Option('Select a private dataset version',''));
      for (const item of datasets) {
        if (item.state !== 'published') dataset.add(new Option(item.title,item.id));
      }
      dataset.value = [...dataset.options].some(option => option.value === selected) ? selected : '';
    },
    clear() {
      form.reset();
      dataset.replaceChildren();
      resetResult();
    }
  };
}
