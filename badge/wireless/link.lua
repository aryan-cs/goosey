-- Bounded, stop-and-wait LUA1 transport. NOT authentication or encryption.
-- Diagnostic traffic only until an authenticated channel is implemented.
local M={}
local function hex(s,n) return type(s)=="string" and #s==n and s:match("^[0-9a-f]+$") end
function M.new(role,route,send,deliver,now)
  assert(role=="C" or role=="S")
  assert(hex(route,8))
  local self={pending=nil,incoming=nil,last=nil,error=nil}
  local other=role=="C" and "S" or "C"
  local function packet(kind,r,id,i,n,body)
    return "G1"..kind..r..id..string.format("%02x%02x",i,n)..body
  end
  function self.queue(r,id,body)
    if self.pending or not hex(r,8) or not hex(id,8) or type(body)~="string" or #body<1 or #body>504 then return false end
    if role=="C" and r~=route then return false end
    self.pending={route=r,id=id,body=body,index=1,total=math.ceil(#body/21),tries=0,at=-10000}
    self.error=nil
    return true
  end
  function self.tick()
    local t=now()
    if self.incoming and t-self.incoming.at>10000 then self.incoming=nil end
    local p=self.pending
    if not p or t-p.at<500 then return end
    if p.tries>=8 then self.pending=nil;self.error="Radio timeout";return end
    send(packet(role,p.route,p.id,p.index,p.total,p.body:sub((p.index-1)*21+1,p.index*21)))
    p.tries=p.tries+1;p.at=t
  end
  function self.receive(raw)
    if type(raw)~="string" or #raw<23 or #raw>44 or raw:sub(1,2)~="G1" then return false end
    local kind,r,id=raw:sub(3,3),raw:sub(4,11),raw:sub(12,19)
    local a,b=raw:sub(20,21),raw:sub(22,23)
    if not hex(r,8) or not hex(id,8) or not hex(a,2) or not hex(b,2) then return false end
    if role=="C" and r~=route then return false end
    local i,n=tonumber(a,16),tonumber(b,16)
    if i<1 or n<1 or n>24 or i>n then return false end
    if kind==role:lower() then
      local p=self.pending
      if #raw~=23 or not p or p.route~=r or p.id~=id or p.index~=i or p.total~=n then return false end
      p.index=p.index+1;p.tries=0;p.at=-10000
      if p.index>n then self.pending=nil end
      return true
    end
    if kind~=other or #raw==23 or (i<n and #raw~=44) then return false end
    local key=r..id
    -- Exact duplicate packet after completion: ACK it without redelivery.
    local last=self.last
    if last and last.key==key and last.total==n then
      if last.parts[i]~=raw:sub(24) then return false end
      send(packet(other:lower(),r,id,i,n,""));return true
    end
    local incoming=self.incoming
    if not incoming then
      if i~=1 then return false end
      incoming={key=key,route=r,id=id,total=n,parts={},next=1,at=now()};self.incoming=incoming
    end
    if incoming.key~=key or incoming.total~=n or i>incoming.next then return false end
    local body=raw:sub(24)
    if i<incoming.next and incoming.parts[i]~=body then return false end
    if i==incoming.next then incoming.parts[i]=body;incoming.next=i+1 end
    incoming.at=now()
    if incoming.next>n then
      -- Receiver must durably accept the payload before acknowledging completion.
      if not deliver(r,id,table.concat(incoming.parts)) then return false end
      self.last=incoming;self.incoming=nil
    end
    send(packet(other:lower(),r,id,i,n,""));return true
  end
  return self
end
return M
