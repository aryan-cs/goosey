-- Selected-market 1H history only. Values are real server observations in basis points.
local function readDetailFrame(data)
  if type(data)~="string" or #data>6000 or data:sub(-1)~="\n" then return nil end
  local iter=data:gmatch("([^\n]*)\n")
  local function row()
    local line=iter()
    if not line or #line>600 then return nil end
    local parts={}
    for part in (line.."\t"):gmatch("(.-)\t") do parts[#parts+1]=part end
    return parts
  end
  local head=row()
  if not head or #head~=10 or head[1]~="GH2" or not head[2]:match("^%d+$") or #head[2]>24
    or not head[3]:match("^[a-z0-9-]+$") or #head[3]>120
    or not head[4]:match("^%d+$") or not head[5]:match("^%d+$") or not head[6]:match("^%d+$")
    or not head[7]:match("^%d+$") or (head[8]~="0" and head[8]~="1")
    or (head[9]~="-" and not head[9]:match("^%d+$"))
    or (head[10]~="PROBABILITY" and head[10]~="EXECUTIONS") then return nil end
  local startAt,endAt,count,sampledFrom=tonumber(head[4]),tonumber(head[5]),tonumber(head[6]),tonumber(head[7])
  local currentBps=head[9]=="-" and nil or tonumber(head[9])
  if not startAt or not endAt or not count or endAt-startAt~=3600000 or count<0 or count>32
    or not sampledFrom or sampledFrom<count or (currentBps and (currentBps%1~=0 or currentBps<0 or currentBps>10000)) then return nil end
  local result={generation=head[2],slug=head[3],startAt=startAt,endAt=endAt,history={},sampledFrom=sampledFrom,
    downsampled=head[8]=="1",currentProbabilityBps=currentBps,source=head[10]}
  for i=1,count do
    local point=row()
    if not point or #point~=3 or point[1]~="H" then return nil end
    local t,p=tonumber(point[2]),tonumber(point[3])
    if not t or t%1~=0 or t<0 or t>endAt or not p or p%1~=0 or p<0 or p>10000
      or (i>1 and t<result.history[i-1][2]) then return nil end
    result.history[i]={p,t}
  end
  local ending=row()
  if iter()~=nil or not ending or #ending~=2 or ending[1]~="END" or ending[2]~=head[2] then return nil end
  return result
end
return readDetailFrame
