export function initDatasetDiff({panel, api, requireIdentity, identity}) {
  const section = document.createElement('section');
  section.innerHTML = `
    <h3>Private Dataset Diff</h3>
    <p>Compare two of your JSON datasets. Edited rows count as one removal and one addition. The summary contains counts only.</p>
    <form>
      <label>Earlier dataset<select name="before" required></select></label>
      <label>Later dataset<select name="after" required></select></label>
      <label>Category field (optional)<input name="category" maxlength="100"></label>
      <button>Compare datasets</button>
    </form>
    <p role="status"></p>
    <pre hidden></pre>
  `;
  panel.append(section);
  const form = section.querySelector('form');
  const button = form.querySelector('button');
  const feedback = section.querySelector('[role=status]');
  const output = section.querySelector('pre');
  let revision = 0;

  function clearReport() {
    revision++;
    output.hidden = true;
    output.textContent = '';
    feedback.textContent = '';
  }

  form.oninput = clearReport;
  form.onsubmit = async event => {
    event.preventDefault();
    clearReport();
    const current = revision;
    const body = Object.fromEntries(new FormData(form));
    button.disabled = true;
    try {
      const viewer = await requireIdentity();
      const result = await api('/api/my/dataset-diff', body);
      if (current !== revision || identity() !== viewer) return;
      const {records, fields, coverage} = result;
      const lines = [
        `Rows: ${records.before} → ${records.after}`,
        `Unchanged: ${records.unchanged} · Added: ${records.added} · Removed: ${records.removed}`,
        `Fields added: ${fields.added} · Fields removed: ${fields.removed}`
      ];
      if (coverage) lines.push(
        `Categories: ${coverage.before} → ${coverage.after}`,
        `Categories with changed counts: ${coverage.categoriesWithCountChanges}`,
        `Rows without a category: ${coverage.missingBefore} → ${coverage.missingAfter}`
      );
      output.textContent = lines.join('\n');
      output.hidden = false;
      feedback.textContent = 'Comparison complete.';
    } catch (error) {
      if (current === revision) feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };

  return {
    setDatasets(datasets) {
      for (const name of ['before', 'after']) {
        const select = form.elements[name];
        const selected = select.value;
        select.replaceChildren(new Option('Select a dataset', ''), ...datasets.map(dataset =>
          new Option(`${dataset.title} · ${new Date(dataset.created).toLocaleDateString()} · ${dataset.id.slice(0, 8)}`, dataset.id)));
        if (datasets.some(dataset => dataset.id === selected)) select.value = selected;
      }
    },
    clear() {
      form.reset();
      this.setDatasets([]);
      clearReport();
    }
  };
}
