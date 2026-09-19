-- Public radio-only memory probe. Never authenticate or submit trades with it.
local label,nextAt,enabled= nil,0,false
function on_enter(root)
 enabled=badge.radio.enable()
 label=badge.ui.label(root,enabled and "Radio enabled; testing" or "Radio unavailable")
 label:set_pos(10,20);label:set_size(300,100)
 if enabled then badge.radio.on_recv(function(_,_,s)
  if s=="GOOSEY-PING" then badge.radio.send("GOOSEY-PONG")
  elseif s=="GOOSEY-PONG" then label:set_text("Wireless reply received") end
 end) end
end
function on_tick()
 local now=badge.sys.ms()
 if enabled and now>=nextAt then nextAt=now+5000;badge.radio.send("GOOSEY-PING") end
end
function on_exit() badge.radio.disable() end
