import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash} from './security.mjs';
import {seal,unseal} from './storage.mjs';
import {unpaused} from './consent-ledger.mjs';

const base = '/api/sealed-auctions';
const uuid = z.string().uuid();
const price = z.number().int().min(10000).max(1000000000);
const maxBids = 1000;

export function rankBids(bids,minimum,slots) {
  return bids.filter(bid => bid.amount>=minimum).sort((a,b) =>
    b.amount-a.amount || a.sequence-b.sequence).slice(0,slots);
}

export async function installSealedAuctions(app,{db,authenticated,env,protectedRuntime,attestationClient,payments}) {
  const master = Buffer.from(env.STORAGE_MASTER_KEY ?? '','base64');
  const enabled = Boolean(protectedRuntime && attestationClient && env.CONFIDENTIAL_READY==='true' && master.length===32);
  app.get(base+'/status',(_req,res) => res.json({enabled,checkout:enabled && payments}));
  const unavailable = () => null;
  await db.query('CREATE TABLE IF NOT EXISTS sealed_auctions (id TEXT PRIMARY KEY,dataset TEXT UNIQUE NOT NULL,commitment TEXT NOT NULL,owner TEXT NOT NULL,close_at BIGINT NOT NULL,reserve BIGINT NOT NULL,slots INTEGER NOT NULL,used INTEGER NOT NULL,result TEXT)');
  if (!enabled) return unavailable;
  await db.query('CREATE TABLE IF NOT EXISTS sealed_auction_bids (auction TEXT NOT NULL,buyer TEXT NOT NULL,sequence INTEGER NOT NULL,ciphertext TEXT NOT NULL,PRIMARY KEY(auction,buyer))');

  const key = createHash('sha256').update('Data Loom sealed auction bid key v1\0').update(master).digest();
  const find = (id,client=db) => client.one('SELECT * FROM sealed_auctions WHERE id=?',[id]);
  const rules = row => ({reserveMicroUsdc:Number(row.reserve),licenseSlots:row.slots,closesAt:Number(row.close_at),
    pricing:'pay-your-bid',tieBreak:'earliest-accepted-bid'});
  const source = row => db.one(`SELECT * FROM datasets d WHERE d.id=? AND d.commitment=? AND d.state='auction' AND ${unpaused}`,
    [row.dataset,row.commitment]);
  const readBid = (id,row) => JSON.parse(unseal(Buffer.from(row.ciphertext,'base64'),key,id+':'+row.buyer).toString());

  app.post(base,authenticated,async(req,res) => {
    const {dataset,reserveMicroUsdc,licenseSlots,closesAt} = z.object({
      dataset:uuid,reserveMicroUsdc:price,licenseSlots:z.number().int().min(1).max(50),
      closesAt:z.number().int(),consent:z.literal(true)
    }).strict().parse(req.body);
    const now = Date.now();
    if (closesAt<now+60000 || closesAt>now+30*86400000) return res.status(422).json({error:'Choose a close time between one minute and 30 days from now.'});
    const id = randomUUID();
    const datasetRow = await db.transaction(async tx => {
      const locked = await tx.one(`UPDATE datasets SET state='auction' WHERE id=? AND owner=? AND state='draft'
        AND NOT EXISTS (SELECT 1 FROM orders WHERE dataset=?) AND NOT EXISTS (SELECT 1 FROM licenses WHERE dataset=?)
        AND NOT EXISTS (SELECT 1 FROM consent_state WHERE dataset=? AND paused=1) RETURNING commitment`,
        [dataset,req.wallet,dataset,dataset,dataset]);
      if (!locked) return null;
      await tx.query('INSERT INTO sealed_auctions VALUES(?,?,?,?,?,?,?,0,NULL)',
        [id,dataset,locked.commitment,req.wallet,closesAt,reserveMicroUsdc,licenseSlots]);
      return locked;
    });
    if (!datasetRow) return res.status(409).json({error:'Use an active draft dataset version with no prior purchase orders or licenses.'});
    res.status(201).json({id,path:base+'/'+id});
  });

  app.get(base+'/:id',async(req,res) => {
    const row = await find(uuid.parse(req.params.id));
    if (!row) return res.sendStatus(404);
    const dataset = await source(row);
    if (!dataset) return res.sendStatus(404);
    res.json({id:row.id,dataset:row.dataset,title:dataset.title,preview:dataset.preview,license:dataset.license,
      commitment:row.commitment,rules:rules(row),state:row.result?'finalized':Date.now()>=Number(row.close_at)?'closed':'open',
      result:row.result?JSON.parse(row.result):null});
  });

  app.post(base+'/:id/bids',authenticated,async(req,res) => {
    const id = uuid.parse(req.params.id);
    const {amountMicroUsdc} = z.object({amountMicroUsdc:price}).strict().parse(req.body);
    const tag = randomUUID();
    const ciphertext = seal(Buffer.from(JSON.stringify({amount:amountMicroUsdc,tag})),key,id+':'+req.wallet).toString('base64');
    const accepted = await db.transaction(async tx => {
      const row = await tx.one(`UPDATE sealed_auctions SET used=used+1 WHERE id=? AND owner<>? AND result IS NULL
        AND close_at>? AND reserve<=? AND used<? AND NOT EXISTS (SELECT 1 FROM sealed_auction_bids WHERE auction=? AND buyer=?)
        AND EXISTS (SELECT 1 FROM datasets d WHERE d.id=sealed_auctions.dataset AND d.state='auction' AND ${unpaused})
        RETURNING used,close_at`,[id,req.wallet,Date.now(),amountMicroUsdc,maxBids,id,req.wallet]);
      if (!row) return false;
      if (Date.now()>=Number(row.close_at)) {
        await tx.query('UPDATE sealed_auctions SET used=used-1 WHERE id=?',[id]);
        return false;
      }
      const inserted = await tx.one(`INSERT INTO sealed_auction_bids VALUES(?,?,?,?)
        ON CONFLICT(auction,buyer) DO NOTHING RETURNING sequence`,[id,req.wallet,row.used,ciphertext]);
      if (!inserted) await tx.query('UPDATE sealed_auctions SET used=used-1 WHERE id=?',[id]);
      return Boolean(inserted);
    });
    if (!accepted) return res.status(409).json({error:'Bid unavailable. Check the reserve, deadline, and one-bid-per-wallet rule.'});
    res.status(201).json({tag});
  });

  app.post(base+'/:id/finalize',authenticated,async(req,res) => {
    const id = uuid.parse(req.params.id);
    const auction = await find(id);
    const dataset = auction && await source(auction);
    if (!dataset) return res.sendStatus(404);
    if (Date.now()<Number(auction.close_at)) return res.status(409).json({error:'Wait until bidding closes.'});
    if (auction.result) return res.json(JSON.parse(auction.result));
    const bids = await db.transaction(async tx => {
      // Serialize with any bid transaction that took its lock just before the deadline.
      await tx.query('UPDATE sealed_auctions SET used=used WHERE id=?',[id]);
      return (await tx.query('SELECT * FROM sealed_auction_bids WHERE auction=?',[id])).rows;
    });
    const ranked = rankBids(bids.map(row => ({...readBid(id,row),sequence:row.sequence})),Number(auction.reserve),auction.slots);
    const report = {format:'dataloom-sealed-auction-v1',auction:id,dataset:auction.dataset,
      sourceCommitment:auction.commitment,license:dataset.license,rules:rules(auction),winningTags:ranked.map(bid=>bid.tag).sort()};
    const reportData = hash(JSON.stringify(report));
    const quote = await attestationClient.getQuote(Buffer.from(reportData,'hex'));
    if (!quote?.quote) return res.status(503).json({error:'Auction attestation unavailable.'});
    const document = JSON.stringify({report,attestation:{reportData,quote}});
    const stored = await db.one(`UPDATE sealed_auctions SET result=? WHERE id=? AND result IS NULL
      AND EXISTS (SELECT 1 FROM datasets d WHERE d.id=sealed_auctions.dataset AND d.commitment=sealed_auctions.commitment
        AND d.state='auction' AND ${unpaused}) RETURNING result`,[document,id]);
    const result = stored?.result ?? (await find(id))?.result;
    if (!result) return res.status(409).json({error:'Dataset access changed during finalization.'});
    res.json(JSON.parse(result));
  });

  async function award(id,buyer) {
    const auction = await find(id);
    if (!auction) return null;
    const bid = await db.one('SELECT * FROM sealed_auction_bids WHERE auction=? AND buyer=?',[id,buyer]);
    if (!bid) return null;
    const payload = readBid(id,bid);
    const won = Boolean(auction.result && JSON.parse(auction.result).report.winningTags.includes(payload.tag));
    return {dataset:auction.dataset,tag:payload.tag,price:payload.amount,finalized:Boolean(auction.result),won};
  }

  app.get(base+'/:id/my-bid',authenticated,async(req,res) => {
    const bid = await award(uuid.parse(req.params.id),req.wallet);
    if (!bid) return res.sendStatus(404);
    res.json(bid);
  });

  return async (id,dataset,buyer) => {
    const bid = await award(id,buyer);
    if (!bid?.won || bid.dataset!==dataset) return null;
    const row = await source(await find(id));
    return row && {...row,price:bid.price};
  };
}
