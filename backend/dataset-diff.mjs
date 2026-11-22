import {z} from 'zod';
import {hash} from './security.mjs';

const rows = z.array(z.record(z.string(), z.json())).max(10000);
const request = z.object({
  before: z.string().uuid(),
  after: z.string().uuid(),
  category: z.string().trim().max(100).optional()
});

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function summarize(records, category) {
  const counts = new Map();
  const fields = new Set();
  const categories = new Map();
  let missingCategory = 0;
  for (const record of records) {
    const key = canonical(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const field of Object.keys(record)) fields.add(field);
    if (!category) continue;
    const value = Object.hasOwn(record, category) ? record[category] : null;
    if (typeof value !== 'string' || !value.trim()) {
      missingCategory++;
      continue;
    }
    categories.set(value, (categories.get(value) ?? 0) + 1);
  }
  return {counts, fields, categories, missingCategory};
}

export function compareDatasets(before, after, category) {
  const oldRows = rows.parse(JSON.parse(before));
  const newRows = rows.parse(JSON.parse(after));
  const old = summarize(oldRows, category);
  const next = summarize(newRows, category);
  let unchanged = 0;
  for (const [key, count] of old.counts) unchanged += Math.min(count, next.counts.get(key) ?? 0);
  const fieldChanges = (a, b) => [...a].filter(field => !b.has(field)).length;
  return {
    records: {before: oldRows.length, after: newRows.length, unchanged,
      added: newRows.length - unchanged, removed: oldRows.length - unchanged},
    fields: {added: fieldChanges(next.fields, old.fields), removed: fieldChanges(old.fields, next.fields)},
    coverage: category ? {
      before: old.categories.size,
      after: next.categories.size,
      categoriesWithCountChanges: [...new Set([...old.categories.keys(), ...next.categories.keys()])]
        .filter(key => old.categories.get(key) !== next.categories.get(key)).length,
      missingBefore: old.missingCategory,
      missingAfter: next.missingCategory
    } : null
  };
}

export function installDatasetDiff(app, {db, storage, authenticated}) {
  app.get('/api/dataset-diff/status', (_req, res) => res.json({enabled:true, maxRows:10000}));
  app.post('/api/my/dataset-diff', authenticated, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const {before, after, category} = request.parse(req.body);
    if (before === after) return res.status(400).json({error:'Select two different dataset versions.'});
    const versions = await Promise.all([before, after].map(id =>
      db.one('SELECT id, commitment FROM datasets WHERE id=? AND owner=?', [id, req.wallet])));
    if (versions.some(version => !version)) return res.status(404).json({error:'Dataset version not found.'});
    const objects = await Promise.all(versions.map(version => storage.get(version.id)));
    if (objects.some((object, index) => !object.salt || hash(object.salt + '\n' + object.content) !== versions[index].commitment)) {
      return res.status(409).json({error:'Dataset commitment verification failed.'});
    }
    let summary;
    try {
      summary = compareDatasets(objects[0].content, objects[1].content, category);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      return res.status(422).json({error:'Each version must be a JSON array of up to 10,000 objects.'});
    }
    res.json(summary);
  });
}
