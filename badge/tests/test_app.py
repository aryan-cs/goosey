from pathlib import Path
from lupa.lua54 import LuaRuntime

root = Path(__file__).resolve().parents[2]
import os
output = Path(os.environ.get('BADGE_OUTPUT', root / 'badge/dist'))
code = (output / 'main.lua').read_text()
lua = LuaRuntime(unpack_returned_tuples=True)
lua.execute('''
widgets={}; saved={}; writes=0; clock=0; leds={}; fail_save=false
local methods={}
function methods:set_pos(x,y) assert(x%1==0 and y%1==0); self.x=x; self.y=y end
function methods:set_size(w,h) assert(w%1==0 and h%1==0); self.w=w; self.h=h end
function methods:style(s) for k,v in pairs(s) do self.styles[k]=v end end
function methods:set_text(s) assert(type(s)=="string" and #s<=1024); self.text=s end
function methods:hidden(v) self.hide=v end
function methods:set_points(p)
  assert(#p>=2 and #p<=128)
  for _,xy in ipairs(p) do assert(xy[1]%1==0 and xy[2]%1==0) end
  self.points=p
end
local function widget(kind)
  local w=setmetatable({kind=kind,x=0,y=0,text="",styles={},hide=false},{__index=methods})
  widgets[#widgets+1]=w; return w
end
badge={
 ui={box=function(_,w,h) local t=widget("box");t.w=w;t.h=h;return t end,
 label=function(_,s) local t=widget("label");t.text=s;return t end,
 line=function(_,p) local t=widget("line");t.points=p;return t end},
 input={BUTTON={A=1,B=2,HOME=3,DOWN=4,LEFT=5,RIGHT=6,UP=7,AUX1=8,START=9},KIND={PRESSED=1,RELEASED=2}},
 led={clear=function() leds={} end,set=function(i,r,g,b) leds[i]={r,g,b} end,
 set_all=function(r,g,b) for i=1,6 do leds[i]={r,g,b} end end,show=function() end},
 me={name=function() return "Bowen" end,badge_id=function() return "TEST-BADGE-001" end},
 sys={ms=function() return clock end,gc_step=function() end},
 store={get_str=function(k,d) return saved[k] or d end,
 set_str=function(k,v) assert(#v<=128); if not fail_save then saved[k]=v;writes=writes+1 end end}}
function press(k) on_button(badge.input.BUTTON[k],1) end
function visible()
 local t={}; for _,w in ipairs(widgets) do if not w.hide and w.text~="" then t[#t+1]=w.text end end
 return table.concat(t,"\\n")
end
function fresh() widgets={};on_enter({}) end
''')
lua.execute(code)
g=lua.globals()
def press(*keys):
    for k in keys:g.press(k)
def has(text):assert text in g.visible(), (text,g.visible())
def snapshot(name):
    render(g.widgets, output / f'{name}.png')

def render(widgets,path):
    from PIL import Image, ImageDraw, ImageFont
    im=Image.new('RGB',(320,240)); d=ImageDraw.Draw(im)
    def rgb(n):return ((int(n)>>16)&255,(int(n)>>8)&255,int(n)&255)
    fontpath=os.environ.get('BADGE_TEST_FONT','/System/Library/Fonts/Supplemental/Arial.ttf')
    for w in widgets.values():
        if w.hide:continue
        s=w.styles;x=int(w.x);y=int(w.y)
        if w.kind=='box':
            d.rectangle((x,y,x+int(w.w)-1,y+int(w.h)-1),fill=rgb(s.bg_color or 0),outline=rgb(s.border_color or s.bg_color or 0),width=int(s.border_width or 1))
        elif w.kind=='line':
            d.line([(x+int(p[1]),y+int(p[2])) for p in w.points.values()],fill=rgb(s.line_color),width=2)
        elif w.text:
            font=ImageFont.truetype(fontpath,int(s.text_font or 14))
            for j,line in enumerate(w.text.split('\n')):
                # Conservative horizontal bound; actual LVGL fonts still require hardware QA.
                assert d.textlength(line,font=font)<=int(w.w)+1,(path.name,line,d.textlength(line,font=font),w.w)
                assert y+j*(int(s.text_font or 14)+2)+int(s.text_font or 14)<=240
                dx=int(w.w)-d.textlength(line,font=font) if s.text_align=='right' else 0
                d.text((x+dx,y+j*(int(s.text_font or 14)+2)),line,font=font,fill=rgb(s.text_color or 0xffffff))
    im.resize((640,480)).save(path)

def review():press('A','A','A','A')
def buy():press('A');review();press('A')
def settings_item(n):
    press('START')
    for _ in range(n-1):press('DOWN')
    press('A')

g.fresh();has('1000.00');snapshot('01-markets')
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
press('A');has('not available');snapshot('09-linking')
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
