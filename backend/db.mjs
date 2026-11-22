import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
export async function openDb(env=process.env){
 let sqlite,pool;
 if(env.DATABASE_URL)pool=new pg.Pool({connectionString:env.DATABASE_URL,max:5});
 else {if(env.NODE_ENV==='production'&&env.CONFIDENTIAL_RUNTIME!=='phala')throw Error('DATABASE_URL is required in production');fs.mkdirSync(env.DATA_DIR||'.data',{recursive:true,mode:0o700});sqlite=new DatabaseSync(path.join(env.DATA_DIR||'.data','loom.sqlite'));sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');}
 const query=async(sql,args=[])=>{const statement=sqlite.prepare(sql);if(/^\s*(SELECT|WITH)|RETURNING/i.test(sql))return{rows:statement.all(...args)};return{rows:[],rowCount:statement.run(...args).changes}};
 // Parameter numbering is local to each synchronous statement construction.
 const rawRun=async(sql,args=[])=>{if(pool){let i=0;return pool.query(sql.replace(/\?/g,()=>`$${++i}`),args)}return query(sql,args)};
 let queue=Promise.resolve();
 const exclusive=fn=>{
  const result=queue.then(fn);
  queue=result.catch(()=>{});
  return result;
 };
 const run=(sql,args=[])=>pool?rawRun(sql,args):exclusive(()=>rawRun(sql,args));
 const transaction=fn=>exclusive(async()=>{
  const client=pool?await pool.connect():null;
  const execute=async(sql,args=[])=>{
   if(!client)return rawRun(sql,args);
   let i=0;
   return client.query(sql.replace(/\?/g,()=>'$'+(++i)),args);
  };
  try{
   await execute(pool?'BEGIN':'BEGIN IMMEDIATE');
   const result=await fn({query:execute,one:async(sql,args=[])=>(await execute(sql,args)).rows[0]||null});
   await execute('COMMIT');
   return result;
  }catch(error){
   await execute('ROLLBACK').catch(()=>{});
   throw error;
  }finally{client?.release();}
 });
 const schema=[
 'CREATE TABLE IF NOT EXISTS consent_state (dataset TEXT PRIMARY KEY, paused INTEGER NOT NULL, changed BIGINT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL, expires BIGINT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, wallet TEXT NOT NULL, expires BIGINT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, preview TEXT NOT NULL, object_key TEXT NOT NULL, commitment TEXT NOT NULL, fingerprint TEXT NOT NULL, price BIGINT NOT NULL, license TEXT NOT NULL, state TEXT NOT NULL, created BIGINT NOT NULL, analysis TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, buyer TEXT NOT NULL, dataset TEXT NOT NULL, seller TEXT NOT NULL, platform TEXT NOT NULL, price BIGINT NOT NULL, seller_amount BIGINT NOT NULL, platform_amount BIGINT NOT NULL, message TEXT NOT NULL, tx TEXT NOT NULL, signature TEXT UNIQUE, created BIGINT NOT NULL, expires BIGINT NOT NULL, state TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS licenses (id TEXT PRIMARY KEY, buyer TEXT NOT NULL, dataset TEXT NOT NULL, order_id TEXT UNIQUE NOT NULL, terms TEXT NOT NULL, created BIGINT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL, created BIGINT NOT NULL)'
 ];for(const sql of schema)await run(sql);
 return {query:run,transaction,one:async(sql,args=[])=>(await run(sql,args)).rows[0]||null,close:async()=>pool?pool.end():sqlite.close()};
}
