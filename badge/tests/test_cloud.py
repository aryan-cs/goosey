"""Exercise cloud UI using mailbox data and a fresh simulated gateway account."""
from harness import *
import json,sys
sys.path.insert(0,str(root/'badge/scripts'))
from cloud_snapshot import detail_mailbox_frame,mailbox_frame
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

def load_detail(market,generation,points):
    start=1234567890000
    detail=dict(generation=str(generation),slug=market['slug'],rangeStart=start,rangeEnd=start+14400000,history=points)
    g.files['appdata/detail_history.txt']=detail_mailbox_frame(detail).decode()
    tick(g.clock+2000)
    tick(g.clock+2000)

g.fresh();has('Reconnecting...');has('Account offline');has('USB required')
texts=[w.text for w in g.widgets.values() if not w.hide and w.text]
assert 'Account' not in texts
offline=next(w for w in g.widgets.values() if w.text=='Account offline')
usb=next(w for w in g.widgets.values() if w.text=='USB required')
assert (offline.x,offline.y,offline.w)==(10,7,125)
assert (usb.x,usb.y,usb.w)==(135,1,175) and usb.styles['text_align']=='right'
assert 'Waiting for connection' not in g.visible()
reconnecting=next(w for w in g.widgets.values() if w.text=='Reconnecting...')
assert reconnecting.y==110 and reconnecting.styles['text_align']=='center'
assert '765.43' not in g.visible() and '@old_local' not in g.visible()
g.files['appdata/account.txt']=f'GA1\t1\t{challenge}\tREADY\tbadge_test\t1000000\tEND\n'
load(source,100)
has('@badge_test · 1000.00 feathers');press('A');has('Markets')
first=source['markets'][0]
has(first['category'].upper());has('Vol '+first['volume']);has(first['closes'].replace(' UTC','Z'))
close_text=first['closes'].replace(' UTC','Z')
title_and_close=next(w for w in g.widgets.values() if not w.hide and w.text.endswith('\n'+close_text))
volume=next(w for w in g.widgets.values() if not w.hide and w.text=='Vol '+first['volume'])
assert (title_and_close.x,title_and_close.y)==(15,61)
assert (volume.x,volume.y,volume.w,volume.styles['text_align'])==(235,109,75,'right')
probability=next(w for w in g.widgets.values() if not w.hide and w.text==f"{first['probability']:.0f}%")
change=next(w for w in g.widgets.values() if not w.hide and w.text.endswith(' pts'))
assert (probability.x,probability.y,probability.styles['text_font'])==(232,57,24)
assert (change.x,change.y)==(235,86)
visible_lines=[w for w in g.widgets.values() if not w.hide and w.kind=='line']
assert len(visible_lines)==2
assert all(w.x==177 and w.y in (88,186) for w in visible_lines)
selected_box=next(w for w in g.widgets.values() if w.kind=='box' and not w.hide and w.styles['border_width']==1)
assert (selected_box.x,selected_box.y,selected_box.w,selected_box.h)==(5,37,310,96)
snapshot('cloud-list')
for index,market in enumerate(source['markets']):
    press('A');has('Market');has(f"{market['probability']:.0f}%");has('Loading 4H')
    assert g.files['appdata/detail_request.txt']==f"GD1\t{market['slug']}\n"
    points=[[market['probability'],1234567880000]]
    if index==0: points=[[50,1234567880000],[61.23,1234575090000],[market['probability'],1234578690000]]
    load_detail(market,1000+index,points)
    has('Past 4 hours');has(market['closes']);has('Vol '+market['volume'])
    if index==0:
        has(f"{market['probability']-50:+.0f} pts")
        ticks=[w for w in g.widgets.values() if not w.hide and w.text.endswith('%') and w.x==7]
        assert len(ticks)==3 and all(w.styles['text_align']=='right' for w in ticks)
        line=next(w for w in g.widgets.values() if w.kind=='line')
        assert line.points[1][1]==0 and line.points[len(line.points)][1]==132
    snapshot('cloud-'+market['slug']);press('B','DOWN')
assert dict(g.saved.items())==before and g.writes==0
assert g.files['appdata/request.txt'] in (None,'')
# Real selected-market mailbox histories, not the catalog frame, drive charts.
for generation,points in ((2000,[]),(2001,[[50,1234567890000]])):
    press('A');load_detail(source['markets'][0],generation,points)
    if not points:has('No history')
    snapshot('cloud-empty' if not points else 'cloud-single');press('B')
# Reopening cannot trust a cached account frame as a fresh login.
g.on_exit();g.fresh();has('Reconnecting...')
assert 'Waiting for connection' not in g.visible()
assert dict(g.saved.items())==before and g.writes==0
print('PASS cloud mailbox metadata/history, empty/single charts, navigation, account freshness and saved-wallet isolation')
