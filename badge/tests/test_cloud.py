"""Run against BADGE_OUTPUT produced with --cloud-url."""
from harness import *
import json

source = json.loads((output / 'snapshot.json').read_text())
g.saved['paper_v2']='1,76543,2,1,0,0,0,0,0,0,0,0,0,0'
g.saved['username_v1']='old_local'
before = dict(g.saved.items())
g.fresh()
has('Markets'); has('Saved snapshot')
assert '765.43' not in g.visible() and '@old_local' not in g.visible()
snapshot('cloud-list')
for market in source['markets']:
    press('A')
    has('Market');has(f"{market['probability']:.1f}%")
    has(market['closes'])
    snapshot('cloud-' + market['slug'])
    # A never creates a local ticket, debits money or writes private saves.
    press('A');has('getgoosey.vercel.app');snapshot('cloud-account')
    press('A');has('getgoosey.vercel.app')
    press('B','DOWN')
press('START','DOWN','A');has('getgoosey.vercel.app')
g.on_exit();g.fresh();has('Saved snapshot')
assert dict(g.saved.items()) == before and g.writes == 0

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
