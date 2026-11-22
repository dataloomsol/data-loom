import {randomUUID} from 'node:crypto';
import {z} from 'zod';

const uuid=z.string().uuid();
const requiredChecks=['receipt-1','receipt-2','receipt-3','receipt-4','upstream-1','upstream-2'];
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function verification(evidence){
 const checks=evidence?.checks;
 return evidence?.provider==='phala' && typeof evidence.receiptId==='string' && evidence.receiptId.length>0 &&
  Array.isArray(checks)&&checks.every(c=>c.status!=='fail')&&requiredChecks.every(id=>checks.filter(c=>c.id===id).length===1&&checks.find(c=>c.id===id).status==='pass');
}
function page(card){
 const item=(name,value)=>`<dt>${name}</dt><dd>${escape(value)}</dd>`;
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,noarchive"><meta property="og:title" content="Data Loom · Proof Card"><meta property="og:description" content="Source commitment, authorized use and recorded inference verification for a paid answer."><meta name="twitter:card" content="summary"><title>Proof Card · Data Loom</title><style>*{box-sizing:border-box}body{margin:0;background:#f7f7ef;color:#171a16;font:17px/1.5 system-ui}main{max-width:760px;margin:auto;padding:clamp(20px,5vw,60px)}header,dt,small{font:14px/1.6 monospace}header{border-bottom:2px solid;padding-bottom:12px}h1{font-size:clamp(36px,7vw,64px);margin:.45em 0}article{border:1px solid;padding:24px;background:white}dt{margin-top:15px}dd{margin:4px 0;overflow-wrap:anywhere}p{white-space:pre-wrap;overflow-wrap:anywhere}a{color:inherit}</style><main><header>DATA LOOM / ANSWER MARKET</header><h1>Proof Card</h1><article><small>01 / SOURCE VERSION</small><dl>${item('Dataset',card.source.title||card.source.dataset)}${item('Dataset ID',card.source.dataset)}${item('Version commitment',card.source.commitment)}</dl><small>02 / AUTHORIZED USE</small><p>${escape(card.terms)}</p>${card.consentedAt?`<p>Contributor permission recorded ${escape(card.consentedAt)}</p>`:''}<small>03 / INFERENCE RECEIPT</small><p>${card.verified?'Data Loom verified the inference receipt when this answer was generated.':'No verified inference receipt is recorded for this answer.'}</p>${card.verified?`<dl>${item('Receipt ID',card.receiptId)}${item('Verified at',card.verifiedAt)}</dl>`:''}<small>04 / BUYER DISCLOSURE</small><p>${card.answer===undefined?'The buyer has kept the answer private.':escape(card.answer)}</p></article><p><a href="/">Explore Data Loom ↗</a></p></main></html>`;
}
export async function installProofCards(app,{db,storage,authenticated}){
 await db.query('CREATE TABLE IF NOT EXISTS proof_cards (order_id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, include_answer INTEGER NOT NULL)');
 const manage='/api/query-orders/:id/proof-card';
 const owned=async(req,res,next)=>{
  const order=await db.one("SELECT id FROM query_orders WHERE id=? AND buyer=? AND state='answered' AND signature IS NOT NULL",[uuid.parse(req.params.id),req.wallet]);
  if(!order)return res.status(404).json({error:'Paid answer not found'});next();
 };
 const settings=row=>row?{path:'/proof/'+row.token,includeAnswer:!!row.include_answer}:{path:null,includeAnswer:false};
 app.get(manage,authenticated,owned,async(req,res)=>res.json(settings(await db.one('SELECT * FROM proof_cards WHERE order_id=?',[req.params.id]))));
 app.post(manage,authenticated,owned,async(req,res)=>{
  const {includeAnswer}=z.object({includeAnswer:z.boolean()}).parse(req.body);
  const result=await db.query('INSERT INTO proof_cards(order_id,token,include_answer) VALUES(?,?,?) ON CONFLICT(order_id) DO UPDATE SET include_answer=excluded.include_answer RETURNING *',[req.params.id,randomUUID(),Number(includeAnswer)]);
  res.json(settings(result.rows[0]));
 });
 app.delete(manage,authenticated,owned,async(req,res)=>{await db.query('DELETE FROM proof_cards WHERE order_id=?',[req.params.id]);res.json(settings(null));});
 app.get('/proof/:token',async(req,res)=>{
  res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, noarchive','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});
  if(!uuid.safeParse(req.params.token).success)return res.sendStatus(404);
  const row=await db.one("SELECT c.include_answer,o.dataset,o.commitment,o.answer_object,r.terms FROM proof_cards c JOIN query_orders o ON o.id=c.order_id JOIN query_receipts r ON r.order_id=o.id WHERE c.token=? AND o.state='answered' AND o.signature IS NOT NULL",[req.params.token]);
  if(!row)return res.sendStatus(404);
  const object=await storage.get(row.answer_object),verified=verification(object.evidence);
  res.type('html').send(page({source:{dataset:row.dataset,commitment:row.commitment,title:object.sourceSnapshot?.title},terms:row.terms,consentedAt:object.sourceSnapshot?.consentedAt,verified,receiptId:verified?object.evidence.receiptId:null,verifiedAt:verified?object.evidence.verifiedAt:null,...(row.include_answer?{answer:object.answer}:{})}));
 });
}
