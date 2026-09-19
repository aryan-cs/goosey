-- USB account/trade state. No bearer key, password or local wallet is stored here.
local T={name=nil,balance=nil,phase="account",message="Connect USB gateway",qty=1,action="BUY"}
local accountState="UNKNOWN"
local sequence=0
local challenge,accountGen,lastRx,request,quoteId,bound,fee,deadline,started
local function fields(s,tag,n)
  if type(s)~="string" or #s>600 then return nil end
  local t={};for v in s:gmatch("[^\t\r\n]+") do t[#t+1]=v end
  if #t~=n or t[1]~=tag or t[n]~="END" then return nil end
  return t
end
local function save(path,s)
  badge.fs.write("appdata/"..path,s)
  return badge.fs.read("appdata/"..path)==s
end
local function money(s)
  local n=tonumber(s) or 0
  return string.format("%d.%03d",math.floor(n/1000),n%1000)
end
local function fresh()
  return T.name and lastRx and badge.sys.ms()-lastRx<35000
end
function T.init()
  local id=badge.me.badge_id()
  if id and badge.fs.read("appdata/device_id.txt")~="GB1\t"..id.."\n" then save("device_id.txt","GB1\t"..id.."\n") end
  local a=fields(badge.fs.read("appdata/account.txt"),"GA1",7)
  accountGen=a and a[2];challenge=a and a[3]
  T.name=nil;T.balance=nil;lastRx=nil;accountState="UNKNOWN"
  local savedSeq=badge.fs.read("appdata/request_sequence.txt")
  sequence=savedSeq and (tonumber(savedSeq) or 999999999) or 0
  sequence=math.max(sequence,tonumber(badge.store.get_str("usb_seq","0")) or 0)
  local previous=fields(badge.fs.read("appdata/response.txt"),"GR1",10)
  if previous then sequence=math.max(sequence,tonumber(previous[2]) or 0) end
  request=fields(badge.fs.read("appdata/request.txt"),"GQ1",11)
  if request then sequence=math.max(sequence,tonumber(request[2]) or 0) end
  if request and request[4]=="TRADE" then T.phase="pending";T.message="Checking confirmed trade"
  else request=nil;T.phase="account";save("request.txt","") end
end
function T.header()
  if fresh() then return "@"..T.name,money(T.balance) end
  return "", ""
end
function T.open(slug,side,title)
  if request and request[4]=="TRADE" then T.phase="pending";return end
  T.slug,T.side,T.title=slug,side,title
  T.qty=1;T.action="BUY"
  T.phase=fresh() and "edit" or "account"
end
local function send(kind)
  local seq=sequence
  if seq>=999999999 then T.phase="result";T.message="Request counter exhausted";return end
  local id=tostring(seq+1)
  if not save("request_sequence.txt",id) then T.phase="result";T.message="Could not save request";return end
  sequence=seq+1
  local r={"GQ1",id,challenge,kind,T.slug,T.side,T.action,tostring(T.qty),kind=="TRADE" and quoteId or "-",kind=="TRADE" and bound or "0","END"}
  local s=table.concat(r,"\t").."\n"
  if kind=="TRADE" then request=r;T.phase="pending" end
  if not save("request.txt",s) then T.phase=kind=="TRADE" and "pending" or "result";T.message="USB save uncertain. Check website.";return end
  request=r;started=badge.sys.ms();T.phase=kind=="TRADE" and "pending" or "wait"
  T.message=kind=="TRADE" and "Waiting for trade receipt" or "Getting a live quote"
end
function T.tick()
  local changed=false
  local a=fields(badge.fs.read("appdata/account.txt"),"GA1",7)
  if a and a[2]~=accountGen and #a[3]==64 and a[3]:match("^[a-f0-9]+$") then
    accountGen=a[2];challenge=a[3];lastRx=badge.sys.ms();accountState=a[4]
    if a[4]=="READY" and a[5]:match("^[a-z0-9_]+$") and #a[5]<=24 and a[6]:match("^%d+$") then T.name=a[5];T.balance=a[6]
    else T.name=nil;T.balance=nil end
    changed=true
  end
  if lastRx and badge.sys.ms()-lastRx>=35000 and accountState~="UNKNOWN" then T.name=nil;T.balance=nil;accountState="UNKNOWN";changed=true end
  if request then
    local r=fields(badge.fs.read("appdata/response.txt"),"GR1",10)
    if r and r[2]==request[2] and r[3]==request[3] then
      if T.phase=="wait" and r[4]=="QUOTE" and r[5]:match("^c[a-z0-9]+$") and r[6]:match("^%d+$") and r[7]:match("^%d+$") then
        quoteId,bound,fee=r[5],r[6],r[7]
        deadline=math.min(started+25000,badge.sys.ms()+math.max(0,math.min(25,tonumber(r[8]) or 0))*1000)
        T.phase="review";changed=true
      elseif (T.phase=="wait" or T.phase=="pending") and (r[4]=="DONE" or r[4]=="ERROR") then
        T.phase="result";T.message=r[9];changed=true
        -- Clear only after a definitive receipt/rejection; never after a timeout.
        if save("request.txt","") then request=nil end
      elseif T.phase=="pending" and r[4]=="PENDING" and T.message~=r[9] then T.message=r[9];changed=true end
    end
  end
  if T.phase=="wait" and badge.sys.ms()-started>28000 then T.phase="result";T.message="No quote. Try again.";request=nil;save("request.txt","");changed=true end
  if T.phase=="review" and (not fresh() or badge.sys.ms()>=deadline) then T.phase="result";T.message="Quote expired. Try again.";request=nil;save("request.txt","");changed=true end
  return changed
end
function T.button(button)
  local B=badge.input.BUTTON
  if request and request[4]=="TRADE" and T.phase~="result" then T.phase="pending" end
  if T.phase=="pending" then return false end
  if button==B.B then
    if request and request[4]=="TRADE" then T.phase="pending";return false end
    request=nil;save("request.txt","");return true
  end
  if T.phase=="edit" then
    if button==B.UP then T.qty=math.min(20,T.qty+1)
    elseif button==B.DOWN then T.qty=math.max(1,T.qty-1)
    elseif button==B.LEFT then T.action="BUY"
    elseif button==B.RIGHT then T.action="SELL"
    elseif button==B.A then if fresh() then send("QUOTE") else T.phase="account" end end
  elseif T.phase=="review" and button==B.A then
    if fresh() and badge.sys.ms()<deadline and request and request[3]==challenge then send("TRADE")
    else T.phase="result";T.message="Quote expired. Try again." end
  elseif T.phase=="account" and button==B.A and fresh() and T.slug then T.phase="edit"
  elseif T.phase=="result" and button==B.A then
    if request and request[4]=="TRADE" then T.phase="pending"
    else T.phase=fresh() and "edit" or "account" end
  end
  return false
end
function T.pairing_challenge() return T.phase=="account" and accountState=="LINK" and lastRx and badge.sys.ms()-lastRx<35000 and challenge or nil end
function T.draw(text,wrap,hasQR)
  if T.phase=="account" and fresh() then
    text(1,"Account linked",10,55,300,22)
    text(2,"@"..T.name,10,100,300,20)
    text(3,"Balance "..money(T.balance),10,138,300,18)
    text(4,"A: continue   B: markets",10,205,300,14)
  elseif T.phase=="account" then
    if hasQR then
      text(1,"Scan to sign in",10,47,300,18,"center")
      text(2,"Use your phone to link Goosey",10,195,300,14,"center")
    else
      text(1,"Reconnecting...",10,65,300,20,"center")
      text(2,"Waiting for connection",10,115,300,16,"center")
    end
  elseif T.phase=="edit" or T.phase=="review" then
    text(1,wrap(T.title or "Market",39),10,42,300,14)
    text(2,T.action.." "..T.side.."  x"..T.qty,10,95,300,22)
    if T.phase=="edit" then
      text(3,"Amount: "..T.qty.." contracts",10,135,300,18)
      text(4,"Buy / Sell",10,169,300,16)
      text(5,"Review trade",10,208,300,18)
    else
      text(3,(T.action=="BUY" and "Pay " or "Receive ")..money(bound),10,132,300,20)
      text(4,"Fee "..money(fee).." included",10,165,300,14)
      text(5,"Confirm trade",10,207,300,18)
    end
  else
    text(1,T.phase=="pending" and "Trade submitted" or T.phase=="wait" and "Live quote" or "Trade",10,48,300,22)
    text(2,wrap(T.message,32),10,95,300,18)
    if T.phase=="pending" then text(3,wrap("Keep USB connected. Your balance updates after confirmation.",36),10,165,300,14) end
  end
end
return T
