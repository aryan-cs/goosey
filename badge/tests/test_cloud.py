"""Exercise cloud UI using mailbox data and a fresh simulated gateway account."""
from harness import *
import copy,json,sys
sys.path.insert(0,str(root/'badge/scripts'))
from cloud_snapshot import mailbox_frame
source=json.loads((output/'snapshot.json').read_text())
g.saved['paper_v2']='1,76543,2,1,0,0,0,0,0,0,0,0,0,0'
g.saved['username_v1']='old_local'
before=dict(g.saved.items())
challenge='a'*64

def tick(at):
    g.clock=at;g.on_tick()
    for _ in range(20):g.on_tick()

def load(data, generation):
    data=dict(data,generation=str(generation))
    g.mailbox=mailbox_frame(data).decode()
    g.files['appdata/market_generation.txt']=str(generation)
    tick(g.clock+2000)
    tick(g.clock+2000)

g.fresh();has('Reconnecting...')
assert 'Waiting for connection' not in g.visible()
reconnecting=next(w for w in g.widgets.values() if w.text=='Reconnecting...')
assert reconnecting.y==110 and reconnecting.styles['text_align']=='center'
assert '765.43' not in g.visible() and '@old_local' not in g.visible()
g.files['appdata/account.txt']=f'GA1\t1\t{challenge}\tREADY\tbadge_test\t1000000\tEND\n'
load(source,100)
has('@badge_test');press('A');has('Markets');snapshot('cloud-list')
for market in source['markets']:
    press('A');has('Market');has(f"{market['probability']:.1f}%");has(market['closes'])
    snapshot('cloud-'+market['slug']);press('B','DOWN')
assert dict(g.saved.items())==before and g.writes==0
assert g.files['appdata/request.txt'] in (None,'')
# Real mailbox histories, not embedded Lua literals, drive empty/single charts.
for generation,points in ((101,[]),(102,[[50,1234567890000]])):
    changed=copy.deepcopy(source);changed['markets'][0]['history']=points
    load(changed,generation);press('A')
    if not points:has('No history')
    snapshot('cloud-empty' if not points else 'cloud-single');press('B')
# Reopening cannot trust a cached account frame as a fresh login.
g.on_exit();g.fresh();has('Reconnecting...')
assert 'Waiting for connection' not in g.visible()
assert dict(g.saved.items())==before and g.writes==0
print('PASS cloud mailbox metadata/history, empty/single charts, navigation, account freshness and saved-wallet isolation')
