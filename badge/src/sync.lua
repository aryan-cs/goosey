-- Public view reducer. Internal interface AFTER transport authentication/decoding.
-- Not wired to radio yet; never grants authority to trade or updates paper_v1.
local M = {}
local states = {OPEN=true, PAUSED=true, CLOSED=true, RESOLVING=true, RESOLVED=true, VOID=true}
local function integer(n, max)
  return type(n)=="number" and n>=0 and n<=max and n%1==0
end
local function string_ok(s, max)
  return type(s)=="string" and #s>0 and #s<=max and not s:find("[%c]")
end
local function market(m)
  if type(m)~="table" or not string_ok(m.id,64) or not string_ok(m.title,120)
    or not states[m.status] or not integer(m.version,2147483647)
    or not integer(m.probabilityBps,10000) then return nil end
  return {id=m.id,title=m.title,status=m.status,version=m.version,probabilityBps=m.probabilityBps}
end
function M.new()
  return {epoch=nil,sequence=0,markets={},lastUpdate=nil,needsSnapshot=true}
end
function M.apply(s, event, now)
  if type(event)~="table" or not integer(now,9007199254740991)
    or not string_ok(event.epoch,32) or not integer(event.sequence,2147483647)
    or type(event.markets)~="table" or #event.markets>16 then return false,"invalid" end
  if event.type~="snapshot" and event.type~="delta" then return false,"invalid" end
  local count=0
  for k in pairs(event.markets) do
    count=count+1
    if not integer(k,16) or k<1 or k>#event.markets then return false,"invalid" end
  end
  if count~=#event.markets then return false,"invalid" end
  local validated,ids={},{}
  for i,m in ipairs(event.markets) do
    local copy=market(m)
    if not copy or ids[copy.id] then return false,"invalid" end
    ids[copy.id]=true; validated[i]=copy
  end
  if event.epoch==s.epoch and (event.sequence<s.sequence or
    (event.sequence==s.sequence and not (s.needsSnapshot and event.type=="snapshot"))) then
    return false,"duplicate"
  end
  if event.type=="delta" then
    if s.needsSnapshot or event.epoch~=s.epoch or event.baseSequence~=s.sequence
      or event.sequence~=s.sequence+1 then
      s.needsSnapshot=true; return false,"gap"
    end
    local replacements={}
    for _,m in ipairs(validated) do
      local found
      for i,old in ipairs(s.markets) do if old.id==m.id then found=i; break end end
      if not found or m.version<=s.markets[found].version then
        s.needsSnapshot=true; return false,"catalog"
      end
      replacements[found]=m
    end
    for i,m in pairs(replacements) do s.markets[i]=m end
  else
    -- A full snapshot can recover a gap at the current sequence.
    s.markets=validated; s.epoch=event.epoch; s.needsSnapshot=false
  end
  s.sequence=event.sequence; s.lastUpdate=now
  return true
end
function M.status(s,now)
  if s.needsSnapshot then return "Reconnecting" end
  if not s.lastUpdate or now<s.lastUpdate or now-s.lastUpdate>=30000 then return "Offline - cached" end
  return "Updated "..math.floor((now-s.lastUpdate)/1000).."s ago"
end
return M
