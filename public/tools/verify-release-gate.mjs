import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

try {
  const [receiptFile, expectedTrial, expectedRevision] = process.argv.slice(2);
  const pinnedKey = process.env.DATALOOM_GATE_PUBLIC_KEY;
  if (!receiptFile || !expectedTrial || !expectedRevision || !pinnedKey) {
    throw Error('Usage: set DATALOOM_GATE_PUBLIC_KEY, then run node verify-release-gate.mjs receipt.json EXPECTED_TRIAL_ID EXPECTED_COMMIT_SHA');
  }
  const { payload, signature } = JSON.parse(await readFile(receiptFile, 'utf8'));
  const key = createPublicKey({ key: Buffer.from(pinnedKey, 'base64'), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64'))) {
    throw Error('Invalid Data Loom signature');
  }
  const result = JSON.parse(payload);
  if (result.type !== 'dataloom-release-gate-v1' || result.trial !== expectedTrial ||
      result.policy.revision !== expectedRevision) {
    throw Error('Receipt does not match the expected trial and revision');
  }
  if (!Number.isSafeInteger(result.expiresAt) || Date.now() >= result.expiresAt) {
    throw Error('Release gate receipt has expired');
  }
  if (result.verdict !== 'pass') throw Error('Release gate failed');
  console.log('Data Loom release gate passed');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
