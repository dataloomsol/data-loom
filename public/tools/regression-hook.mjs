import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const digest = value => createHash('sha256').update(value).digest('hex');

try {
  const [configPath, output = 'dataloom-scorecard.json'] = process.argv.slice(2);
  const session = process.env.DATALOOM_SESSION;
  const publicKey = process.env.DATALOOM_GATE_PUBLIC_KEY;
  if (!configPath || !session || !publicKey) throw Error('Provide a config file, DATALOOM_SESSION, and DATALOOM_GATE_PUBLIC_KEY');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const { dataset, benchmark, models, revision, minimumAccuracy } = config;
  const candidatePrompt = config.promptFile ? await readFile(config.promptFile, 'utf8') : undefined;
  const origin = new URL(process.env.DATALOOM_ORIGIN || 'https://dataloom.live');
  if (origin.protocol !== 'https:') throw Error('Data Loom origin must use HTTPS');
  async function request(path, body) {
    const response = await fetch(new URL(path, origin), {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { Cookie: 'loom_session='+session, ...(body ? {'Content-Type':'application/json'} : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Data Loom returned HTTP '+response.status);
    return result;
  }

  const { id } = config.trialId ? { id: config.trialId } : await request('/api/trial-orders', {
    dataset, models, candidatePrompt, consent: true, releaseGate: { revision, minimumAccuracy },
  });
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Invalid trial ID');
  console.log('Data Loom trial '+id+'. Approve its checkout in Data Loom when ready.');
  const deadline = Date.now()+30*60*1000;
  let result;
  while (Date.now()<deadline) {
    const job = await request('/api/trial-jobs/'+id);
    if (job.state === 'failed') throw Error('Private benchmark failed before settlement');
    if (job.state === 'ready') {
      result = await request('/api/trial-orders/'+id);
      if (result.releaseGate) break;
    }
    await setTimeout(10000);
  }
  if (!result?.releaseGate) throw Error('Timed out waiting for a paid, verified trial '+id);
  const { payload, signature } = result.releaseGate;
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format:'der', type:'spki' });
  if (!verify(null, Buffer.from(payload), key, Buffer.from(signature,'base64'))) throw Error('Invalid gate signature');
  const gate = JSON.parse(payload);
  if (!benchmark || gate.type !== 'dataloom-release-gate-v1' || gate.trial !== id ||
      gate.policy.revision !== revision || gate.policy.minimumAccuracy !== minimumAccuracy ||
      gate.benchmark !== benchmark || gate.baseline !== models[0] || gate.candidate !== models[1] ||
      gate.promptHash !== (candidatePrompt ? digest(candidatePrompt) : null) ||
      gate.scorecardHash !== digest(JSON.stringify(result.scorecard)) ||
      !Number.isSafeInteger(gate.expiresAt) || Date.now() >= gate.expiresAt) {
    throw Error('Gate receipt does not match this release or has expired');
  }
  await writeFile(output, JSON.stringify({ scorecard:result.scorecard, receipt:result.releaseGate }, null, 2), { mode:0o600 });
  if (gate.verdict !== 'pass') throw Error('Candidate failed the minimum accuracy gate');
  console.log('Data Loom regression gate passed');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
