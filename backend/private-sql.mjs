import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { unpaused } from './consent-ledger.mjs';
import { hash, validWallet } from './security.mjs';
import { initializePrivateSqlBudget, reservePrivateSqlBudget } from './private-sql-budget.mjs';

const id = z.string().uuid();
const grant = z.object({
  dataset: id,
  buyer: z.string().refine(validWallet),
  column: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
  equals: z.string().max(120),
  enabled: z.boolean()
}).strict();
const table = z.array(z.record(z.string(), z.unknown())).max(10000);
const cost = 250;
const threshold = 30;
const mechanism = 'row-level noisy pooled COUNT WHERE column = value';
const loadTable = async (storage, dataset) => table.parse(JSON.parse((await storage.get(dataset)).content));

export async function installPrivateSql(app, {db, storage, authenticated, protectedRuntime}) {
  app.get('/api/private-sql/status', (req, res) => res.json({enabled: protectedRuntime}));
  if (!protectedRuntime) return;

  await initializePrivateSqlBudget(db, 4000);
  await db.query(`CREATE TABLE IF NOT EXISTS private_sql_grants (
    dataset TEXT NOT NULL, buyer TEXT NOT NULL, policy TEXT NOT NULL,
    PRIMARY KEY(dataset,buyer)
  )`);

  app.post('/api/private-sql/grants', authenticated, async (req, res) => {
    const {dataset, buyer, column, equals, enabled} = grant.parse(req.body);
    if (!await db.one('SELECT id FROM datasets WHERE id=? AND owner=?', [dataset,req.wallet])) {
      return res.status(404).json({error:'Dataset version not found'});
    }
    if (!enabled) {
      await db.query('DELETE FROM private_sql_grants WHERE dataset=? AND buyer=?', [dataset,buyer]);
      return res.json({enabled:false});
    }
    try {
      await loadTable(storage, dataset);
    } catch {
      return res.status(422).json({error:'Upload a dataset containing a JSON array of row objects'});
    }
    const policy = JSON.stringify({column,equals});
    await db.query(`INSERT INTO private_sql_grants(dataset,buyer,policy) VALUES (?,?,?)
      ON CONFLICT(dataset,buyer) DO UPDATE SET policy=excluded.policy`, [dataset,buyer,policy]);
    res.json({enabled:true});
  });

  app.get('/api/private-sql/grants', authenticated, async (req, res) => {
    const {rows} = await db.query(`SELECT g.dataset,d.title,g.policy FROM private_sql_grants g
      JOIN datasets d ON d.id=g.dataset WHERE g.buyer=? AND ${unpaused}`, [req.wallet]);
    res.json(rows.map(row => ({...row, policy:JSON.parse(row.policy)})));
  });

  app.post('/api/private-sql/query', authenticated, async (req, res) => {
    const datasets = z.array(id).min(2).max(5).parse(req.body.datasets);
    if (new Set(datasets).size !== datasets.length) {
      return res.status(400).json({error:'Choose distinct dataset versions'});
    }
    const {rows} = await db.query(`SELECT g.dataset,d.owner,d.commitment,g.policy
      FROM private_sql_grants g JOIN datasets d ON d.id=g.dataset
      WHERE g.buyer=? AND g.dataset IN (${datasets.map(() => '?').join(',')})
      AND ${unpaused} ORDER BY g.dataset`, [req.wallet,...datasets]);
    if (rows.length !== datasets.length || new Set(rows.map(row => row.owner)).size !== rows.length) {
      return res.status(403).json({error:'Each table requires permission from a different owner'});
    }
    if (new Set(rows.map(row => row.policy)).size !== 1) {
      return res.status(400).json({error:'All owners must authorize the same count filter'});
    }
    if (!await reservePrivateSqlBudget(db, cost)) {
      return res.status(429).json({error:'The shared privacy budget is exhausted'});
    }

    const query = JSON.parse(rows[0].policy);
    const tables = await Promise.all(rows.map(row => loadTable(storage,row.dataset)));
    const count = tables.reduce((total, entries) => total + entries.filter(row =>
      Object.hasOwn(row,query.column) && row[query.column] === query.equals).length, 0);
    // The sensitivity is one under add/remove-one-row adjacency across the pool.
    // Thresholding the noisy value avoids exposing the exact threshold decision.
    const uniform = (randomInt(2 ** 47) + 0.5) / (2 ** 47) - 0.5;
    const noisyCount = Math.round(count - Math.sign(uniform) * Math.log1p(-2 * Math.abs(uniform)) / (cost / 1000));
    const receipt = {
      mechanism, query,
      sources: rows.map(({dataset,commitment,policy}) => ({dataset,commitment,policy:JSON.parse(policy)})),
      minimumNoisyCount:threshold, epsilon:cost / 1000, created:new Date().toISOString(),
      count:noisyCount >= threshold ? noisyCount : null
    };
    res.json({...receipt, digest:hash(JSON.stringify(receipt))});
  });
}
