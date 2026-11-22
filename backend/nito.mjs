import {createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes} from 'node:crypto';

const x25519Prefix = Buffer.from('302a300506032b656e032100', 'hex');

export function installNito(app, {env, authenticated}) {
 const model = env.NITO_MODEL;
 const enabled = Boolean(env.NITO_API_KEY && /^[\w./-]+:encrypted$/.test(model || ''));
 const chatModel = 'deepseek/deepseek-v4.1-flash:confidential';
 const chatEnabled = Boolean(env.NITO_API_KEY && env.ENABLE_NITO_CONFIDENTIAL_CHAT === 'true');
 let nextChatAt = 0;
 app.post('/api/nito/chat', authenticated, async (req, res) => {
  if (!chatEnabled) return res.status(503).json({error:'Nito confidential chat is disabled'});
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt || prompt.length > 2000 || req.body.consent !== true) {
   return res.status(400).json({error:'Provide a prompt of up to 2,000 characters and consent to Nito processing'});
  }
  if (Date.now() < nextChatAt) return res.status(429).json({error:'Try again in a few seconds'});
  nextChatAt = Date.now() + 5000;
  try {
   const response = await fetch('https://app.trynito.ai/api/v1/chat/completions', {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(30000),
    headers:{'Content-Type':'application/json','X-API-Key':env.NITO_API_KEY},
    body:JSON.stringify({model:chatModel,messages:[{role:'user',content:prompt}],max_tokens:256,stream:false})
   });
   if (!response.ok) return res.status(502).json({error:'Nito chat request failed (HTTP '+response.status+')'});
   const completion = await response.json();
   const answer = completion.choices?.[0]?.message?.content;
   if (completion.model !== chatModel || typeof answer !== 'string' || !answer.trim()) throw Error();
   res.set('Cache-Control','no-store').json({model:chatModel,answer});
  } catch {
   res.status(502).json({error:'Nito did not return a usable chat reply'});
  }
 });
 app.get('/api/nito/status', (req, res) => res.json({evidenceAvailable: enabled, chatAvailable: chatEnabled, chatModel: chatEnabled ? chatModel : null, model: enabled ? model : null}));
 app.post('/api/nito/attestation', authenticated, async (req, res) => {
  if (!enabled) return res.status(503).json({error:'Nito evidence service is not configured'});
  const nonce = randomBytes(32).toString('hex');
  const {publicKey, privateKey} = generateKeyPairSync('x25519');
  const url = new URL('https://app.trynito.ai/api/v1/attestation');
  url.search = new URLSearchParams({model, nonce, trust_tier:'encrypted'});
  try {
   const response = await fetch(url, {redirect:'error', signal:AbortSignal.timeout(15000), headers:{
    Authorization: 'Bearer '+env.NITO_API_KEY,
    'nito-attestation-model-binding-key': publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex'),
    'nito-attestation-model-binding-version':'2'
   }});
   if (!response.ok) throw Error();
   const data = await response.json();
   const binding = data.model_binding;
   if (data.model !== model || data.nonce !== nonce || data.privacy_tier !== 'encrypted' ||
       data.attestation_available !== true || !Object.keys(data.evidence || {}).length ||
       binding?.version !== 'x25519-aesgcm-v2' || !/^[a-f0-9]{64}$/i.test(binding.ephemeral_public_key) ||
       !/^[a-f0-9]{24}$/i.test(binding.nonce) || !/^(?:[a-f0-9]{2}){17,4096}$/i.test(binding.ciphertext)) throw Error();
   const peer = createPublicKey({key:Buffer.concat([x25519Prefix,Buffer.from(binding.ephemeral_public_key,'hex')]),format:'der',type:'spki'});
   const shared = diffieHellman({privateKey,publicKey:peer});
   const key = createHash('sha256').update('nito-attestation-model-binding-v1\0').update(shared).digest();
   const ciphertext = Buffer.from(binding.ciphertext,'hex');
   const decipher = createDecipheriv('aes-256-gcm',key,Buffer.from(binding.nonce,'hex'));
   decipher.setAAD(Buffer.from(model+'\0'+nonce));
   decipher.setAuthTag(ciphertext.subarray(-16));
   const metadata = JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]));
   if (!metadata.provider_model_id || !metadata.proof_format) throw Error();
   res.json({model,nonce,transport:data.encryption_protocol,metadata,evidence:data.evidence,modelPublicKey:data.model_public_key,signingKey:data.signing_key,signingAddress:data.signing_address,signingAlgorithm:data.signing_algo,hardwareVerified:false});
  } catch {
   res.status(502).json({error:'Nito did not return usable attestation evidence'});
  }
 });
}
