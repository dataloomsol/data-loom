import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import fs from 'node:fs/promises';import path from 'node:path';
import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
export function seal(bytes,key,aad){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));const data=Buffer.concat([cipher.update(bytes),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data])}
export function unseal(bytes,key,aad){if(bytes.length<28)throw Error('Invalid ciphertext');const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()])}
export async function openStorage(env=process.env){const root=path.resolve(env.DATA_DIR||'.data');if(!env.S3_BUCKET)await fs.mkdir(root,{recursive:true,mode:0o700});let key;
 if(env.STORAGE_MASTER_KEY){key=Buffer.from(env.STORAGE_MASTER_KEY,'base64');if(key.length!==32)throw Error('STORAGE_MASTER_KEY must decode to 32 bytes')}
 else{if(env.NODE_ENV==='production')throw Error('STORAGE_MASTER_KEY is required');const file=path.join(root,'storage.key');try{key=await fs.readFile(file)}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32);await fs.writeFile(file,key,{mode:0o600,flag:'wx'})}}
 if(env.NODE_ENV==='production'&&!env.S3_BUCKET)throw Error('Private S3 storage is required in production');
 const s3=env.S3_BUCKET?new S3Client({region:env.S3_REGION||'auto',endpoint:env.S3_ENDPOINT||undefined,forcePathStyle:!!env.S3_ENDPOINT}):null;
 const valid=id=>{if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid object ID');return 'datasets/'+id+'.bin'};
 return {kind:s3?'s3':'local-encrypted',async put(id,value){const object=valid(id),bytes=seal(Buffer.from(JSON.stringify(value)),key,id);if(s3)await s3.send(new PutObjectCommand({Bucket:env.S3_BUCKET,Key:object,Body:bytes,ContentType:'application/octet-stream'}));else await fs.writeFile(path.join(root,id+'.bin'),bytes,{mode:0o600});return object},async get(id){valid(id);const bytes=s3?Buffer.from(await(await s3.send(new GetObjectCommand({Bucket:env.S3_BUCKET,Key:valid(id)}))).Body.transformToByteArray()):await fs.readFile(path.join(root,id+'.bin'));return JSON.parse(unseal(bytes,key,id).toString())},async remove(id){valid(id);if(s3)await s3.send(new DeleteObjectCommand({Bucket:env.S3_BUCKET,Key:valid(id)}));else await fs.rm(path.join(root,id+'.bin'),{force:true})}};
}
