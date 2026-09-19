from harness import *
import json,sys
sys.path.insert(0,str(root/'badge/scripts'))
from cloud_snapshot import mailbox_frame
g.mailbox=mailbox_frame(json.loads((output/'snapshot.json').read_text())).decode()
challenge='a'*64

def account(gen,state='READY'):
    g.files['appdata/account.txt']=f'GA1\t{gen}\t{challenge}\t{state}\tbadge_test\t1000000\tEND\n'
def tick(at): g.clock=at;g.on_tick()
def response(state,qid='c123456789012345678901234',amount='50001',ttl=20,message='Trade complete'):
    rid=g.files['appdata/request.txt'].split('\t')[1]
    g.files['appdata/response.txt']=f'GR1\t{rid}\t{challenge}\t{state}\t{qid}\t{amount}\t0\t{ttl}\t{message}\tEND\n'
account(1);g.fresh();has('Preparing sign-in');snapshot('trade-link')
account(2);tick(2000);has('@badge_test');has('1000.000')
press('A','A','A');has('BUY YES');press('UP');has('x2');snapshot('trade-amount')
press('A');has('Getting a live quote');assert '\tQUOTE\t' in g.files['appdata/request.txt']
response('QUOTE');tick(4000);has('Pay 50.001');snapshot('trade-review')
press('A');has('Trade submitted');assert '\tTRADE\t' in g.files['appdata/request.txt']
saved=g.files['appdata/request.txt'];press('A','A','B','START');assert g.files['appdata/request.txt']==saved
# Reopening never drops a confirmed order; cached account is not trusted fresh.
g.on_exit();g.fresh();has('Account offline');press('A','A');has('Trade submitted')
response('PENDING',message='Waiting for receipt');tick(6000);has('Waiting for receipt');snapshot('trade-pending')
response('DONE');tick(8000);has('Trade complete');assert g.files['appdata/request.txt']=='';snapshot('trade-receipt')
account(3);tick(10000);press('B','A','A');response('QUOTE',ttl=1);tick(12000);tick(14000);has('Quote expired')
assert '\tTRADE\t' not in g.files['appdata/request.txt']
# A quote cannot become a trade after USB account freshness expires.
press('B','A','A');response('QUOTE');tick(16000);tick(46000);press('A');assert '\tTRADE\t' not in g.files['appdata/request.txt']
assert g.saved['paper_v2'] is None
print('PASS badge fresh account, quote/review, single confirmation, pending restart, receipt, expiry and saved-wallet isolation')
