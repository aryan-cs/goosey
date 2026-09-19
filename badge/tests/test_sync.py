from pathlib import Path
from lupa.lua54 import LuaRuntime

root = Path(__file__).resolve().parents[2]
lua = LuaRuntime(unpack_returned_tuples=True)
lua.globals().sync = lua.execute((root / 'badge/src/sync.lua').read_text())
lua.execute('''
local s=sync.new()
local function m(id,v,p) return {id=id,title="Market "..id,status="OPEN",version=v,probabilityBps=p} end
local function event(kind,epoch,seq,base,markets)
  return {type=kind,epoch=epoch,sequence=seq,baseSequence=base,markets=markets}
end
assert(sync.status(s,0)=="Reconnecting")
assert(sync.apply(s,event("snapshot","a",1,nil,{m("one",1,5000),m("two",1,2000)}),10))
assert(sync.status(s,1000)=="Updated 0s ago")
assert(sync.status(s,30010)=="Offline - cached")
assert(sync.apply(s,event("delta","a",2,1,{m("one",2,7000)}),100))
assert(s.markets[1].probabilityBps==7000)
local ok,reason=sync.apply(s,event("delta","a",2,1,{m("one",2,7000)}),200)
assert(not ok and reason=="duplicate" and s.lastUpdate==100)
ok,reason=sync.apply(s,event("delta","a",4,3,{m("one",4,9000)}),300)
assert(not ok and reason=="gap" and s.markets[1].probabilityBps==7000)
assert(sync.status(s,301)=="Reconnecting")
assert(sync.apply(s,event("snapshot","a",2,nil,{m("one",2,7000),m("two",1,2000)}),400))
-- A mixed valid/unknown delta is atomic: none of it applies.
ok,reason=sync.apply(s,event("delta","a",3,2,{m("one",3,8000),m("unknown",1,1000)}),500)
assert(not ok and reason=="catalog" and s.markets[1].probabilityBps==7000 and s.sequence==2)
assert(sync.apply(s,event("snapshot","b",0,nil,{m("new",1,0)}),600))
assert(#s.markets==1 and s.markets[1].id=="new")
assert(not sync.apply(s,event("snapshot","c",1,nil,{m("new",1,10001)}),700))
assert(not sync.apply(s,event("snapshot","c",1,nil,{m("new",1,100),m("new",1,100)}),700))
assert(not sync.apply(s,event("snapshot","c",1,nil,{bad=m("new",1,100)}),700))
assert(not sync.apply(s,event("snapshot","c",1,nil,{[1]=m("a",1,100),[3]=m("b",1,100)}),700))
assert(s.epoch=="b" and s.lastUpdate==600)
local many={} for i=1,17 do many[i]=m(tostring(i),1,5000) end
assert(not sync.apply(s,event("snapshot","c",1,nil,many),700))
-- Every accepted field is copied, so a decoder reusing its table cannot mutate the view.
local original=m("new",2,10000)
assert(sync.apply(s,event("delta","b",1,0,{original}),800))
original.probabilityBps=0
assert(s.markets[1].probabilityBps==10000)
assert(sync.status(s,0)=="Offline - cached")
''')
print('PASS: snapshots, deltas, replay, gap recovery, atomic validation, catalog replacement, bounds and stale state')
