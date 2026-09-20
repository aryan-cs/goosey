"""Exercise cloud UI using mailbox data and a fresh simulated gateway account."""
from harness import *
import json,sys
sys.path.insert(0,str(root/'badge/scripts'))
from cloud_snapshot import detail_mailbox_frame,mailbox_frame
assert 'for word in s:gmatch("%S+") do\nif #word' not in code
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

def load_detail(market,generation,points,current=None,sampled_from=None,downsampled=False,source_kind='PROBABILITY'):
    start=1234567890000
    detail=dict(generation=str(generation),slug=market['slug'],rangeStart=start,rangeEnd=start+3600000,
                currentProbabilityBps=market['probabilityBps'] if current is None else current,
                sampledFrom=len(points) if sampled_from is None else sampled_from,
                downsampled=downsampled,source=source_kind,history=points)
    g.files['appdata/detail_history.txt']=detail_mailbox_frame(detail).decode()
    tick(g.clock+2000)
    tick(g.clock+2000)

g.fresh();has('Reconnecting...');has('Account Offline');has('USB Required')
texts=[w.text for w in g.widgets.values() if not w.hide and w.text]
assert 'Account' not in texts
offline=next(w for w in g.widgets.values() if w.text=='Account Offline')
usb=next(w for w in g.widgets.values() if w.text=='USB Required')
assert (offline.x,offline.y,offline.w)==(10,7,125)
assert (usb.x,usb.y,usb.w)==(135,1,175) and usb.styles['text_align']=='right'
assert 'Waiting for connection' not in g.visible()
reconnecting=next(w for w in g.widgets.values() if w.text=='Reconnecting...')
assert reconnecting.y==110 and reconnecting.styles['text_align']=='center'
assert '765.43' not in g.visible() and '@old_local' not in g.visible()
g.files['appdata/account.txt']=f'GA1\t1\t{challenge}\tREADY\tbadge_test\t1000000\tEND\n'
load(source,100)
has('@badge_test · 1,000 feathers');press('A');has('Markets')
press('START');has('Return to Markets');has('Account Info');has('USB Account and Market Sync')
assert 'Return to markets' not in g.visible();assert 'Linked account' not in g.visible();assert 'Trade selected market' not in g.visible()
settings_box=next(w for w in g.widgets.values() if w.kind=='box' and not w.hide and w.styles['border_width']==1)
assert settings_box.y==47
press('DOWN');assert settings_box.y==93;snapshot('cloud-settings');press('A')
has('Account Linked');has('@badge_test');has('1,000 feathers');assert lua.eval('require("trade").slug') is None
press('B');has('Markets')
first=source['markets'][0]
for market in source['markets'][:3]:
    has(f"{(market['probabilityBps']+50)//100}%")
visible=g.visible()
assert first['category'].upper() not in visible
assert 'Vol ' not in visible and ' pts' not in visible and first['closes'] not in visible
title=next(w for w in g.widgets.values() if not w.hide and w.x==15 and w.y==50)
probability=next(w for w in g.widgets.values() if not w.hide and w.text==f"{(first['probabilityBps']+50)//100}%")
assert (title.w,title.styles['text_font'])==(160,14)
assert (probability.x,probability.y,probability.w,probability.styles['text_font'])==(244,58,66,22)
visible_lines=[w for w in g.widgets.values() if not w.hide and w.kind=='line']
expected_lines=sum(len(m['history'])>=2 for m in source['markets'][:3])
assert len(visible_lines)==expected_lines
assert all(w.x==180 and w.y in (56,121,186) for w in visible_lines)
assert sum(w.kind=='line' for w in g.widgets.values())==3
selected_box=next(w for w in g.widgets.values() if w.kind=='box' and not w.hide and w.styles['border_width']==1)
assert (selected_box.x,selected_box.y,selected_box.w,selected_box.h)==(5,36,310,61)
snapshot('cloud-list')
for index,market in enumerate(source['markets']):
    press('A');has('Market');has(f"{(market['probabilityBps']+50)//100}%");has('Loading 1H History...')
    assert g.files['appdata/detail_request.txt']==f"GD1\t{market['slug']}\n"
    points=[[market['probabilityBps'],1234567880000]]
    if index==0: points=[[5000,1234567880000],[6123,1234568790000],[5050,1234570590000]]
    load_detail(market,1000+index,points,current=5050 if index==0 else None,
                sampled_from=41 if index==0 else None,downsampled=index==0)
    has('Sampled 1H' if index==0 else 'Past 1 Hour');has(market['closes']);has('Vol '+market['volume'])
    if index==0:
        # Coherent history owns the headline. Half-percent values round up and
        # the displayed NO value is the exact complement of displayed YES.
        has('51%');has('YES  51%');has('NO  49%');has('+1 pts')
        market_title=next(w for w in g.widgets.values() if not w.hide and w.x==10 and w.y==36)
        probability=next(w for w in g.widgets.values() if not w.hide and w.text=='51%' and w.x==212)
        change=next(w for w in g.widgets.values() if not w.hide and w.text.startswith('+1 pts'))
        volume=next(w for w in g.widgets.values() if not w.hide and w.text=='Vol '+market['volume'])
        market_status=next(w for w in g.widgets.values() if not w.hide and w.text=='[Open]')
        close_label=next(w for w in g.widgets.values() if not w.hide and w.text=='Closes '+market['closes'])
        title_lines=market_title.text.split('\n')
        assert (market_title.w,market_title.styles['text_font'])==(300,16) and len(title_lines)<=2
        assert (probability.y,probability.w,probability.styles['text_font'])==(100,98,24)
        assert (change.x,change.y,change.w,change.styles['text_align'])==(10,36+18*len(title_lines),190,'left')
        assert change.text.endswith(' | Sampled 1H') and change.y+14<=90
        assert (volume.x,volume.y,volume.w)==(212,139,98)
        assert (market_status.x,market_status.y,market_status.w,market_status.styles['text_align'])==(10,186,90,'left')
        assert market_status.styles['text_color']==0x267a35
        assert (close_label.x,close_label.y,close_label.w,close_label.styles['text_align'])==(100,186,210,'right')
        assert not any('Open  Closes' in w.text for w in g.widgets.values() if not w.hide)
        ticks=[w for w in g.widgets.values() if not w.hide and w.text.endswith('%') and w.x==7]
        assert [w.text for w in ticks]==['100%','50%','0%']
        assert all(w.styles['text_align']=='right' for w in ticks)
        line=next(w for w in g.widgets.values() if w.kind=='line')
        assert (line.x,line.y)==(52,90)
        # Step-after geometry holds the old price until each observation,
        # jumps vertically, then holds the last real value to the server as-of.
        assert len(line.points)==6
        assert line.points[1][1]==0 and line.points[2][1]==line.points[3][1]
        assert line.points[2][2]==line.points[1][2] and line.points[3][2]!=line.points[2][2]
        assert line.points[4][1]==line.points[5][1]
        assert line.points[4][2]==line.points[3][2] and line.points[5][2]!=line.points[4][2]
        assert line.points[6][1]==132 and line.points[6][2]==line.points[5][2]
        assert line.points[1][2]==44 and line.points[3][2]==34 and line.points[5][2]==43
    snapshot('cloud-'+market['slug']);press('B')
    if index==0: assert (close_label.x,close_label.y,close_label.w,close_label.text)==(149,16,161,'')
    press('DOWN')
assert dict(g.saved.items())==before and g.writes==0
assert g.files['appdata/request.txt'] in (None,'')
# Real selected-market mailbox histories, not the catalog frame, drive charts.
for generation,points in ((2000,[]),(2001,[[5000,1234567890000]])):
    press('A');load_detail(source['markets'][0],generation,points)
    expected='1 Price | Past 1 Hour' if points else 'No History | Past 1 Hour'
    has(expected);assert ' pts' not in expected
    snapshot('cloud-empty' if not points else 'cloud-single');press('B')
# Bracketed terminal states stay distinct from the right-aligned close field.
closed=json.loads(json.dumps(source));closed['markets'][0]['status']='CLOSED';load(closed,3000);tick(g.clock+2000);press('A')
closed_status=next(w for w in g.widgets.values() if not w.hide and w.text=='[Closed]')
assert (closed_status.x,closed_status.y,closed_status.styles['text_color'])==(10,186,0x4f6b3e)
has('Closes '+closed['markets'][0]['closes']);press('B')
# Reopening cannot trust a cached account frame as a fresh login.
g.on_exit();g.fresh();has('Reconnecting...')
assert 'Waiting for connection' not in g.visible()
assert dict(g.saved.items())==before and g.writes==0
print('PASS cloud mailbox metadata/history, empty/single charts, navigation, account freshness and saved-wallet isolation')
