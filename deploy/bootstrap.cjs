const fs=require('node:fs');const crypto=require('node:crypto');const {spawnSync,spawn}=require('node:child_process');
(async()=>{
 const url=process.env.LOOM_RELEASE_URL,expected=process.env.LOOM_RELEASE_SHA256,key=Buffer.from(process.env.LOOM_RELEASE_KEY||'','base64');
 if(!url?.startsWith('https://')||!/^[a-f0-9]{64}$/.test(expected||'')||key.length!==32)throw Error('Missing release configuration');
 const r=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Release fetch failed');const blob=Buffer.from(await r.arrayBuffer());
 if(crypto.createHash('sha256').update(blob).digest('hex')!==expected)throw Error('Release digest mismatch');
 const decipher=crypto.createDecipheriv('aes-256-gcm',key,blob.subarray(0,12));decipher.setAuthTag(blob.subarray(12,28));decipher.setAAD(Buffer.from('DataLoom-CVM-release-v1'));
 const archive=Buffer.concat([decipher.update(blob.subarray(28)),decipher.final()]);key.fill(0);delete process.env.LOOM_RELEASE_KEY;
 const dir='/tmp/data-loom-runtime';fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=dir+'/release.tgz';fs.writeFileSync(file,archive,{mode:0o600});archive.fill(0);
 for(const [command,args,cwd] of [['tar',['xzf',file,'--no-same-owner'],dir],['npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],dir],['npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],dir+'/deploy/pap']]){
  const result=spawnSync(command,args,{cwd,stdio:['ignore','inherit','inherit'],env:process.env});if(result.status!==0)throw Error('Release installation failed');
 }
 fs.unlinkSync(file);const child=spawn(process.execPath,['deploy/run-cvm.mjs'],{cwd:dir,stdio:'inherit',env:process.env});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??1));
})().catch(()=>{console.error('Confidential runtime bootstrap failed');process.exit(1)});
