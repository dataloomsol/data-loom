/**
 * Reserve from one lifetime release budget shared across buyers and table owners.
 * Values use integer thousandths of epsilon. The caller must reserve before
 * computing or exposing any private-dependent result.
 */
export async function initializePrivateSqlBudget(db, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('The privacy budget must be a positive integer');
  }
  await db.query(`CREATE TABLE IF NOT EXISTS private_sql_budget (
    scope TEXT PRIMARY KEY,
    initial_budget BIGINT NOT NULL CHECK (initial_budget > 0),
    remaining BIGINT NOT NULL CHECK (remaining >= 0 AND remaining <= initial_budget)
  )`);
  await db.query(`INSERT INTO private_sql_budget(scope, initial_budget, remaining)
    VALUES (?, ?, ?) ON CONFLICT (scope) DO NOTHING`, ['exchange', limit, limit]);
  const budget = await db.one('SELECT initial_budget FROM private_sql_budget WHERE scope=?', ['exchange']);
  if (Number(budget.initial_budget) !== limit) {
    throw new Error('The configured privacy budget differs from the persisted budget');
  }
}

export async function reservePrivateSqlBudget(db, cost) {
  if (!Number.isSafeInteger(cost) || cost <= 0) {
    throw new RangeError('The privacy cost must be a positive integer');
  }
  const updated = await db.one(`UPDATE private_sql_budget
    SET remaining=remaining-? WHERE scope=? AND remaining>=?
    RETURNING remaining`, [cost, 'exchange', cost]);
  return updated ? { remaining: Number(updated.remaining) } : null;
}
