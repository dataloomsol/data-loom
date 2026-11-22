import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { installAgentTools } from '../backend/agent-tools.mjs';
import { evaluateBenchmark, installBlindTrials, TRIAL_MODELS } from '../backend/blind-trials.mjs';
import { openDb } from '../backend/db.mjs';
import { openStorage } from '../backend/storage.mjs';

const cases = Array.from({ length: 5 }, (_, i) => ({
  prompt: 'PRIVATE CASE ' + i,
  expectedAnswer: 'eligible',
  category: 'Warranty',
  toolInput: { age: i },
}));
const evidence = {
  provider: 'phala', receiptId: 'synthetic-receipt', verifiedAt: new Date().toISOString(),
  checks: ['receipt-1', 'receipt-2', 'receipt-3', 'receipt-4', 'upstream-1', 'upstream-2'].map(id => ({ id, status: 'pass' })),
};

test('impact scorecards require tool receipts as well as model receipts', async () => {
  await assert.rejects(evaluateBenchmark({
    cases, models: [TRIAL_MODELS[0], TRIAL_MODELS[0]],
    infer: async () => ({ answer: 'eligible', evidence }),
    impact: { invoke: async () => ({ output: { decision: 'eligible' } }) },
  }), /receipt missing/);
});

test('impact trial applies authorized private tool to identical cases and unlocks aggregate results after exact payment', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-impact-'));
  const env = {
    DATA_DIR: dir, STORAGE_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
    BLIND_TRIALS_MODELS_READY: 'true', CONFIDENTIAL_READY: 'true', CONFIDENTIAL_RUNTIME: 'phala',
    ENABLE_QUERY_PAYMENTS: 'true', PHALA_AI_API_KEY: 'test', PHALA_MODEL: 'test', SOLANA_RPC_URL: 'test',
    PLATFORM_WALLET: 'GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5',
  };
  const db = await openDb(env);
  const storage = await openStorage(env);
  const app = express();
  app.use(express.json());
  const authenticated = (q, s, next) => { q.wallet = q.headers['x-wallet']; next(); };
  await db.query('CREATE TABLE IF NOT EXISTS query_policies(dataset TEXT PRIMARY KEY,enabled INTEGER)');
  const model = TRIAL_MODELS[0];
  const benchmark = randomUUID(), toolDataset = randomUUID(), toolId = randomUUID();
  const modelCalls = [], toolCalls = [];
  await installBlindTrials(app, {
    db, storage, env, authenticated,
    infer: async ({ prompt, model: actualModel, toolDecision }) => {
      assert.equal(actualModel, model);
      assert.match(prompt, /^PRIVATE CASE \d$/);
      modelCalls.push([prompt, toolDecision]);
      return { answer: toolDecision || 'unknown', evidence };
    },
    runTool: async ({ input, source }) => {
      assert.equal(source, 'PRIVATE TOOL SOURCE');
      toolCalls.push(input);
      return { output: { decision: 'eligible', reason: 'PRIVATE TOOL REASON' }, evidence };
    },
    build: async ({ price, seller }) => {
      assert.equal(price, 150000);
      assert.equal(seller, 'owner');
      return { transaction: 'wire', message: 'impact-message', summary: { price: String(price), sellerAmount: '105000' } };
    },
    verify: async (signature, message) => {
      assert.equal(signature, '1'.repeat(88));
      assert.equal(message, 'impact-message');
    },
  });
  await installAgentTools(app, { db, storage, env, authenticated, rpc: async () => {} });
  app.use((error, req, res, next) => res.status(400).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.once('listening', resolve));
  const request = async (route, body, wallet = 'buyer') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-wallet': wallet },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  for (const [id, content] of [[benchmark, JSON.stringify(cases)], [toolDataset, 'PRIVATE TOOL SOURCE']]) {
    await db.query('INSERT INTO datasets(id,owner,title,category,description,preview,object_key,commitment,fingerprint,price,license,state,created,analysis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, 'owner', 'Title', 'General', 'Description', 'Preview', id, id, id, 100000, 'research-v1', 'draft', Date.now(), '{}']);
    await storage.put(id, { content });
  }
  await db.query('INSERT INTO agent_tools(id,dataset,owner,commitment,name,purpose,fields,decisions,price,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [toolId, toolDataset, 'owner', toolDataset, 'warranty', 'Determine warranty eligibility', '[{"name":"age","type":"number"}]', '["eligible","unknown"]', 10000, Date.now()]);

  const policy = '/api/datasets/' + benchmark + '/trial-policy';
  const input = { dataset: benchmark, models: [model, model], impact: true, consent: true };
  assert.equal((await request(policy, { enabled: true, price: 100000, consent: true }, 'owner')).status, 200);
  assert.equal((await request('/api/trial-orders', input)).status, 404);
  assert.equal((await request(policy, { enabled: true, price: 100000, consent: true, impactTool: toolId }, 'owner')).status, 200);
  const job = await request('/api/trial-orders', input);
  assert.equal(job.status, 202, JSON.stringify(job.data));
  const id = job.data.id;
  let prepared;
  for (let n = 0; n < 100; n++) {
    prepared = await request('/api/trial-jobs/' + id);
    if (prepared.data.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(prepared.data.state, 'ready', JSON.stringify(prepared.data));
  assert.equal(prepared.data.summary.impactToolCost, '50000');
  assert.equal(prepared.data.scorecard, undefined);
  assert.deepEqual(toolCalls, cases.map(item => item.toolInput));
  assert.deepEqual(modelCalls, [...cases.map(item => [item.prompt, undefined]), ...cases.map(item => [item.prompt, 'eligible'])]);
  const paid = await request('/api/trial-orders/' + id + '/confirm', { signature: '1'.repeat(88) });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.scorecard.impact.accuracyDelta, 1);
  assert.equal(paid.data.scorecard.impact.categoryDeltas.Warranty, 1);
  assert.equal(paid.data.scorecard.models[1].toolReceipts.length, 5);
  assert.doesNotMatch(JSON.stringify(paid.data), /PRIVATE CASE|PRIVATE TOOL|eligible/);
  assert.equal((await request('/api/regression-watches', { baseline: id, cadence: 'daily', threshold: 10, maxPrice: 150000, consent: true })).status, 404);
});
