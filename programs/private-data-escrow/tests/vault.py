from solders.litesvm import LiteSVM
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.account import Account
from solders.instruction import Instruction,AccountMeta
from solders.transaction import Transaction
from solders.transaction_metadata import FailedTransactionMetadata
from pathlib import Path
import hashlib,struct,re
root=Path(__file__).resolve().parents[1]
program=Pubkey.from_string(re.search(r'declare_id!\("([^"]+)"', (root/'src/lib.rs').read_text()).group(1))
token=Pubkey.from_string('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');mint=Pubkey.from_string('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');system=Pubkey.default();rent=Pubkey.from_string('SysvarRent111111111111111111111111111111111')
def run(refund=False):
 svm=LiteSVM();svm.add_program_from_file(program,root/'target/deploy/loom_data_escrow.so')
 buyer,seller,verifier,platform,attacker=[Keypair() for _ in range(5)]
 for k in [buyer,seller,verifier,platform,attacker]:svm.airdrop(k.pubkey(),10_000_000_000)
 m=bytearray(82);struct.pack_into('<Q',m,36,10_000_000);m[44]=6;m[45]=1;svm.set_account(mint,Account(10_000_000,bytes(m),token))
 def ta(owner,amount):
  key=Keypair().pubkey();data=bytearray(165);data[:32]=bytes(mint);data[32:64]=bytes(owner);struct.pack_into('<Q',data,64,amount);data[108]=1;svm.set_account(key,Account(10_000_000,bytes(data),token));return key
 bt=ta(buyer.pubkey(),2_000_000);st=ta(seller.pubkey(),0);pt=ta(platform.pubkey(),0);bad=ta(attacker.pubkey(),0)
 nonce=hashlib.sha256(bytes(buyer.pubkey())).digest();terms=hashlib.sha256(b'agreed terms').digest();proof=hashlib.sha256(b'passing checks and snapshot').digest()
 escrow,_=Pubkey.find_program_address([b'escrow',bytes(buyer.pubkey()),nonce],program);vault,_=Pubkey.find_program_address([b'vault',bytes(escrow)],program)
 def meta(key,sign=False,write=False):return AccountMeta(key,sign,write)
 def send(name,args,metas,signers,ok=True):
  ix=Instruction(program,hashlib.sha256(('global:'+name).encode()).digest()[:8]+args,metas)
  tx=Transaction.new_signed_with_payer([ix],signers[0].pubkey(),signers,svm.latest_blockhash());result=svm.send_transaction(tx)
  failed=isinstance(result,FailedTransactionMetadata)
  assert failed!=ok,(name,result)
  svm.expire_blockhash()
  return result
 def bal(key):return struct.unpack_from('<Q',svm.get_account(key).data,64)[0]
 deadline=svm.get_clock().unix_timestamp+3600
 send('create',nonce+terms+bytes(seller.pubkey())+bytes(verifier.pubkey())+bytes(platform.pubkey())+struct.pack('<Qq',1_000_000,deadline),[meta(buyer.pubkey(),True,True),meta(escrow,write=True),meta(mint),meta(vault,write=True),meta(token),meta(system),meta(rent)],[buyer])
 fund=[meta(buyer.pubkey(),True),meta(escrow,write=True),meta(mint),meta(bt,write=True),meta(vault,write=True),meta(token)]
 send('fund',terms,fund,[buyer],False)
 send('accept',terms,[meta(attacker.pubkey(),True),meta(escrow,write=True)],[attacker],False)
 send('accept',terms,[meta(seller.pubkey(),True),meta(escrow,write=True)],[seller])
 send('fund',terms,fund,[buyer]);assert bal(vault)==1_000_000 and bal(st)==0 and bal(pt)==0
 send('fund',terms,fund,[buyer],False)
 def release(who=verifier,dest=st):return [meta(who.pubkey(),True),meta(escrow,write=True),meta(buyer.pubkey(),write=True),meta(mint),meta(vault,write=True),meta(dest,write=True),meta(pt,write=True),meta(bt,write=True),meta(token)]
 send('release',terms+proof,release(attacker),[attacker],False)
 send('release',terms+proof,release(dest=bad),[verifier],False)
 refund_accounts=[meta(buyer.pubkey(),True,True),meta(escrow,write=True),meta(mint),meta(vault,write=True),meta(bt,write=True),meta(token)]
 send('refund',b'',refund_accounts,[buyer],False)
 if refund:
  clock=svm.get_clock();clock.unix_timestamp=deadline;svm.set_clock(clock)
  send('release',terms+proof,release(),[verifier],False)
  send('refund',b'',refund_accounts,[buyer]);assert bal(bt)==2_000_000 and bal(st)==0 and bal(pt)==0
  send('refund',b'',refund_accounts,[buyer],False)
 else:
  send('release',bytes(32)+proof,release(),[verifier],False)
  send('release',terms+proof,release(),[verifier]);assert bal(st)==700_000 and bal(pt)==300_000 and bal(bt)==1_000_000
  send('release',terms+proof,release(),[verifier],False)
 print('PASS', 'timeout refund' if refund else 'verified release', ': custody, signer and recipient constraints, replay rejection')
run();run(True)
