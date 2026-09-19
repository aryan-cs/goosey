-- Shared station badge only. Serial mailbox contains public diagnostic messages.
local link,status,seen
local function read(p) return badge.fs.read("appdata/"..p) end
local function write(p,s) badge.fs.write("appdata/"..p,s);return read(p)==s end
function on_enter(root)
  status=badge.ui.label(root,"Goosey relay test")
  status:set_size(300,180)
  status:style({text_font=14})
  status:set_pos(12,20)
  local ok=badge.radio.enable()
  if not ok then status:set_text("Radio unavailable");return end
  link=require("link").new("S","00000000",function(s) badge.radio.send(s) end,function(route,id,body)
    if body~="PING" then return false end
    local frame=route.."|"..id.."|PING\n"
    local prior=read("rx.txt")
    if prior and prior~="" and prior~=frame then return false end
    return write("rx.txt",frame)
  end,badge.sys.ms)
  badge.radio.on_recv(function(_,_,s) link.receive(s) end)
  status:set_text("Relay ready\nPublic diagnostic traffic only")
end
function on_tick()
  if not link then return end
  local tx=read("tx.txt")
  if tx and tx~=seen and not link.pending then
    local route,id,body=tx:match("^([0-9a-f]+)|([0-9a-f]+)|([^\n]+)\n$")
    if route and body:match("^PONG ") and link.queue(route,id,body) then seen=tx end
  end
  link.tick()
  if link.error then status:set_text(link.error.."\nRestart client test") end
end
function on_exit() badge.radio.disable() end
