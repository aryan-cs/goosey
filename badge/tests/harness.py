from pathlib import Path
from lupa.lua54 import LuaRuntime

root = Path(__file__).resolve().parents[2]
import os
output = Path(os.environ.get('BADGE_OUTPUT', root / 'badge/dist'))
code = (output / 'main.lua').read_text()
lua = LuaRuntime(unpack_returned_tuples=True)
lua.execute('''
widgets={}; saved={}; writes=0; clock=0; leds={}; fail_save=false; mailbox=nil
local methods={}
function methods:set_pos(x,y) assert(x%1==0 and y%1==0); self.x=x; self.y=y end
function methods:set_size(w,h) assert(w%1==0 and h%1==0); self.w=w; self.h=h end
function methods:style(s) if s.text_font then assert(({[14]=true,[16]=true,[18]=true,[20]=true,[22]=true,[24]=true})[s.text_font], "Unsupported badge font") end; for k,v in pairs(s) do self.styles[k]=v end end
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
 fs={read=function() return mailbox end},
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
