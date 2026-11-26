import fs from 'node:fs';import path from 'node:path';import {randomBytes,createCipheriv,createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import os from 'node:os';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'deploy/generated');fs.mkdirSync(out,{recursive:true,mode:0o700});
const artifactURL=process.argv[2];if(!artifactURL?.startsWith('https://'))throw Error('Usage: node deploy/pack-release.mjs https://immutable-host/releases/loom.bin');
if(!fs.existsSync(path.join(root,'dist/index.html')))throw Error('Build frontend first');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'loom-release-')),tgz=path.join(temp,'release.tgz');
try{
 execFileSync('tar',['czf',tgz,'--exclude=.DS_Store','--exclude=node_modules','--exclude=dist/releases','server.mjs','package.json','package-lock.json','backend','dist','deploy/run-cvm.mjs','deploy/pap/package.json','deploy/pap/package-lock.json'],{cwd:root,env:{...process.env,COPYFILE_DISABLE:'1'}});
 const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from('DataLoom-CVM-release-v1'));const encrypted=Buffer.concat([c.update(fs.readFileSync(tgz)),c.final()]);const blob=Buffer.concat([iv,c.getAuthTag(),encrypted]);const digest=createHash('sha256').update(blob).digest('hex');
 fs.writeFileSync(path.join(out,'loom.bin'),blob);fs.writeFileSync(path.join(out,'release.env'),'LOOM_RELEASE_KEY='+key.toString('base64')+'\n',{mode:0o600});
 const keys=['APP_ORIGIN','CONFIDENTIAL_APPROVED_COMPOSE','S3_BUCKET','S3_REGION','S3_ENDPOINT','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','SOLANA_RPC_URL','PLATFORM_WALLET','AI_BASE_URL','AI_MODEL','AI_API_KEY','ENABLE_CONVENTIONAL_QUERY_PROCESSING','PHALA_AI_API_KEY','PHALA_MODEL','PRIVATE_ROUTER_THIRD_MODEL','PHALA_ACCEPT_COMPOSE','ENABLE_LISTINGS','ENABLE_PAYMENTS','ENABLE_QUERY_PAYMENTS','CONFIDENTIAL_RUNTIME'];
 const environment={NODE_ENV:'production',PORT:'9200',DATA_DIR:'/data',LOOM_RELEASE_URL:artifactURL,LOOM_RELEASE_SHA256:digest,LOOM_RELEASE_KEY:'${LOOM_RELEASE_KEY}'};for(const key of keys)environment[key]='${'+key+'}';
 for(const name of ['DATA_ESCROW_PROGRAM','DATA_ESCROW_PROGRAM_HASH','DATA_ESCROW_PROGRAM_SIZE','DATA_ESCROW_VERIFIER'])environment[name]='${'+name+':-}';
 environment.CAPSULE_VERIFIER_URL = '\${CAPSULE_VERIFIER_URL:-}';
 environment.ENABLE_NITO_CONFIDENTIAL_CHAT = '${ENABLE_NITO_CONFIDENTIAL_CHAT:-false}';
 environment.NITO_API_KEY = '${NITO_API_KEY:-}';
 environment.NITO_MODEL = '${NITO_MODEL:-deepseek/deepseek-v4.1-flash:encrypted}';
 environment.SETTLEMENT_WEBHOOK_URL = '\${SETTLEMENT_WEBHOOK_URL:-}';
 environment.SETTLEMENT_WEBHOOK_SECRET = '\${SETTLEMENT_WEBHOOK_SECRET:-}';
 environment.DATA_DELIVERY_DESTINATIONS = '${DATA_DELIVERY_DESTINATIONS:-}';
 const compose={volumes:{'loom-state':{}},services:{'data-loom':{image:'node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c',platform:'linux/amd64',volumes:['/var/run/dstack.sock:/var/run/dstack.sock','loom-state:/data'],restart:'unless-stopped',ports:['9200:9200'],environment,command:['node','-e',fs.readFileSync(path.join(root,'deploy/bootstrap.cjs'),'utf8')],logging:{driver:'json-file',options:{'max-size':'10m','max-file':'2'}}}}};
 fs.writeFileSync(path.join(out,'docker-compose.json'),JSON.stringify(compose,null,2));console.log(JSON.stringify({artifact:path.join(out,'loom.bin'),sha256:digest,compose:path.join(out,'docker-compose.json'),secretFile:path.join(out,'release.env')}));
}finally{fs.rmSync(temp,{recursive:true,force:true})}
