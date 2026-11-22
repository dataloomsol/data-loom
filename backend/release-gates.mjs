import { createPrivateKey, createPublicKey, hkdfSync, sign, createHash } from 'node:crypto';
import { z } from 'zod';

export const releaseGateSchema = z.object({
  revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  minimumAccuracy: z.number().int().min(1).max(100),
  category: z.string().trim().min(1).max(40).optional(),
  maxDrop: z.number().int().min(0).max(100).optional(),
}).strict().refine(gate => (gate.category === undefined) === (gate.maxDrop === undefined));

export async function installReleaseGates(app, { db, env }) {
  await db.query('CREATE TABLE IF NOT EXISTS trial_release_gates (trial TEXT PRIMARY KEY, policy TEXT NOT NULL)');
  const masterKey = Buffer.from(env.STORAGE_MASTER_KEY || '', 'base64');
  const available = env.CONFIDENTIAL_READY === 'true' &&
    env.CONFIDENTIAL_RUNTIME === 'phala' && masterKey.length === 32;
  let signingKey, publicKey;
  if (available) {
    const seed = hkdfSync('sha256', masterKey, '', 'Data Loom release gate signing v1', 32);
    signingKey = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]),
      format: 'der',
      type: 'pkcs8',
    });
    publicKey = createPublicKey(signingKey).export({ format: 'der', type: 'spki' }).toString('base64');
  }

  app.get('/api/release-gates', (req, res) => res.json({ available, publicKey }));

  return {
    available,
    async save(trial, policy, candidatePrompt) {
      await db.query('INSERT INTO trial_release_gates (trial, policy) VALUES (?, ?)', [trial, JSON.stringify({policy,promptHash:candidatePrompt?createHash("sha256").update(candidatePrompt).digest("hex"):null})]);
    },
    async receipt(order, scorecard) {
      if (!available || order.state !== 'paid' || !order.signature) return undefined;
      const row = await db.one('SELECT policy FROM trial_release_gates WHERE trial=?', [order.id]);
      if (!row) return undefined;

      const saved = JSON.parse(row.policy);
      const policy = releaseGateSchema.parse(saved.policy ?? saved);
      const [baseline, candidate] = scorecard.models;
      const checks = [{
        rule: 'minimum-accuracy',
        passed: candidate.correct * 100 >= policy.minimumAccuracy * candidate.total,
      }];
      if (policy.category) {
        const before = baseline.categories[policy.category];
        const after = candidate.categories[policy.category];
        checks.push({
          rule: 'maximum-category-drop',
          passed: !!before && !!after &&
            (before.correct * after.total - after.correct * before.total) * 100 <=
              policy.maxDrop * before.total * after.total,
        });
      }
      const evaluatedAt = Date.parse(scorecard.created);
      if (!Number.isFinite(evaluatedAt)) throw Error('Invalid release gate evaluation time');
      const payload = JSON.stringify({
        type: 'dataloom-release-gate-v1',
        trial: order.id,
        policy,
        benchmark: order.commitment,
        promptHash: saved.promptHash ?? null,
        candidateScore: { correct: candidate.correct, total: candidate.total },
        scoring: scorecard.scoring,
        scorecardHash: createHash("sha256").update(JSON.stringify(scorecard)).digest("hex"),
        baseline: baseline.model,
        candidate: candidate.model,
        evaluatedAt,
        expiresAt: evaluatedAt + 7 * 86400000,
        verdict: checks.every(check => check.passed) ? 'pass' : 'fail',
        checks,
      });
      return { payload, signature: sign(null, Buffer.from(payload), signingKey).toString('base64') };
    },
  };
}
