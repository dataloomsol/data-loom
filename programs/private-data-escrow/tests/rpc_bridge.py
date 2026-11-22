# Test-only JSON bridge: actual SBF execution, synthetic mainnet metadata, no network.
import sys,json,struct,base64,re,time
from pathlib import Path
from solders.litesvm import LiteSVM
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.account import Account
from solders.transaction import VersionedTransaction
from solders.transaction_metadata import FailedTransactionMetadata
root=Path(__file__).resolve().parents[1];code=(root/'target/deploy/loom_data_escrow.so').read_bytes();program=Pubkey.from_string(re.search(r'declare_id!\("([^"]+)"',(root/'src/lib.rs').read_text()).group(1));svm=LiteSVM();svm.add_program_from_file(program,root/'target/deploy/loom_data_escrow.so')
clock=svm.get_clock();clock.unix_timestamp=int(time.time());svm.set_clock(clock)
roles={name:Keypair() for name in ['buyer','contributor','verifier','platform','stranger']}
for k in roles.values():svm.airdrop(k.pubkey(),10_000_000_000)
token=Pubkey.from_string('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');mint=Pubkey.from_string('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');ata_program=Pubkey.from_string('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
m=bytearray(82);struct.pack_into('<Q',m,36,100_000_000);m[44]=6;m[45]=1;svm.set_account(mint,Account(10_000_000,bytes(m),token));programdata=Keypair().pubkey()
for name,k in roles.items():
 ata,_=Pubkey.find_program_address([bytes(k.pubkey()),bytes(token),bytes(mint)],ata_program);data=bytearray(165);data[:32]=bytes(mint);data[32:64]=bytes(k.pubkey());struct.pack_into('<Q',data,64,10_000_000 if name=='buyer' else 0);data[108]=1;svm.set_account(ata,Account(10_000_000,bytes(data),token))
print(json.dumps({'roles':{n:str(k.pubkey()) for n,k in roles.items()},'program':str(program),'size':len(code),'clock':svm.get_clock().unix_timestamp}),flush=True)
def result(method,p):
 if method=='getGenesisHash':return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
 if method=='getAccountInfo':
  pk=Pubkey.from_string(p[0]);a=svm.get_account(pk)
  if pk==program:return {'value':{'executable':True,'owner':'BPFLoaderUpgradeab1e11111111111111111111111','data':[base64.b64encode(struct.pack('<I',2)+bytes(programdata)).decode(),'base64']}}
  if pk==programdata:return {'value':{'owner':'BPFLoaderUpgradeab1e11111111111111111111111','data':[base64.b64encode(struct.pack('<I',3)+bytes(41)+code).decode(),'base64']}}
  if not a:return {'value':None}
  if pk==mint and p[1].get('encoding')=='jsonParsed':return {'value':{'owner':str(token),'data':{'parsed':{'info':{'decimals':6}}}}}
  return {'value':{'owner':str(a.owner),'executable':a.executable,'data':[base64.b64encode(a.data).decode(),'base64']}}
 if method=='getLatestBlockhash':return {'value':{'blockhash':str(svm.latest_blockhash()),'lastValidBlockHeight':10000}}
 if method in ['simulateTransaction','__send']:
  unsigned=VersionedTransaction.from_bytes(base64.b64decode(p[0]));payer=str(unsigned.message.account_keys[0]);signer=next(k for k in roles.values() if str(k.pubkey())==payer);tx=VersionedTransaction(unsigned.message,[signer]);r=svm.send_transaction(tx) if method=='__send' else svm.simulate_transaction(tx)
  if isinstance(r,FailedTransactionMetadata):return {'value':{'err':str(r)}}
  if method=='__send':svm.expire_blockhash()
  return {'value':{'err':None}}
 if method=='__clock':
  c=svm.get_clock();c.unix_timestamp=p[0];svm.set_clock(c);return True
 raise Exception('Unsupported '+method)
for line in sys.stdin:
 try:
  req=json.loads(line);print(json.dumps({'id':req['id'],'result':result(req['method'],req['params'])}),flush=True)
 except Exception as e:print(json.dumps({'id':req.get('id'),'error':str(e)}),flush=True)
