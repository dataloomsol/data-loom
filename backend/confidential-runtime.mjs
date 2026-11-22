export async function configureConfidentialRuntime(env){
 if(env.CONFIDENTIAL_RUNTIME!=='phala')return {env,ready:false};
 if(env.VERCEL)throw Error('Protected runtime cannot execute in Vercel');
 const {DstackClient}=await import('@phala/dstack-sdk');
 const client=new DstackClient('/var/run/dstack.sock');
 const info=await client.info();
 if(!info.app_id||!info.compose_hash)throw Error('Protected runtime identity unavailable');
 const approved=env.CONFIDENTIAL_APPROVED_COMPOSE;
 const ready=!!approved&&approved===info.compose_hash;
 // New protected deployments derive their own key. Never silently import an old
 // Vercel-accessible key and describe it as exclusive to protected hardware.
 const derived=await client.getKey('data-loom/storage/v1','dataset-encryption','secp256k1');
 if(derived.key.length!==32)throw Error('Protected storage key has invalid length');
 return{env:{...env,STORAGE_MASTER_KEY:Buffer.from(derived.key).toString('base64'),CONFIDENTIAL_READY:ready?'true':'false'},ready,client,info};
}
