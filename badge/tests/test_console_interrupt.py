import signal,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from badge_console import Console
class InterruptTests(unittest.TestCase):
 def test_ctrl_c_finishes_payload_and_prompt_before_exit(self):
  c=Console();events=[];old=signal.getsignal(signal.SIGINT)
  def write(data):
   events.append(data)
   if data.startswith(b'put '):signal.raise_signal(signal.SIGINT)
  def wait(*args):events.append(args);return 'OK'
  c.write=write;c.wait=wait
  with self.assertRaises(KeyboardInterrupt):c.put('/littlefs/apps/test/data',b'complete-body')
  self.assertIn(b'complete-body',events)
  self.assertEqual(events[-1],())
  self.assertEqual(signal.getsignal(signal.SIGINT),old)
if __name__=='__main__':unittest.main()
