local cloud={markets={},capturedAt="",rangeStart=nil,rangeEnd=nil}
__CLOUD_READER__
local readDetailFrame=require("detail_reader")
local trade,qr,uiRoot,pendingCloud,refreshSlug
local C={bg=0xc5d99b,panel=0x91ad65,text=0x1c3524,muted=0x4f6b3e,up=0x267a35,down=0xa23d2b}
local page,selected,side,setting="list",1,1,1
local labels,header,status,stamp,mark,chart,track,dot,midline,listCharts
local lastRead,lastRx,lastGC=0,nil,0
local detail,detailGeneration
local initialized=false
local function wrap(s,limit)
  local line,out="",""
  for word in s:gmatch("%S+") do
    if #line+#word+1>limit and line~="" then out=out..line.."\n";line=word
    else line=line=="" and word or line.." "..word end
  end
  return out..line
end
local function wrapCard(s,limit)
  limit=limit or 22
  local lines={"",""}
  local current=1
  local overflow=false
  for word in s:gmatch("%S+") do
    if #word>limit then word=word:sub(1,limit-3).."..." end
    local candidate=lines[current]=="" and word or lines[current].." "..word
    if #candidate<=limit then lines[current]=candidate
    elseif current==1 then current=2;lines[current]=word
    else overflow=true;break end
  end
  if overflow then
    while #lines[2]>limit-3 do lines[2]=lines[2]:match("^(.*)%s+%S+$") or lines[2]:sub(1,limit-3) end
    lines[2]=lines[2].."..."
  end
  return lines[2]=="" and lines[1] or lines[1].."\n"..lines[2]
end
local function text(i,s,x,y,w,size,align,color)
  local l=labels[i]
  l:set_pos(x,y);l:set_size(w,240-y)
  l:style({text_font=size,text_color=color or C.text,text_align=align or "left"})
  l:set_text(s)
end
local function accountSummary(user,balance)
  if #user>11 then user=user:sub(1,10).."~" end
  return user.." · "..balance
end
local function drawListChart(slot,item,y)
  local line=listCharts[slot]
  local h=item.history or {}
  if #h<2 then return end
  local low,high=100,0
  for j=1,#h do low=math.min(low,h[j][1]);high=math.max(high,h[j][1]) end
  local span=math.min(100,math.max(10,high-low+4))
  local domainLow=math.max(0,math.min(100-span,(low+high-span)/2))
  local domainHigh=domainLow+span
  local first=cloud.rangeStart or h[1][2]
  local last=cloud.rangeEnd or h[#h][2]
  if last<=first then return end
  local pts={}
  for j=1,#h do
    local x=math.floor(math.max(0,math.min(1,(h[j][2]-first)/(last-first)))*58)
    pts[#pts+1]={x,math.floor((domainHigh-h[j][1])/span*28)}
  end
  line:set_points(pts);line:set_pos(180,y+16)
  line:style({line_color=(item.changeBps or 0)<0 and C.down or C.up,line_width=2})
  line:hidden(false)
end
local function focus(x,y,w,h)
  mark:set_pos(x,y);mark:set_size(w,h);mark:hidden(false)
end
local function requestDetail()
  detail=nil;detailGeneration=nil
  local m=cloud.markets[selected]
  if m then badge.fs.write("appdata/detail_request.txt","GD1\t"..m.slug.."\n") end
end
local function refreshDetail()
  local m=cloud.markets[selected]
  if not m then return false end
  local data=badge.fs.read("appdata/detail_history.txt")
  if type(data)~="string" then return false end
  local generation=data:match("^GH1\t(%d+)\t")
  if not generation or generation==detailGeneration then return false end
  local nextDetail=readDetailFrame(data)
  if not nextDetail or nextDetail.slug~=m.slug then return false end
  detail=nextDetail;detailGeneration=generation
  return true
end
local function refresh(initial)
  if not pendingCloud then
    if cloud.generation then
      local generation=badge.fs.read("appdata/market_generation.txt")
      if not generation or not generation:match("^%d+$") or generation==cloud.generation then return false end
      refreshSlug=cloud.markets[selected] and cloud.markets[selected].slug
      cloud={markets={},capturedAt="",rangeStart=nil,rangeEnd=nil}
      return true
    end
    local data=badge.fs.read("appdata/market_snapshot.txt")
    if type(data)=="string" and cloud.generation and data:match("^GS[12]\t(%d+)\t")==cloud.generation then return false end
    pendingCloud=readCloudFrame(data,true)
    return false
  end
  local nextCloud=pendingCloud()
  if nextCloud==false then return false end
  pendingCloud=nil
  if not nextCloud or nextCloud.generation==cloud.generation then return false end
  if cloud.generation and (#nextCloud.generation<#cloud.generation or (#nextCloud.generation==#cloud.generation and nextCloud.generation<cloud.generation)) then return false end
  local slug=refreshSlug or (cloud.markets[selected] and cloud.markets[selected].slug)
  refreshSlug=nil
  cloud=nextCloud;selected=1
  for i,m in ipairs(cloud.markets) do if m.slug==slug then selected=i end end
  if not initial then lastRx=badge.sys.ms() end
  return true
end
local function render()
  for i=1,#labels do labels[i]:set_text("") end
  mark:hidden(true);chart:hidden(true);track:hidden(true);dot:hidden(true);midline:hidden(true)
  for i=1,#listCharts do listCharts[i]:hidden(true) end
  if qr then qr:hidden(true) end
  header:set_pos(10,7);header:set_size(78,22)
  status:set_pos(88,7);status:set_size(222,18)
  stamp:set_pos(149,16);stamp:set_size(161,17)
  header:set_text(({list="Markets",detail="Market",settings="Settings",link="Account"})[page])
  status:set_text(lastRx and badge.sys.ms()-lastRx<45000 and "USB Updated" or "Saved Snapshot")
  stamp:set_text(cloud.capturedAt)
  if trade then
    local user,balance,offline=trade.header()
    if page=="link" and offline then header:set_size(125,22);status:set_pos(135,1);status:set_size(175,17);header:set_text(user);status:set_text(balance);stamp:set_text("")
    elseif offline then status:set_text(user);stamp:set_text("")
    else status:set_text(accountSummary(user,balance));stamp:set_text("") end
  end
  if page=="link" and trade.pairing_challenge() then header:set_text("Sign In");status:set_text("");stamp:set_text("") end
  local m=cloud.markets[selected]
  if not m and (page=="list" or page=="detail") then
    text(1,"Loading Markets",10,70,300,20);return
  end
  if page=="list" then
    local first=math.floor((selected-1)/3)*3+1
    for row=0,2 do
      local i=first+row
      local item=cloud.markets[i]
      if item then
        local y=40+row*65
        local base=row*2
        text(base+1,wrapCard(item.shortTitle or item.title),15,y+10,160,14)
        text(base+2,string.format("%.0f%%",item.probability),244,y+18,66,22,"right")
        drawListChart(row+1,item,y)
        if selected==i then focus(5,y-4,310,61) end
      end
    end
  elseif page=="detail" then
    local detailTitle=wrapCard(m.title,34)
    local titleLines=detailTitle:find("\n",1,true) and 2 or 1
    text(1,detailTitle,10,36,300,16)
    local h=detail and detail.slug==m.slug and detail.history or {}
    local change=#h>1 and h[#h][1]-h[1][1] or nil
    local changeText=change and string.format("%+.0f pts | Past 4 Hours",change)
      or not detail and "Loading 4H History..."
      or #h==1 and "1 Price | Past 4 Hours" or "No History | Past 4 Hours"
    text(3,changeText,10,36+titleLines*18,190,14,"left",change and (change<0 and C.down or C.up) or C.muted)
    text(2,string.format("%.0f%%",m.probability),212,100,98,24,"right")
    text(7,"Vol "..m.volume,212,139,98,14,"right")
    track:hidden(false);midline:hidden(false)
    local low,high=100,0
    for j=1,#h do low=math.min(low,h[j][1]);high=math.max(high,h[j][1]) end
    local domainSpan=math.min(100,math.max(10,high-low+4))
    local domainLow=math.max(0,math.min(100-domainSpan,(low+high-domainSpan)/2))
    local domainHigh=domainLow+domainSpan
    text(4,string.format("%.0f%%",domainHigh),7,85,36,14,"right")
    text(5,string.format("%.0f%%",(domainHigh+domainLow)/2),7,128,36,14,"right")
    text(6,string.format("%.0f%%",domainLow),7,168,36,14,"right")
    local pts={}
    for j=1,#h do
      local x=math.max(0,math.min(1,(h[j][2]-detail.startAt)/(detail.endAt-detail.startAt)))
      pts[#pts+1]={math.floor(x*132),math.floor((domainHigh-h[j][1])/domainSpan*88)}
    end
    if #pts>0 and pts[#pts][1]<132 then pts[#pts+1]={132,pts[#pts][2]} end
    chart:set_pos(52,90);chart:style({line_color=C.text,line_width=2})
    if #pts>1 then chart:set_points(pts);chart:hidden(false) end
    if #pts>0 then dot:set_pos(51+pts[#pts][1],89+pts[#pts][2]);dot:hidden(false)
    end
    local state=m.status:sub(1,1)..m.status:sub(2):lower()
    text(8,"["..state.."]",10,186,90,14,"left",m.status=="OPEN" and C.up or C.muted)
    stamp:set_pos(100,186);stamp:set_size(210,17);stamp:set_text("Closes "..m.closes)
    focus(side==1 and 7 or 164,207,149,28)
    text(9,string.format("YES  %.0f%%",m.probability),18,212,132,16)
    text(10,string.format("NO  %.0f%%",100-m.probability),176,212,132,16)
  elseif page=="settings" then
    local options={"Return to Markets","Account Info"}
    for i=1,2 do text(i,options[i],18,54+(i-1)*46,285,18) end
    focus(7,47+(setting-1)*46,307,39)
    text(5,"USB Account and Market Sync",10,211,300,14)
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
  uiRoot=root;qr=nil;pendingCloud=nil;refreshSlug=nil;detail=nil;detailGeneration=nil
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
  mark=box(5,36,310,61,C.panel);mark:style({border_width=1,border_color=C.text,radius=3})
  header=badge.ui.label(root,"");header:set_pos(10,7);header:set_size(78,22)
  header:style({text_font=18,text_color=C.text})
  status=badge.ui.label(root,"");status:set_pos(88,7);status:set_size(222,18)
  status:style({text_font=14,text_color=C.text,text_align="right"})
  stamp=badge.ui.label(root,"");stamp:set_pos(149,16);stamp:set_size(161,17)
  stamp:style({text_font=14,text_color=C.text,text_align="right"})
  track=box(48,86,140,97,C.panel);midline=box(48,134,140,1,C.muted);dot=box(0,0,3,3,C.text)
  chart=badge.ui.line(root,{{0,0},{1,0}});chart:set_pos(52,90)
  chart:style({line_color=C.text,line_width=2})
  listCharts={chart}
  for i=2,3 do listCharts[i]=badge.ui.line(root,{{0,0},{1,0}});listCharts[i]:hidden(true) end
  labels={};for i=1,10 do labels[i]=badge.ui.label(root,"") end
  badge.led.clear();badge.led.show()
  if not trade.name then page="link" end
  initialized=true;render()
end
function on_button(button,kind)
  if not initialized or kind~=badge.input.KIND.PRESSED then return end
  local B=badge.input.BUTTON
  if #cloud.markets==0 and page~="link" and page~="settings" and button~=B.START and button~=B.B then return end
  if page=="link" and trade.phase=="account" and trade.name and button==B.A then
    page="list"
  elseif page=="link" then
    if trade.button(button) then page=trade.slug and "detail" or "list" end
  elseif button==B.START then page=page=="settings" and "list" or "settings";setting=1
  elseif page=="list" then
    if button==B.UP then selected=(selected-2)%#cloud.markets+1
    elseif button==B.DOWN then selected=selected%#cloud.markets+1
    elseif button==B.A then page="detail";side=1;requestDetail() else return end
  elseif page=="detail" then
    if button==B.LEFT then side=1 elseif button==B.RIGHT then side=2
    elseif button==B.B then page="list";detail=nil;detailGeneration=nil;badge.sys.gc_step()
    elseif button==B.A then page="link";local m=cloud.markets[selected];trade.open(m.slug,side==1 and "YES" or "NO",m.title) else return end
  elseif page=="settings" then
    if button==B.UP then setting=(setting-2)%2+1 elseif button==B.DOWN then setting=setting%2+1
    elseif button==B.B then page="list"
    elseif button==B.A then
      if setting==1 then page="list"
      else page="link";trade.phase="account";trade.slug=nil end
    else return end
  elseif button==B.B then page="list" else return end
  render()
end
function on_tick()
  if not initialized then return end
  local now=badge.sys.ms()
  if pendingCloud then
    badge.sys.gc_step()
    if refresh(false) then render() end
    return
  end
  if now-lastGC>=600 then badge.sys.gc_step();lastGC=now end
  if now-lastRead>=2000 then
    lastRead=now
    local changed=trade.tick()
    badge.sys.gc_step()
    if trade.name or page~="link" then if refresh(false) then changed=true end end
    if page=="detail" and refreshDetail() then changed=true end
    if lastRx and now-lastRx>=45000 then lastRx=nil;changed=true end
    if changed then badge.sys.gc_step();render() end
  end
end
function on_exit()
  initialized=false;badge.led.clear();badge.led.show()
end
