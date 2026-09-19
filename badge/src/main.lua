local markets = {
__MARKETS__
}
local C = {bg=0xc5d99b, panel=0x91ad65, text=0x1c3524,
  muted=0x4f6b3e, yes=0x1c3524, no=0x1c3524, gold=0x1c3524}
local visible={}
for i,m in ipairs(markets) do if not m[5] then visible[#visible+1]=i end end
local function slot(index)
  for j,i in ipairs(visible) do if i==index then return j end end
  return 1
end
local page, selected, side, action, quantity = "list", 1, 1, 1, 1
local portfolioIndex = 1
local cash, positions, histories = 1000000, {}, {}
local labels, balance, header, mark, chart, track, dot, midline
local settingsIndex, returnPage, field = 1, "list", 1
local lastGC=0
local initialized, pulseUntil = false, 0
local pending, receipt, note = nil, "", ""

local function money(n) return string.format("%.2f", n / 100) end
local function prob(i)
  local m, p = markets[i], positions[i]
  return 100 / (1 + math.exp(-(m[3]+p[1]-m[4]-p[2])/40))
end
local function cost(y,n)
  return 10000 * (math.max(y,n) + 40*math.log(1+math.exp(-math.abs(y-n)/40)))
end
local function quote()
  local m, p = markets[selected], positions[selected]
  if m[5] then return nil, "Live order book required" end
  if action == -1 and p[side] < quantity then return nil, "Not enough shares to sell" end
  if action == 1 and p[side]+quantity > 999 then return nil, "Position limit: 999 per side" end
  local y,n = m[3]+p[1], m[4]+p[2]
  local y2,n2 = y,n
  if side == 1 then y2=y+action*quantity else n2=n+action*quantity end
  local delta = cost(y2,n2)-cost(y,n)
  local amount = action == 1 and math.ceil(delta-0.000001) or math.floor(-delta+0.000001)
  if action == 1 and amount > cash then return nil, "Not enough paper feathers" end
  return math.max(0,amount)
end
local function wrap(s,limit)
  local line,out="",""
  for word in string.gmatch(s,"%S+") do
    if #line+#word+1 > limit and line~="" then out=out..line.."\n"; line=word
    else line=line=="" and word or line.." "..word end
  end
  return out..line
end
local function text(i,s,x,y,w,size,color,align)
  local l=labels[i]
  l:set_pos(x,y); l:set_size(w,240-y)
  l:style({text_font=size,text_color=color or C.text,text_align=align or "left"})
  l:set_text(s)
end
local function focus(x,y,w,h)
  mark:set_pos(x,y); mark:set_size(w,h); mark:hidden(false)
end
local function lights()
  badge.led.clear()
  if pulseUntil > badge.sys.ms() then badge.led.set_all(35,110,30)
  elseif page=="ticket" or page=="review" then
    if side==1 then
      badge.led.set(1,35,100,25); badge.led.set(6,35,100,25); badge.led.set(5,35,100,25)
    else
      badge.led.set(2,100,75,20); badge.led.set(3,100,75,20); badge.led.set(4,100,75,20)
    end
  else
    badge.led.set(1,12,35,8); badge.led.set(2,12,35,8)
  end
  badge.led.show()
end
local function render()
  for i=1,#labels do labels[i]:set_text("") end
  mark:hidden(true); chart:hidden(true); track:hidden(true); dot:hidden(true); midline:hidden(true)
  balance:set_text(money(cash))
  local m,p=markets[selected],positions[selected]
  local names={list="Markets",detail="Market",ticket="Trade",review="Review",portfolio="Portfolio",account="Account",link="Link account",settings="Settings",receipt="Saved"}
  header:set_text(names[page])
  if page=="list" or page=="portfolio" then
    local idx=page=="list" and selected or portfolioIndex
    local first=math.floor((slot(idx)-1)/3)*3+1
    for row=0,2 do
      local i=visible[first+row]
      if i then
        local y=40+row*65
        text(3+row,wrap(markets[i][2],29),18,y,239,14)
        local value=page=="portfolio" and (positions[i][1].."Y\n"..positions[i][2].."N") or string.format("%.0f%%",prob(i))
        text(6+row,value,265,y+8,44,14,C.text,"right")
        if i==idx then focus(7,y-4,307,61) end
      end
    end
  elseif page=="detail" then
    text(1,wrap(m[2],39),10,36,300,14)
    local h=histories[selected]
    local current=h[#h][1]
    local span=h[#h][2]-h[1][2]
    text(2,string.format("%.1f%%",current),222,87,88,24,C.text,"right")
    text(3,(#h>1 and string.format("%+.1f pts",current-h[1][1]) or "-- pts").."\n"..(#h>1 and (math.floor(span/1000).."s shown") or "1 price"),220,122,90,14,C.muted,"right")
    track:set_pos(10,86); track:set_size(178,97); track:hidden(false)
    midline:hidden(false)
    text(4,"100",190,85,28,14,C.muted)
    text(5,"50",190,128,28,14,C.muted)
    text(6,"0",190,168,28,14,C.muted)
    chart:set_pos(14,90)
    local pts={}
    for j=1,#h do
      local x=#h==1 and 0 or (span>0 and (h[j][2]-h[1][2])/span or (j-1)/(#h-1))
      pts[j]={math.floor(x*170),math.floor(88-h[j][1]*0.88)}
    end
    if #h>1 then chart:set_points(pts); chart:hidden(false) end
    dot:set_pos(13+pts[#pts][1],89+pts[#pts][2]); dot:hidden(false)
    text(7,"Vol --",10,186,104,14,C.muted)
    text(8,"Closes --",122,186,188,14,C.muted,"right")
    focus(side==1 and 7 or 164,207,149,28)
    text(9,string.format("YES  %.0f%%",current),18,212,132,16)
    text(10,string.format("NO  %.0f%%",100-current),176,212,132,16)
  elseif page=="ticket" or page=="review" then
    text(1,wrap(m[2],39),10,36,300,14)
    local amount,err=quote()
    if page=="ticket" then
      focus(7,91+(field-1)*29,307,27)
      text(2,"Order",18,97,90,16)
      text(3,action==1 and "< Buy >" or "< Sell >",126,97,177,16,C.text,"right")
      text(4,"Outcome",18,126,100,16)
      text(5,side==1 and "< YES >" or "< NO >",126,126,177,16,C.text,"right")
      text(6,"Shares",18,155,100,16)
      text(7,"< "..quantity.." >",126,155,177,16,C.text,"right")
      text(8,"Review order",18,184,285,16)
      text(9,wrap(note~="" and note or (amount and ((action==1 and "Cost " or "Receive ")..money(amount)) or err),40),10,214,300,14,C.muted)
    else
      text(2,(action==1 and "Buy " or "Sell ")..quantity..(side==1 and " YES shares" or " NO shares"),10,102,300,20)
      text(3,amount and ((action==1 and "Cost " or "Receive ")..money(amount)) or err,10,137,300,16)
      text(4,"Practice order / saved on this badge",10,175,300,14,C.muted)
      focus(7,204,307,31); text(5,"Confirm order",18,211,285,16)
    end
  elseif page=="settings" then
    local options={"Return to market","Portfolio","Account"}
    for i=1,3 do text(i,options[i],18,54+(i-1)*46,285,18) end
    focus(7,47+(settingsIndex-1)*46,307,39)
    text(5,"Practice mode / cloud offline",10,211,300,14,C.muted)
  elseif page=="account" then
    text(1,wrap(badge.me.name() or "Badge owner",30),10,42,300,20)
    text(2,"Badge ID",10,108,300,14,C.muted)
    text(3,wrap(badge.me.badge_id() or "Not provisioned",36),10,131,300,14)
    text(4,"Practice wallet / not linked",10,177,300,14,C.muted)
    focus(7,204,307,31); text(5,"Link account",18,211,285,16)
  elseif page=="link" then
    text(1,"Your Socials email",10,45,300,20)
    text(2,wrap("Account linking is not available on this badge yet.",36),10,87,300,16)
    text(3,wrap("Your practice balance and shares stay saved here.",36),10,149,300,16)
  else
    text(1,"Order saved",10,44,300,24)
    text(2,wrap(receipt,36),10,89,300,16)
    text(3,wrap(m[2],37),10,136,300,14)
    focus(7,204,307,31); text(4,"Back to market",18,211,285,16)
  end
  lights()
end
local function commit()
  if not pending then return end
  local amount,err=quote()
  if not amount or amount~=pending then note=err or "Quote changed - review again"; page="ticket"; render(); return end
  local nextcash=cash-action*amount
  local parts={"1",tostring(nextcash)}
  for i=1,#markets do
    for s=1,2 do
      local v=positions[i][s]
      if i==selected and s==side then v=v+action*quantity end
      parts[#parts+1]=tostring(v)
    end
  end
  local data=table.concat(parts,",")
  badge.store.set_str("paper_v2",data)
  if badge.store.get_str("paper_v2","")~=data then
    note="Save failed - no trade applied"; page="ticket"; pending=nil; render(); return
  end
  cash=nextcash; positions[selected][side]=positions[selected][side]+action*quantity
  local h=histories[selected]; h[#h+1]={prob(selected),badge.sys.ms()}
  if #h>12 then table.remove(h,1) end
  receipt=(action==1 and "Bought " or "Sold ")..quantity..(side==1 and " YES / " or " NO / ")..money(amount)
  pending=nil; page="receipt"; pulseUntil=badge.sys.ms()+650
  render()
end

function on_enter(root)
  badge.sys.gc_step()
  page,selected,side,action,quantity="list",1,1,1,1
  portfolioIndex=1; pulseUntil=0; settingsIndex=1; field=1; lastGC=0; returnPage="list"
  cash=1000000; positions={}; histories={}; labels={}; note=""; pending=nil
  for i=1,#markets do positions[i]={0,0} end
  local data=badge.store.get_str("paper_v2","")
  local vals={}
  for v in string.gmatch(data,"[^,]+") do vals[#vals+1]=tonumber(v) or -1 end
  if table.concat(vals,",")==data and (#vals==8 or #vals==2+2*#markets) and vals[1]==1 and vals[2]>=0 and vals[2]<=100000000 and vals[2]%1==0 then
    local valid=true
    for j=3,#vals do if vals[j]<0 or vals[j]>999 or vals[j]%1~=0 then valid=false end end
    if valid then
      cash=vals[2]
      for i=1,(#vals-2)/2 do positions[i]={vals[2*i+1],vals[2*i+2]} end
    end
  end
  for i=1,#markets do histories[i]={{prob(i),badge.sys.ms()}} end
  local bg=badge.ui.box(root,320,240)
  bg:set_pos(0,0); bg:style({bg_color=C.bg,border_width=0,pad_all=0,radius=0})
  local function box(x,y,w,h,color)
    local b=badge.ui.box(root,w,h); b:set_pos(x,y)
    b:style({bg_color=color,border_width=0,pad_all=0,radius=0}); return b
  end
  box(10,29,300,1,C.panel)
  mark=box(7,47,307,58,C.panel)
  mark:style({border_width=1,border_color=C.text,radius=3})
  header=badge.ui.label(root,""); header:set_pos(10,7); header:set_size(138,22)
  header:style({text_font=18,text_color=C.text})
  balance=badge.ui.label(root,""); balance:set_pos(149,9); balance:set_size(161,20)
  balance:style({text_font=16,text_color=C.text,text_align="right"})
  track=badge.ui.box(root,274,48); track:set_pos(23,120)
  track:style({bg_color=C.panel,border_width=0,pad_all=0,radius=0})
  midline=box(10,134,178,1,C.muted)
  dot=box(0,0,3,3,C.text)
  chart=badge.ui.line(root,{{0,0},{1,0}}); chart:set_pos(30,120)
  chart:style({line_color=C.yes,line_width=2})
  for i=1,10 do labels[i]=badge.ui.label(root,"") end
  initialized=true; render()
end

function on_button(button,kind)
  if not initialized or kind~=badge.input.KIND.PRESSED then return end
  local B=badge.input.BUTTON
  note=""
  if button==B.START then
    if page=="settings" then page=returnPage
    else returnPage=page; page="settings"; settingsIndex=1 end
  elseif page=="settings" then
    if button==B.UP then settingsIndex=(settingsIndex-2)%3+1
    elseif button==B.DOWN then settingsIndex=settingsIndex%3+1
    elseif button==B.B then page=returnPage
    elseif button==B.A then
      if settingsIndex==1 then page=returnPage
      elseif settingsIndex==2 then page="portfolio"; portfolioIndex=selected
      else page="account" end
    else return end
  elseif page=="list" or page=="portfolio" then
    local idx=page=="list" and selected or portfolioIndex
    if button==B.UP then idx=visible[(slot(idx)-2)%#visible+1]
    elseif button==B.DOWN then idx=visible[slot(idx)%#visible+1]
    elseif button==B.A then selected=idx; side=1; page="detail"
    elseif button==B.B and page=="portfolio" then page="settings"
    else return end
    if page=="list" then selected=idx elseif page=="portfolio" then portfolioIndex=idx end
  elseif page=="detail" then
    if button==B.LEFT then side=1
    elseif button==B.RIGHT then side=2
    elseif button==B.B then page="list"
    elseif button==B.A then
      if markets[selected][5] then note="View only / live order book unavailable"
      else page="ticket"; action=1; quantity=1; field=1 end
    else return end
  elseif page=="ticket" then
    if button==B.UP then field=(field-2)%4+1
    elseif button==B.DOWN then field=field%4+1
    elseif button==B.LEFT or button==B.RIGHT then
      if field==1 then action=-action
      elseif field==2 then side=3-side
      elseif field==3 then quantity=math.max(1,math.min(20,quantity+(button==B.RIGHT and 1 or -1))) end
    elseif button==B.B then page="detail"
    elseif button==B.A then
      if field<4 then field=field+1
      else
        local amount,err=quote()
        if amount then pending=amount; page="review" else note=err end
      end
    else return end
  elseif page=="account" then
    if button==B.B then page="settings"
    elseif button==B.A then page="link" else return end
  elseif page=="link" then
    if button==B.B then page="account" else return end
  elseif page=="review" then
    if button==B.A then commit(); return
    elseif button==B.B then pending=nil; page="ticket"
    else return end
  elseif button==B.A or button==B.B then page="detail"
  else return end
  render()
end

function on_tick()
  if not initialized then return end
  local now=badge.sys.ms()
  if now-lastGC>=600 then badge.sys.gc_step(); lastGC=now end
  if pulseUntil>0 and now>=pulseUntil then pulseUntil=0; lights() end
end

function on_exit()
  initialized=false
  badge.led.clear(); badge.led.show()
end
