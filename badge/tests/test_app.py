from harness import *

# First-run picker requires an explicitly chosen, durably saved name.
g.fresh();has('Your name');snapshot('00-username')
press('START');has('Your name')
press('UP','RIGHT','RIGHT','A');has('Use 3-12')
press('DOWN','LEFT','LEFT','A','RIGHT','A','RIGHT','A')
press('UP');press('A')
has('@abc');assert g.saved['username_v1']=='abc'
g.on_exit();g.fresh();has('Markets');has('@abc')
# Invalid stored names cannot bypass setup; failed writes cannot finish setup.
g.saved['username_v1']='person@example.com';g.fresh();has('Your name')
press('A','RIGHT','A','RIGHT','A','UP')
g.fail_save=True;press('A');has('Could not save');has('Your name')
g.fail_save=False;press('A');has('@abc')
# Long names remain in bounds and a thirteenth character is rejected.
g.saved['username_v1']=None;g.fresh()
for _ in range(12):press('A')
press('A');has('12 characters maximum');snapshot('username-limit')
press('UP','RIGHT','RIGHT','A');has('@aaaaaaaaaaaa')
snapshot('username-header')
# A different badge starts with empty app-scoped personal storage.
g.saved['username_v1']=None;g.fresh();has('Your name')
g.saved['username_v1']='bowen';g.writes=0;g.fresh();has('1000.00');snapshot('01-markets')
# A opens; B backs out; Start settings never places an order.
press('A');has('50.0%');snapshot('02-market')
press('START');has('Settings');press('B');has('Market')
press('A');has('Order');press('DOWN','DOWN','RIGHT','RIGHT');has('< 3 >');snapshot('03-ticket')
press('DOWN','A');has('Buy 3 YES shares');snapshot('04-review')
press('START');has('Settings');assert g.writes==0
press('B','A');has('Order saved');assert g.writes==1;snapshot('05-receipt')
# The next A leaves receipt, a repeated A only opens a ticket.
press('A','A');assert g.writes==1
press('RIGHT','DOWN','DOWN','RIGHT','RIGHT','DOWN','A','A');has('Sold 3 YES');assert g.writes==2
parts=[int(x) for x in g.saved['paper_v2'].split(',')];assert parts[1]<=100000 and parts[2:]==[0]*12
press('A','A','RIGHT');review();has('Not enough shares');assert g.writes==2
# Buy NO, then verify saved portfolio and account.
press('B','RIGHT','A');review();press('A');has('Bought 1 NO');saved=g.saved['paper_v2']
g.on_exit();assert len(list(g.leds.values()))==0
g.fresh();assert g.saved['paper_v2']==saved
settings_item(2);has('0Y\n1N');snapshot('08-portfolio')
press('B','DOWN','A');has('TEST-BADGE-001');snapshot('06-account')
press('A');has('Your name');snapshot('09-edit-username');press('START');has('Account');has('@bowen')
# Failed persistence never applies a trade.
g.fresh();press('A','A');review();g.fail_save=True;press('A');has('Save failed');assert g.saved['paper_v2']==saved
g.fail_save=False
# Every full title appears in the list and detail, with no ellipsis.
import json
catalog=json.loads((output/'markets.json').read_text())
g.fresh()
for i,m in enumerate([m for m in catalog if not m['orderBook']]):
    assert m['title'] in g.visible().replace('\n',' ')
    snapshot('list-check')
    press('A');snapshot('detail-check')
    assert m['title'] in g.visible().replace('\n',' ')
    if m['orderBook']:
        press('A');has('View only');assert 'Review order' not in g.visible()
    press('B','DOWN')
has('white person')
before=g.visible();g.on_button(g.badge.input.BUTTON.DOWN,2);assert g.visible()==before
g.saved['paper_v2']='1,0,-5';g.fresh();has('1000.00')
g.badge.me.badge_id=lua.eval('function() return nil end');settings_item(3);has('Not provisioned')
assert len(list(g.widgets.values()))<=20
assert 'BOOK' not in g.visible()
widget_count=len(list(g.widgets.values()));saved_writes=g.writes
for tick in range(120):g.clock=tick*100;g.on_tick()
assert len(list(g.widgets.values()))==widget_count and g.writes==saved_writes
g.on_exit();assert len(list(g.leds.values()))==0
g.saved['paper_v2']=None;g.fresh();press('A')
for i in range(14):
    g.clock=i*1000
    buy();press('A')
snapshot('07-paper-history')
assert max(len(list(w.points.values())) for w in g.widgets.values() if w.kind=='line')==12
g.saved['paper_v2']='1,0,'+','.join(['0']*12);g.fresh();press('A','A');review();has('Not enough paper feathers')
g.saved['paper_v2']='1,,20,'+','.join(['0']*12);g.fresh();has('1000.00')
assert (output/'goosey.lua').stat().st_size<48*1024
print('PASS: A/B navigation, settings return without trading, all full titles, list/detail layout,')
print('buy/sell accounting, repeated button safety, saved portfolio, failed/malformed saves,')
print('balance/share limits, order-book hidden, graph cap, <=20 widgets, idle without writes.')
print('Host preview uses approximate fonts; physical badge verification is separate.')

# Two samples span the chart; one sample never fabricates a second point.
g.saved['paper_v2']=None;g.fresh();press('A')
line=next(w for w in g.widgets.values() if w.kind=='line')
assert line.hide
assert 'Vol --' in g.visible() and 'Closes --' in g.visible()
g.clock=20000;buy();press('A')
assert not line.hide
assert line.points[1][1]==0 and line.points[2][1]==170
assert 'pts' in g.visible()
# List wraps through the six selected markets.
g.fresh();press('UP','A');has('selfie')
assert 'order book' not in g.visible().lower()

# Legacy save is untouched and never interpreted under new market identities.
legacy='1,12345,'+','.join(['2']*22)
g.saved['paper_v1']=legacy;g.saved['paper_v2']=None;g.fresh()
has('1000.00');assert g.saved['paper_v1']==legacy
# The final market can hold shares (it is no longer a view-only order book).
press('UP','A');buy();g.on_exit();g.fresh()
assert g.saved['paper_v1']==legacy
settings_item(2);press('UP');has('1Y')

# Original three-market wallet expands without loss or a write on read.
g.saved['paper_v2']='1,123456,2,3,4,5,6,7';before_writes=g.writes;g.fresh()
has('1234.56');assert g.writes==before_writes
settings_item(2);has('2Y\n3N');has('4Y\n5N');has('6Y\n7N')
press('DOWN','DOWN','DOWN');has('0Y\n0N')
press('A');buy()
record=[int(v) for v in g.saved['paper_v2'].split(',')]
assert len(record)==14 and record[2:8]==[2,3,4,5,6,7]

# Existing six-market balances are not reduced by the new welcome grant.
g.saved['paper_v2']='1,1000000,'+','.join(['0']*12);before_writes=g.writes;g.fresh()
has('10000.00');assert g.writes==before_writes

# Username survives trading and reopening, with no idle persistence writes.
has('@bowen');assert g.saved['username_v1']=='bowen'

# Renaming saves durably, preserves the wallet, and returns to Account.
wallet_before=g.saved['paper_v2'];settings_item(3);press('A','B','UP','RIGHT','RIGHT','A')
has('@bowe');assert g.saved['username_v1']=='bowe'
g.on_exit();g.fresh();has('@bowe');assert g.saved['paper_v2']==wallet_before
