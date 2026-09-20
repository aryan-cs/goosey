from harness import *
import json,sys
sys.path.insert(0,str(root/'badge/scripts'))
from cloud_snapshot import mailbox_frame
g.mailbox=mailbox_frame(json.loads((output/'snapshot.json').read_text())).decode()
challenge='a'*64

def account(gen,state='READY'):
    g.files['appdata/account.txt']=f'GA1\t{gen}\t{challenge}\t{state}\tbadge_test\t1000000\tEND\n'
def tick(at):
    g.clock=at;g.on_tick()
    for _ in range(17):g.on_tick()
def response(state,qid='c123456789012345678901234',amount='50001',ttl=20,message='Trade complete'):
    rid=g.files['appdata/request.txt'].split('\t')[1]
    g.files['appdata/response.txt']=f'GR1\t{rid}\t{challenge}\t{state}\t{qid}\t{amount}\t0\t{ttl}\t{message}\tEND\n'
account(1);g.fresh();has('Reconnecting...');assert 'Waiting for connection' not in g.visible()
reconnecting=next(w for w in g.widgets.values() if w.text=='Reconnecting...')
assert reconnecting.y==110 and reconnecting.styles['text_align']=='center'
assert lua.eval('require("trade").pairing_challenge()') is None;snapshot('trade-link')
account(2);tick(2000);has('Account Linked');has('@badge_test');has('1,000 feathers');has('A: Continue   B: Markets');assert 'Balance ' not in g.visible();snapshot('trade-account-linked')
press('A','A','A');has('BUY YES');has('Review Trade');press('UP');has('x2');snapshot('trade-amount')
press('A');has('Getting a live quote');assert '\tQUOTE\t' in g.files['appdata/request.txt']
response('QUOTE');tick(4000);has('Pay 50');has('Confirm Trade');snapshot('trade-review')
press('A');has('Trade Submitted');assert '\tTRADE\t' in g.files['appdata/request.txt']
saved=g.files['appdata/request.txt'];press('A','A','B','START');assert g.files['appdata/request.txt']==saved
# Reopening never drops a confirmed order; cached account is not trusted fresh.
g.on_exit();g.fresh();has('Account Offline');has('USB Required');press('A','A');has('Trade Submitted')
response('PENDING',message='Waiting for receipt');tick(6000);has('Waiting for receipt');snapshot('trade-pending')
response('DONE');tick(8000);has('Trade complete');assert g.files['appdata/request.txt']=='';snapshot('trade-receipt')
account(3);tick(10000);press('B','A','A');response('QUOTE',ttl=1);tick(12000);tick(14000);has('Quote expired')
assert '\tTRADE\t' not in g.files['appdata/request.txt']
# A quote cannot become a trade after USB account freshness expires.
press('B','A','A');response('QUOTE');tick(16000);tick(46000);press('A');assert '\tTRADE\t' not in g.files['appdata/request.txt']
assert g.saved['paper_v2'] is None
print('PASS badge fresh account, quote/review, single confirmation, pending restart, receipt, expiry and saved-wallet isolation')

# Only an explicit fresh LINK may expose the QR. Cached frames and outages cannot.
g.on_exit();g.fresh();has('Reconnecting...')
account(4,'OFFLINE');tick(48000);assert lua.eval('require("trade").pairing_challenge()') is None
account(5,'LINK');tick(50000);assert lua.eval('require("trade").pairing_challenge()')==challenge
tick(86000);assert lua.eval('require("trade").pairing_challenge()') is None
account(6);tick(88000);has('@badge_test')
print('PASS reconnect, explicit link, stale QR expiry and session restoration')

# Request IDs survive broken config writes and restart; never reuse a prior ID.
lua.execute("badge.store.set_str=function() end")
lua.execute('require("trade").open("htn-2026-mc-does-67","YES","Test")')
press('A');has('Getting a live quote')
first=int(g.files['appdata/request.txt'].split('\t')[1])
assert int(g.files['appdata/request_sequence.txt'])==first
g.on_exit();g.fresh();account(7);tick(90000)
lua.execute('require("trade").open("htn-2026-mc-does-67","YES","Test")')
press('A');has('Getting a live quote')
assert int(g.files['appdata/request.txt'].split('\t')[1])>first
print('PASS durable request sequence with unavailable config writes and restart')

# User-visible milli-feather values round half-up to whole feathers without
# passing through Lua's floating-point number representation.
g.on_exit();g.fresh()
for generation,value,expected in (
    (20,'0','0'),
    (21,'499','0'),
    (22,'500','1'),
    (23,'1499','1'),
    (24,'1500','2'),
    (25,'999499','999'),
    (26,'999500','1,000'),
    (27,'9007199254740993499','9,007,199,254,740,993'),
    (28,'9007199254740993500','9,007,199,254,740,994'),
):
    g.files['appdata/account.txt']=f'GA1\t{generation}\t{challenge}\tREADY\tbadge_test\t{value}\tEND\n'
    tick(g.clock+2000)
    has(expected+' feathers')
print('PASS badge whole-feather display rounding, ties, grouping and large integer precision')
