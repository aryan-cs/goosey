-- Participant-side diagnostic. No USB required while this app runs.
local link,status,route,seq,waiting,sentAt,answered
function on_enter(root)
  status=badge.ui.label(root,"Goosey wireless test")
  status:set_size(300,180)
  status:style({text_font=14})
  status:set_pos(10,20)
  -- Routing randomness is NOT used as a credential.
  route=string.format("%08x",badge.sys.random())
  seq=0
  if not badge.radio.enable() then status:set_text("Radio unavailable");return end
  link=require("link").new("C",route,function(s) badge.radio.send(s) end,function(r,id,body)
    if id~=waiting or not body:match("^PONG ") then return false end
    answered=true
    status:set_text("Wireless reply received\n"..body.."\nA: test again\nNot authenticated")
    return true
  end,badge.sys.ms)
  badge.radio.on_recv(function(_,_,s) link.receive(s) end)
  status:set_text("A: test wireless gateway\nNo login or trading in this test")
end
function on_button(button,kind)
  if not link or kind~=badge.input.KIND.PRESSED or button~=badge.input.BUTTON.A or link.pending then return end
  seq=seq+1;waiting=string.format("%08x",seq)
  if link.queue(route,waiting,"PING") then sentAt=badge.sys.ms();answered=false;status:set_text("Waiting for wireless gateway...") end
end
function on_tick()
  if link then
    link.tick()
    if link.error then status:set_text(link.error.."\nA: retry")
    elseif sentAt and not answered and badge.sys.ms()-sentAt>15000 then
      status:set_text("No backend reply\nCheck relay and Mac bridge\nA: retry")
    end
  end
end
function on_exit() badge.radio.disable() end
