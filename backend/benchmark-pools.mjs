import { splitPayment } from './security.mjs';

export const POOL_TERMS = 'Private Benchmark Pools v1. One aggregate scorecard from multiple opted-in dataset versions, with normalized exact-match scoring. No individual outputs, case prompts, answer keys, file access or training rights. Each model receives prompts, never reference answers. Every response requires a verified Phala receipt. The total price is the sum of the selected benchmark prices, up to 1,000 USDC. Contributors split 70% by case count; 30% goes to Data Loom. Already prepared payments remain valid after opt-out.';

export function allocatePoolPayouts(sources, price) {
  const { seller } = splitPayment(price);
  const totalCases = BigInt(sources.reduce((sum, source) => sum + source.cases, 0));
  let cumulativeCases = 0n;
  return sources.map(source => {
    const start = seller * cumulativeCases / totalCases;
    cumulativeCases += BigInt(source.cases);
    return { ...source, amount: String(seller * cumulativeCases / totalCases - start) };
  });
}

export async function installPoolTables(db) {
  await db.query('CREATE TABLE IF NOT EXISTS trial_pool_opt_ins(dataset TEXT PRIMARY KEY, consented BIGINT NOT NULL)');
  await db.query('CREATE TABLE IF NOT EXISTS trial_pool_sources(order_id TEXT NOT NULL, dataset TEXT NOT NULL, owner TEXT NOT NULL, amount BIGINT NOT NULL, PRIMARY KEY(order_id,dataset))');
}
