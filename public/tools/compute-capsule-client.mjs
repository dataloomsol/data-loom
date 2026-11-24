import {createDecipheriv,createHash,createPublicKey,diffieHellman,generateKeyPairSync,hkdfSync} from 'node:crypto';

const protocol = 'dataloom-compute-capsule-v1';
const sha256 = value => createHash('sha256').update(value).digest();
const rawKey = /^[a-f0-9]{64}$/;

export async function prepareCapsuleRecipient(challenge, attestationClient) {
  const {privateKey,publicKey} = generateKeyPairSync('x25519');
  const receiverKey = publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
  const binding = JSON.stringify([protocol,challenge.id,challenge.nonce,challenge.grant,
    challenge.buyer,challenge.commitment,challenge.appId,challenge.composeHash,challenge.osImageHash,receiverKey]);
  const digest = sha256(binding);
  const quote = await attestationClient.getQuote(digest);
  if (!quote?.quote) throw Error('Workload quote unavailable.');
  let opened = false;
  return {
    submission:{challenge:challenge.id,publicKey:receiverKey,quote},
    open(capsule) {
      if (opened || capsule.protocol !== protocol || capsule.binding !== binding || !rawKey.test(capsule.senderKey)) {
        throw Error('Capsule does not match this recipient.');
      }
      const sender = createPublicKey({key:Buffer.from('302a300506032b656e032100'+capsule.senderKey,'hex'),type:'spki',format:'der'});
      const shared = diffieHellman({privateKey,publicKey:sender});
      const key = new Uint8Array(hkdfSync('sha256',shared,digest,protocol,32));
      try {
        const blob = Buffer.from(capsule.ciphertext,'base64');
        if (blob.length < 28 || blob.length > 2100000) throw Error('Invalid capsule size.');
        const decipher = createDecipheriv('aes-256-gcm',key,blob.subarray(0,12));
        decipher.setAAD(Buffer.from(binding));
        decipher.setAuthTag(blob.subarray(12,28));
        const data = JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)),decipher.final()]));
        if (typeof data.content !== 'string' || typeof data.salt !== 'string' ||
            sha256(data.salt+'\n'+data.content).toString('hex') !== challenge.commitment) {
          throw Error('Capsule does not match the approved dataset commitment.');
        }
        opened = true;
        return data.content;
      } finally { key.fill(0);shared.fill(0); }
    }
  };
}
