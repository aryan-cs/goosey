local cloud=__CLOUD__
__CLOUD_READER__
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
  local data=badge.fs.read("appdata/market_snapshot.txt")
  if type(data)=="string" and cloud.generation and data:match("^GS1\t(%d+)\t")==cloud.generation then return false end
  local nextCloud=readCloudFrame(data)
  if not nextCloud or nextCloud.generation==cloud.generation then return false end
  if cloud.generation and (#nextCloud.generation<#cloud.generation or (#nextCloud.generation==#cloud.generation and nextCloud.generation<cloud.generation)) then return false end
  local slug=cloud.markets[selected].slug
  cloud=nextCloud;selected=1
  for i,m in ipairs(cloud.markets) do if m.slug==slug then selected=i end end
  if not initial then lastRx=badge.sys.ms() end
  return true
end
local function render()
  for i=1,#labels do labels[i]:set_text("") end
  mark:hidden(true);chart:hidden(true);track:hidden(true);dot:hidden(true);midline:hidden(true)
  header:set_text(({list="Markets",detail="Market",settings="Settings",link="Account"})[page])
  status:set_text(lastRx and badge.sys.ms()-lastRx<45000 and "USB updated" or "Saved snapshot")
  stamp:set_text(cloud.capturedAt)
  local m=cloud.markets[selected]
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
    local options={"Return to markets","Portfolio on website","Account on website"}
    for i=1,3 do text(i,options[i],18,54+(i-1)*46,285,18) end
    focus(7,47+(setting-1)*46,307,39)
    text(5,"USB market sync / website trading",10,211,300,14)
  else
    text(1,"getgoosey.vercel.app",10,45,300,20)
    text(2,wrap("Sign in on your phone to trade and see your balance.",34),10,85,300,16)
    text(3,wrap("Badge account linking is not connected yet. Only public prices sync over USB.",35),10,150,300,14)
  end
end
function on_enter(root)
  badge.sys.gc_step()
  page,selected,side,setting="list",1,1,1
  lastRead,lastRx,lastGC=0,nil,0
  refresh(true)
  local function box(x,y,w,h,color)
    local b=badge.ui.box(root,w,h);b:set_pos(x,y)
    b:style({bg_color=color,border_width=0,pad_all=0,radius=0});return b
  end
  box(0,0,320,240,C.bg);box(10,34,300,1,C.panel)
  mark=box(7,47,307,58,C.panel);mark:style({border_width=1,border_color=C.text,radius=3})
  header=badge.ui.label(root,"");header:set_pos(10,7);header:set_size(138,22)
  header:style({text_font=18,text_color=C.text})
  status=badge.ui.label(root,"");status:set_pos(149,1);status:set_size(161,17)
  status:style({text_font=14,text_color=C.text,text_align="right"})
  stamp=badge.ui.label(root,"");stamp:set_pos(149,16);stamp:set_size(161,17)
  stamp:style({text_font=14,text_color=C.text,text_align="right"})
  track=box(10,86,178,97,C.panel);midline=box(10,134,178,1,C.muted);dot=box(0,0,3,3,C.text)
  chart=badge.ui.line(root,{{0,0},{1,0}});chart:set_pos(14,90)
  chart:style({line_color=C.text,line_width=2})
  labels={};for i=1,10 do labels[i]=badge.ui.label(root,"") end
  badge.led.clear();badge.led.show()
  initialized=true;render()
end
function on_button(button,kind)
  if not initialized or kind~=badge.input.KIND.PRESSED then return end
  local B=badge.input.BUTTON
  if button==B.START then page=page=="settings" and "list" or "settings";setting=1
  elseif page=="list" then
    if button==B.UP then selected=(selected-2)%#cloud.markets+1
    elseif button==B.DOWN then selected=selected%#cloud.markets+1
    elseif button==B.A then page="detail";side=1 else return end
  elseif page=="detail" then
    if button==B.LEFT then side=1 elseif button==B.RIGHT then side=2
    elseif button==B.B then page="list" elseif button==B.A then page="link" else return end
  elseif page=="settings" then
    if button==B.UP then setting=(setting-2)%3+1 elseif button==B.DOWN then setting=setting%3+1
    elseif button==B.B then page="list" elseif button==B.A then page=setting==1 and "list" or "link" else return end
  elseif button==B.B then page="list" else return end
  render()
end
function on_tick()
  if not initialized then return end
  local now=badge.sys.ms()
  if now-lastGC>=600 then badge.sys.gc_step();lastGC=now end
  if now-lastRead>=2000 then
    lastRead=now
    local changed=refresh(false)
    if lastRx and now-lastRx>=45000 then lastRx=nil;changed=true end
    if changed then render() end
  end
end
function on_exit()
  initialized=false;badge.led.clear();badge.led.show()
end
