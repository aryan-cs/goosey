local cloud={markets={},capturedAt=""}
__CLOUD_READER__
local trade,qr,uiRoot
local C={bg=0xc5d99b,panel=0x91ad65,text=0x1c3524,muted=0x4f6b3e}
local page,selected,side,setting="list",1,1,1
local labels,header,status,stamp,mark,chart,track,dot,midline
local lastRead,lastRx,lastGC=0,nil,0
local initialized=false
local function wrap(s,limit)
  local line,out="",""
  for word in s:gmatch("%S+") do
    if #line+#word+1>limit and line~="" then out=out..line.."\n";line=word
    else line=line=="" and word or line.." "..word end
  end
  return out..line
end
local function text(i,s,x,y,w,size,align)
  local l=labels[i]
  l:set_pos(x,y);l:set_size(w,240-y)
  l:style({text_font=size,text_color=C.text,text_align=align or "left"})
  l:set_text(s)
end
local function focus(x,y,w,h)
  mark:set_pos(x,y);mark:set_size(w,h);mark:hidden(false)
end
local function refresh(initial)
  badge.sys.gc_step()
  local data=badge.fs.read("appdata/market_snapshot.txt")
  if type(data)=="string" and cloud.generation and data:match("^GS1\t(%d+)\t")==cloud.generation then return false end
  local nextCloud=readCloudFrame(data)
  if not nextCloud or nextCloud.generation==cloud.generation then return false end
  if cloud.generation and (#nextCloud.generation<#cloud.generation or (#nextCloud.generation==#cloud.generation and nextCloud.generation<cloud.generation)) then return false end
  local slug=cloud.markets[selected] and cloud.markets[selected].slug
  cloud=nextCloud;selected=1
  for i,m in ipairs(cloud.markets) do if m.slug==slug then selected=i end end
  if not initial then lastRx=badge.sys.ms() end
  return true
end
local function render()
  for i=1,#labels do labels[i]:set_text("") end
  mark:hidden(true);chart:hidden(true);track:hidden(true);dot:hidden(true);midline:hidden(true)
  if qr then qr:hidden(true) end
  header:set_text(({list="Markets",detail="Market",settings="Settings",link="Account"})[page])
  status:set_text(lastRx and badge.sys.ms()-lastRx<45000 and "USB updated" or "Saved snapshot")
  stamp:set_text(cloud.capturedAt)
  if trade then local user,balance=trade.header();status:set_text(user);stamp:set_text(balance) end
  if page=="link" and trade.pairing_challenge() then header:set_text("Sign in");status:set_text("");stamp:set_text("") end
  local m=cloud.markets[selected]
  if not m and (page=="list" or page=="detail") then
    text(1,"Loading markets",10,70,300,20);return
  end
  if page=="list" then
    local first=math.floor((selected-1)/3)*3+1
    for row=0,2 do
      local i=first+row
      local item=cloud.markets[i]
      if item then
        local y=40+row*65
        text(row+1,wrap(item.title,29),18,y,239,14)
        text(row+4,string.format("%.0f%%",item.probability),265,y+8,44,14,"right")
        if selected==i then focus(7,y-4,307,61) end
      end
    end
  elseif page=="detail" then
    text(1,wrap(m.title,39),10,36,300,14)
    text(2,string.format("%.1f%%",m.probability),222,87,88,24,"right")
    local h=m.history
    text(3,(#h>1 and string.format("%+.1f pts",h[#h][1]-h[1][1]) or "-- pts").."\nPast day",220,122,90,14,"right")
    track:hidden(false);midline:hidden(false)
    text(4,"100",190,85,28,14);text(5,"50",190,128,28,14);text(6,"0",190,168,28,14)
    local span=#h>1 and h[#h][2]-h[1][2] or 0
    local pts={}
    for j=1,#h do
      local x=#h==1 and 0 or (span>0 and (h[j][2]-h[1][2])/span or (j-1)/(#h-1))
      pts[j]={math.floor(x*170),math.floor(88-h[j][1]*0.88)}
    end
    if #pts>1 then chart:set_points(pts);chart:hidden(false) end
    if #pts>0 then dot:set_pos(13+pts[#pts][1],89+pts[#pts][2]);dot:hidden(false)
    else text(3,"No history",220,122,90,14,"right") end
    text(7,"Vol "..m.volume,10,186,90,14)
    text(8,m.closes,100,186,210,14,"right")
    focus(side==1 and 7 or 164,207,149,28)
    text(9,string.format("YES  %.0f%%",m.probability),18,212,132,16)
    text(10,string.format("NO  %.0f%%",100-m.probability),176,212,132,16)
  elseif page=="settings" then
    local options={"Return to markets","Trade selected market","Linked account"}
    for i=1,3 do text(i,options[i],18,54+(i-1)*46,285,18) end
    focus(7,47+(setting-1)*46,307,39)
    text(5,"USB account and market sync",10,211,300,14)
  else
    local pair=trade.pairing_challenge()
    local hasQR=pair and badge.fs.read("appdata/qr_challenge.txt")==pair
    if hasQR then
      if not qr then qr=badge.ui.image(uiRoot,"pairing.bin");qr:set_pos(111,82) end
      qr:hidden(false)
    end
    trade.draw(text,wrap,hasQR)
  end
end
function on_enter(root)
  -- These bindings are unused by Goosey; free their Lua tables before loading data.
  badge.nfc=nil;badge.radio=nil;badge.contacts=nil;badge.sensor=nil
  uiRoot=root;qr=nil
  for i=1,32 do badge.sys.gc_step() end
  badge.sys.gc_step()
  page,selected,side,setting="list",1,1,1
  lastRead,lastRx,lastGC=0,nil,0
  badge.sys.gc_step()
  trade=require("trade");trade.init()
  badge.sys.gc_step()
  local function box(x,y,w,h,color)
    local b=badge.ui.box(root,w,h);b:set_pos(x,y)
    b:style({bg_color=color,border_width=0,pad_all=0,radius=0});return b
  end
  box(0,0,320,240,C.bg);box(10,34,300,1,C.panel)
  mark=box(7,47,307,58,C.panel);mark:style({border_width=1,border_color=C.text,radius=3})
  header=badge.ui.label(root,"");header:set_pos(10,7);header:set_size(110,22)
  header:style({text_font=18,text_color=C.text})
  status=badge.ui.label(root,"");status:set_pos(120,1);status:set_size(190,17)
  status:style({text_font=14,text_color=C.text,text_align="right"})
  stamp=badge.ui.label(root,"");stamp:set_pos(149,16);stamp:set_size(161,17)
  stamp:style({text_font=14,text_color=C.text,text_align="right"})
  track=box(10,86,178,97,C.panel);midline=box(10,134,178,1,C.muted);dot=box(0,0,3,3,C.text)
  chart=badge.ui.line(root,{{0,0},{1,0}});chart:set_pos(14,90)
  chart:style({line_color=C.text,line_width=2})
  labels={};for i=1,10 do labels[i]=badge.ui.label(root,"") end
  badge.led.clear();badge.led.show()
  if not trade.name then page="link" end
  initialized=true;render()
end
function on_button(button,kind)
  if not initialized or kind~=badge.input.KIND.PRESSED then return end
  local B=badge.input.BUTTON
  if #cloud.markets==0 and page~="link" and button~=B.START and button~=B.B then return end
  if page=="link" and trade.phase=="account" and trade.name and button==B.A then
    page="list"
  elseif page=="link" then
    if trade.button(button) then page="detail" end
  elseif button==B.START then page=page=="settings" and "list" or "settings";setting=1
  elseif page=="list" then
    if button==B.UP then selected=(selected-2)%#cloud.markets+1
    elseif button==B.DOWN then selected=selected%#cloud.markets+1
    elseif button==B.A then page="detail";side=1 else return end
  elseif page=="detail" then
    if button==B.LEFT then side=1 elseif button==B.RIGHT then side=2
    elseif button==B.B then page="list" elseif button==B.A then page="link";local m=cloud.markets[selected];trade.open(m.slug,side==1 and "YES" or "NO",m.title) else return end
  elseif page=="settings" then
    if button==B.UP then setting=(setting-2)%3+1 elseif button==B.DOWN then setting=setting%3+1
    elseif button==B.B then page="list" elseif button==B.A then page=setting==1 and "list" or "link";if page=="link" then local m=cloud.markets[selected];trade.open(m.slug,side==1 and "YES" or "NO",m.title);if setting==3 then trade.phase="account" end end else return end
  elseif button==B.B then page="list" else return end
  render()
end
function on_tick()
  if not initialized then return end
  local now=badge.sys.ms()
  if now-lastGC>=600 then badge.sys.gc_step();lastGC=now end
  if now-lastRead>=2000 then
    lastRead=now
    local changed=trade.tick()
    badge.sys.gc_step()
    if trade.name or page~="link" then if refresh(false) then changed=true end end
    if lastRx and now-lastRx>=45000 then lastRx=nil;changed=true end
    if changed then badge.sys.gc_step();render() end
  end
end
function on_exit()
  initialized=false;badge.led.clear();badge.led.show()
end
