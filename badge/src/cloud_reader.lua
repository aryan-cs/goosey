-- Public USB mailbox only. This is never an account or order channel.
local function readCloudFrame(data,incremental)
  if type(data)~="string" or #data>16000 or data:sub(-1)~="\n" then return nil end
  local iter=data:gmatch("([^\n]*)\n")
  local lineCount=0
  local function nextRow()
    local line=iter()
    if not line then return nil end
    lineCount=lineCount+1
    if lineCount>114 or #line>600 then return nil end
    local parts={}
    for part in (line.."\t"):gmatch("(.-)\t") do parts[#parts+1]=part end
    return parts
  end
  local head=nextRow()
  local v2=head and head[1]=="GS2"
  if not head or (not v2 and head[1]~="GS1") or (v2 and #head~=6) or (not v2 and #head~=4) or not head[2]:match("^%d+$") or #head[2]>24 or #head[3]>20 then return nil end
  local rangeStart,rangeEnd,count
  if v2 then
    rangeStart,rangeEnd,count=tonumber(head[4]),tonumber(head[5]),tonumber(head[6])
    if not rangeStart or rangeStart%1~=0 or rangeStart<0 or not rangeEnd or rangeEnd%1~=0 or rangeEnd<=rangeStart or rangeEnd-rangeStart~=14400000 then return nil end
  else count=tonumber(head[4]) end
  if not count or count%1~=0 or count<1 or count>16 then return nil end
  local result={generation=head[2],capturedAt=head[3],rangeStart=rangeStart,rangeEnd=rangeEnd,markets={}}
  local seen,totalPoints={},0
  local i=0
  local function step()
  i=i+1
  if i<=count then
    local row=nextRow()
    if not row or row[1]~="M" or #row[2]>120 or not row[2]:match("^[%w_-]+$") or seen[row[2]] or #row[3]<1 or #row[3]>240 then return nil end
    local shortTitle,category,bps,change,volume,closes,status,accepting,n
    if v2 then
      if #row~=12 or #row[4]<1 or #row[4]>160 or #row[5]<1 or #row[5]>40 then return nil end
      shortTitle,category,bps,change,volume,closes,status,accepting,n=row[4],row[5],tonumber(row[6]),row[7],row[8],row[9],row[10],row[11],tonumber(row[12])
      if change~="-" then change=tonumber(change);if not change or change%1~=0 or change < -10000 or change > 10000 then return nil end else change=nil end
      if accepting~="0" and accepting~="1" then return nil end
      accepting=accepting=="1"
    else
      if #row~=8 then return nil end
      shortTitle,category,bps,change,volume,closes,status,accepting,n=row[3],"Market",tonumber(row[4]),nil,row[5],row[6],row[7],row[7]=="OPEN",tonumber(row[8])
    end
    if #volume>20 or not volume:match("^%d[%d,]*$") or volume:find(",,") or volume:sub(-1)=="," or #closes>20 then return nil end
    if not bps or bps%1~=0 or bps<0 or bps>10000 or not n or n%1~=0 or n<0 or n>32 then return nil end
    totalPoints=totalPoints+n;if totalPoints>96 then return nil end
    if not ({OPEN=true,PAUSED=true,CLOSED=true,RESOLVED=true,VOID=true})[status] then return nil end
    seen[row[2]]=true
    local market={slug=row[2],title=row[3],shortTitle=shortTitle,category=category,probability=bps/100,changeBps=change,volume=volume,closes=closes,status=status,acceptingOrders=accepting,history={}}
    for j=1,n do
      local point=nextRow()
      if not point or #point~=3 or point[1]~="H" then return nil end
      local t,p=tonumber(point[2]),tonumber(point[3])
      if not t or t%1~=0 or t<0 or t>9999999999999 or not p or p%1~=0 or p<0 or p>10000 or (j>1 and t<market.history[j-1][2]) then return nil end
      market.history[j]={p/100,t}
    end
    result.markets[i]=market
    return false
  end
  local ending=nextRow()
  if iter()~=nil or not ending or #ending~=2 or ending[1]~="END" or ending[2]~=head[2] then return nil end
  return result
  end
  if incremental then return step end
  while true do local value=step();if value~=false then return value end end
end
