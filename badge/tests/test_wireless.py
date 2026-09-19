"""Exercise actual Lua link code under packet loss/reorder/corruption, no live orders."""
from pathlib import Path
import sys
import unittest
from lupa.lua54 import LuaRuntime
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import wireless_probe_gateway as probe
ROOT=Path(__file__).resolve().parents[1]

class LinkTests(unittest.TestCase):
 def setUp(self):
  self.lua=LuaRuntime(unpack_returned_tuples=True)
  self.module=self.lua.execute((ROOT/'wireless/link.lua').read_text())
  self.now=0;self.cq=[];self.sq=[];self.received=[];self.accept=True
  self.client=self.module.new('C','12345678',self.cq.append,lambda *x:True,lambda:self.now)
  def deliver(*x):
   if not self.accept:return False
   self.received.append(x);return True
  self.server=self.module.new('S','00000000',self.sq.append,deliver,lambda:self.now)
 def pump(self,loss=False):
  self.client.tick();self.server.tick()
  for raw in self.cq[:]:
   self.assertLessEqual(len(raw),44)
   self.server.receive(raw)
  self.cq.clear()
  for raw in self.sq[:]:
   if not loss:self.client.receive(raw)
  self.sq.clear();self.now+=500
 def test_loss_duplicate_and_maximum_payload(self):
  body='x'*504
  self.assertTrue(self.client.queue('12345678','00000001',body))
  for n in range(100):self.pump(loss=n%3==0)
  self.assertEqual(self.received,[('12345678','00000001',body)])
  self.assertIsNone(self.client.pending)
 def test_reordered_and_altered_fragments(self):
  self.client.queue('12345678','00000002','x'*22)
  self.client.tick();first=self.cq.pop()
  self.assertFalse(self.server.receive(first[:19]+'0202'+'y'))
  self.assertTrue(self.server.receive(first))
  self.assertFalse(self.server.receive(first[:-1]+'z'))
  self.assertEqual(self.received,[])
 def test_wrong_route_and_spoofed_ack_shape(self):
  self.client.queue('12345678','00000003','PING');self.client.tick()
  self.assertFalse(self.client.receive('G1c87654321000000030101'))
  self.assertFalse(self.client.receive('G1c12345678000000030101extra'))
  self.assertIsNotNone(self.client.pending)
 def test_refused_durable_delivery_gets_no_final_ack(self):
  self.accept=False;self.client.queue('12345678','00000004','PING');self.pump()
  self.assertIsNotNone(self.client.pending)
  self.accept=True;self.pump()
  self.assertIsNone(self.client.pending);self.assertEqual(len(self.received),1)
 def test_timeout_and_bounds(self):
  self.assertFalse(self.client.queue('12345678','00000001','x'*505))
  self.client.queue('12345678','00000001','PING')
  for _ in range(10):self.client.tick();self.now+=500
  self.assertEqual(self.client.error,'Radio timeout')
  for raw in ['','G1','x'*45,'G1C12345678000000010000x','G1C123456780000000101ffx']:
   self.assertFalse(self.server.receive(raw))
 def test_probe_parser_never_accepts_orders(self):
  self.assertEqual(probe.parse('echo\r\n12345678|00000001|PING\r\nbadge> '),('12345678','00000001'))
  self.assertIsNone(probe.parse('12345678|00000001|TRADE'))
  self.assertIsNone(probe.parse('12345678|00000001|PING\n12345678|00000002|PING'))

class AppSmokeTests(unittest.TestCase):
 def test_lifecycle_for_both_apps(self):
  for role in ['client','relay','minimal']:
   lua=LuaRuntime(unpack_returned_tuples=True)
   lua.execute("""
   files={};sent={};clock=0
   badge={ui={},radio={},fs={},sys={},input={BUTTON={A=1},KIND={PRESSED=1}}}
   function badge.ui.label(root,s)
     assert(root=='root');return {set_pos=function()end,set_size=function()end,
       style=function()end,set_text=function(_,text) screen=text end}
   end
   function badge.radio.enable()return true end
   function badge.radio.disable()end
   function badge.radio.send(s)assert(#s<=44);table.insert(sent,s);return true end
   function badge.radio.on_recv(f)receive=f end
   function badge.fs.read(p)return files[p] end
   function badge.fs.write(p,s)files[p]=s end
   function badge.sys.ms()return clock end
   function badge.sys.random()return 123456 end
   """)
   module=lua.execute((ROOT/'wireless/link.lua').read_text())
   lua.globals().require=lambda name:module if name=='link' else None
   lua.execute((ROOT/'wireless'/role/'main.lua').read_text())
   lua.globals().on_enter('root');lua.globals().on_tick()
   if role=='minimal':
    self.assertEqual(lua.globals().sent[1],'GOOSEY-PING')
    lua.globals().receive('peer',-40,'GOOSEY-PING')
    self.assertEqual(lua.globals().sent[2],'GOOSEY-PONG')
    lua.globals().receive('peer',-40,'GOOSEY-PONG')
    self.assertEqual(lua.globals().screen,'Wireless reply received')
   elif role=='client':
    lua.globals().on_button(1,1);lua.globals().on_tick()
    self.assertEqual(len(lua.globals().sent),1)
   else:
    self.assertIn('ready',lua.globals().screen)
   lua.globals().on_exit()

if __name__=='__main__':unittest.main()
