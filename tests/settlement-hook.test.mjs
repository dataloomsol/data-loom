import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../backend/db.mjs';
import { installSettlementHook } from '../backend/settlement-hook.mjs';

test('settlement delivers only finalized purchases and signs the exact token split', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-hook-'));
  const db = await openDb({ DATA_DIR: dir });
  const app = new EventEmitter();
  t.after(async () => {
    app.emit('loom-close');
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  await db.query('CREATE TABLE query_orders (id TEXT, signature TEXT, state TEXT, created INTEGER, seller_amount INTEGER, platform_amount INTEGER)');
  await db.query('CREATE TABLE query_receipts (order_id TEXT, summary TEXT)');
  await db.query("INSERT INTO query_orders VALUES ('q1','tx1','answered',1,70000000,16000000),('q2','tx2','prepared',2,70000000,16000000)");
  await db.query('INSERT INTO query_receipts VALUES (?,?)', ['q1', JSON.stringify({currency:'DATALOOM', mint:'token-mint', burnAmount:'4000000'})]);
  const secret = 'test-secret-for-settlement-webhook';
  const observed = once(app, 'delivery', { signal: AbortSignal.timeout(2000) });
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, request) => {
    app.emit('delivery', request);
    return new Response(null, {status:204});
  });

  await installSettlementHook(app, {db, env:{SETTLEMENT_WEBHOOK_URL:'https://finance.example/settlement', SETTLEMENT_WEBHOOK_SECRET:secret}});
  const [request] = await observed;
  const event = JSON.parse(request.body);
  assert.equal(event.signature, 'tx1');
  assert.equal(event.contributorPayout, '70000000');
  assert.equal(event.platformFee, '16000000');
  assert.equal(event.burn, '4000000');
  const expected = createHmac('sha256', secret).update(request.headers['X-Data-Loom-Timestamp']+'.'+request.body).digest('hex');
  assert.equal(request.headers['X-Data-Loom-Signature'], 'sha256='+expected);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await db.one('SELECT delivered FROM settlement_deliveries WHERE signature=?', ['tx1'])).delivered, 1);
  assert.equal(fetchMock.mock.callCount(), 1);
});
