"""Run against BADGE_OUTPUT produced with --cloud-url."""
from harness import *
import json

source = json.loads((output / 'snapshot.json').read_text())
g.saved['paper_v2']='1,76543,2,1,0,0,0,0,0,0,0,0,0,0'
g.saved['username_v1']='old_local'
before = dict(g.saved.items())
g.fresh()
has('Markets'); has('Account offline')
assert '765.43' not in g.visible() and '@old_local' not in g.visible()
snapshot('cloud-list')
for market in source['markets']:
    press('A')
    has('Market');has(f"{market['probability']:.1f}%")
    has(market['closes'])
    snapshot('cloud-' + market['slug'])
    # A never creates a local ticket, debits money or writes private saves.
    press('A');has('getgoosey.vercel.app/badge');snapshot('cloud-account')
    press('A');has('getgoosey.vercel.app/badge')
    press('B','B','DOWN')
press('START','DOWN','A');has('getgoosey.vercel.app/badge')
g.on_exit();g.fresh();has('Account offline')
assert dict(g.saved.items()) == before and g.writes == 0

# USB responses are applied atomically; partial writes never replace data.
import sys
sys.path.insert(0, str(root / 'badge/scripts'))
from cloud_snapshot import mailbox_frame
newer = dict(source, generation=str(int(source.get('generation','1'))+1000))
frame = mailbox_frame(newer).decode()
g.clock=2000;g.mailbox=frame[:-10];g.on_tick();has('Account offline')
g.clock=4000;g.mailbox=frame;g.on_tick();has('Account offline')
g.clock=6000;g.mailbox=frame.replace('END\t','BROKEN\t');g.on_tick();has('Account offline')
g.clock=8000;g.mailbox=mailbox_frame(dict(newer,generation='1')).decode();g.on_tick();has('Account offline')
g.clock=50000;g.on_tick();has('Account offline')
g.mailbox=frame;g.on_exit();g.fresh();has('Account offline')
assert dict(g.saved.items()) == before and g.writes == 0
g.mailbox=None

# Empty and one-point histories must not be replaced with invented prices.
import re
for points in ('{}', '{{50,1234567890000}}'):
    altered = re.sub(r'\["history"\]=\{(?:\{[^{}]*\},?)*\}', '["history"]=' + points, code)
    lua.execute(altered)
    g.fresh();press('A')
    if points == '{}': has('No history')
    snapshot('cloud-empty' if points == '{}' else 'cloud-single')
    g.on_exit()
assert dict(g.saved.items()) == before and g.writes == 0
print('Cloud snapshot: real metadata/history, empty/single charts, read-only controls, saves preserved.')
