"""Paced macOS USB console access; no firmware or private account operations."""
import os, select, time, sys, signal
class Console:
 def __init__(self,port="/dev/cu.usbmodem1101"):
  self.port=port
 def __enter__(self):
  self.fd=os.open(self.port,os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK);self.buffer=b'';return self
 def __exit__(self,*args):os.close(self.fd)
 def write(self,b):
  for i in range(0,len(b),128):
   chunk=b[i:i+128]
   while chunk:
    try:chunk=chunk[os.write(self.fd,chunk):]
    except BlockingIOError:select.select([],[self.fd],[],.2)
   time.sleep(.020)
 def wait(self,marker=b'badge> ',timeout=6):
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   if marker in self.buffer:
    i=self.buffer.index(marker)+len(marker);data=self.buffer[:i];self.buffer=self.buffer[i:];return data.decode(errors='replace')
   if select.select([self.fd],[],[],.1)[0]:
    try:self.buffer+=os.read(self.fd,16384)
    except BlockingIOError:pass
  raise RuntimeError('Console timeout: '+self.buffer[-600:].decode(errors='replace'))
 def cmd(self,cmd):
  self.buffer=b'';self.write((cmd+'\r').encode());return self.wait()
 def put(self,path,content):
  # Finish an announced binary payload before honoring Ctrl-C. Otherwise the
  # badge consumes future console commands as missing file bytes.
  interrupted=[]
  previous=signal.signal(signal.SIGINT,lambda *_: interrupted.append(True))
  try:return self._put(path,content)
  finally:
   signal.signal(signal.SIGINT,previous)
   if interrupted:raise KeyboardInterrupt
 def _put(self,path,content):
  self.buffer=b'';self.write(('put '+path+' '+str(len(content))+'\r').encode());self.wait(b'READY')
  self.write(content);reply=self.wait(('OK '+str(len(content))).encode(),20);self.wait();return reply
if __name__=='__main__':
 with Console() as c:
  c.cmd('')
  for cmd in sys.argv[1:]:print(c.cmd(cmd))
