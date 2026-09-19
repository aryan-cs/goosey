-- Public USB mailbox only. This is never an account or order channel.
local function readCloudFrame(data,collect)
  if type(data)~="string" or #data>16000 or data:sub(-1)~="\n" then return nil end
  local iter=data:gmatch("([^\n]*)\n")
  local lineCount=0
  local function nextRow()
    if collect then collect() end
    local line=iter()
    if not line then return nil end
    lineCount=lineCount+1
    if lineCount>114 or #line>600 then return nil end
    local parts={}
    for part in (line.."\t"):gmatch("(.-)\t") do parts[#parts+1]=part end
    return parts
  end
  local head=nextRow()
  if not head or #head~=4 or head[1]~="GS1" or not head[2]:match("^%d+$") or #head[2]>24 or #head[3]>20 then return nil end
  local count=tonumber(head[4])
  if not count or count%1~=0 or count<1 or count>16 then return nil end
  local result={generation=head[2],capturedAt=head[3],markets={}}
  local seen,totalPoints={},0
  for i=1,count do
    local row=nextRow()
    if not row or #row~=8 or row[1]~="M" or #row[2]>120 or not row[2]:match("^[%w_-]+$") or seen[row[2]] or #row[3]<1 or #row[3]>240 or #row[5]>12 or not row[5]:match("^%d+k?$") or #row[6]>20 then return nil end
    local bps,n=tonumber(row[4]),tonumber(row[8])
    if not bps or bps%1~=0 or bps<0 or bps>10000 or not n or n%1~=0 or n<0 or n>32 then return nil end
    totalPoints=totalPoints+n;if totalPoints>96 then return nil end
    if not ({OPEN=true,PAUSED=true,CLOSED=true,RESOLVED=true,VOID=true})[row[7]] then return nil end
    seen[row[2]]=true
    local market={slug=row[2],title=row[3],probability=bps/100,volume=row[5],closes=row[6],status=row[7],history={}}
    for j=1,n do
      local point=nextRow()
      if not point or #point~=3 or point[1]~="H" then return nil end
      local t,p=tonumber(point[2]),tonumber(point[3])
      if not t or t%1~=0 or t<0 or t>9999999999999 or not p or p%1~=0 or p<0 or p>10000 or (j>1 and t<market.history[j-1][2]) then return nil end
      market.history[j]={p/100,t}
    end
    result.markets[i]=market
  end
  local ending=nextRow()
  if iter()~=nil or not ending or #ending~=2 or ending[1]~="END" or ending[2]~=head[2] then return nil end
  return result
end
