import { createHmac, randomUUID } from 'node:crypto';
import { USDC } from './settlement.mjs';

export async function installSettlementHook(app, { db, env }) {
  const endpoint = env.SETTLEMENT_WEBHOOK_URL;
  const secret = env.SETTLEMENT_WEBHOOK_SECRET;
  if (!endpoint && !secret) return;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || !secret || secret.length < 32) {
    throw Error('Settlement webhook requires an HTTPS URL and a secret of at least 32 characters');
  }

  await db.query(`CREATE TABLE IF NOT EXISTS settlement_deliveries (
    signature TEXT PRIMARY KEY, claim TEXT, retry_at BIGINT NOT NULL, delivered INTEGER NOT NULL
  )`);

  let running = false;
  async function deliver() {
    if (running) return;
    running = true;
    try {
      const { rows } = await db.query(`
        SELECT p.* FROM (
          SELECT id, signature, created, 'query' AS kind, seller_amount, platform_amount,
            (SELECT summary FROM query_receipts r WHERE r.order_id=o.id) AS summary
            FROM query_orders o WHERE state='answered' AND signature IS NOT NULL
          UNION ALL
          SELECT id, signature, created, 'dataset', seller_amount, platform_amount, NULL
            FROM orders WHERE state='paid' AND signature IS NOT NULL
        ) p LEFT JOIN settlement_deliveries d ON d.signature=p.signature
        WHERE d.signature IS NULL OR (d.delivered=0 AND d.retry_at<=?)
        ORDER BY p.created, p.id LIMIT 20`, [Date.now()]);
      for (const payment of rows) {
        const claim = randomUUID();
        const now = Date.now();
        const claimed = await db.query(`
          INSERT INTO settlement_deliveries(signature,claim,retry_at,delivered) VALUES(?,?,?,0)
          ON CONFLICT(signature) DO UPDATE SET claim=excluded.claim,retry_at=excluded.retry_at
          WHERE settlement_deliveries.delivered=0 AND settlement_deliveries.retry_at<=?
          RETURNING signature`, [payment.signature, claim, now+120000, now]);
        if (!claimed.rows.length) continue;
        try {
          const summary = JSON.parse(payment.summary ?? '{}');
          const body = JSON.stringify({
            type: 'dataloom.settlement.finalized.v1',
            eventId: payment.signature,
            signature: payment.signature,
            orderId: payment.id,
            kind: payment.kind,
            network: 'solana:mainnet',
            currency: summary.currency ?? 'USDC',
            mint: summary.mint ?? USDC,
            contributorPayout: String(payment.seller_amount),
            platformFee: String(payment.platform_amount),
            burn: String(summary.burnAmount ?? '0'),
            buybackReserve: String(summary.buybackAmount ?? '0'),
          });
          const timestamp = String(Math.floor(Date.now()/1000));
          const mac = createHmac('sha256', secret).update(timestamp+'.'+body).digest('hex');
          const response = await fetch(url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { 'Content-Type': 'application/json', 'X-Data-Loom-Timestamp': timestamp,
              'X-Data-Loom-Signature': 'sha256='+mac, 'Idempotency-Key': payment.signature },
            body,
          });
          await response.body?.cancel();
          if (response.ok) await db.query(
            'UPDATE settlement_deliveries SET delivered=1 WHERE signature=? AND claim=?',
            [payment.signature, claim]);
        } catch {
          // The claim expires so network failures and interrupted workers can retry.
        }
      }
    } finally {
      running = false;
    }
  }

  const tick = () => void deliver().catch(() => console.error('Settlement hook delivery scan failed'));
  const timer = setInterval(tick, 15000);
  timer.unref();
  app.once('loom-close', () => clearInterval(timer));
  tick();
}
