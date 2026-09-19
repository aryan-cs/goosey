from pathlib import Path
from lupa.lua54 import LuaRuntime
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from cloud_snapshot import mailbox_frame

lua = LuaRuntime(unpack_returned_tuples=True)
reader = lua.execute((Path(__file__).resolve().parents[1] / 'src/cloud_reader.lua').read_text() + '\nreturn readCloudFrame')
snapshot = dict(generation='1234567890123456789', capturedAt='09/19 19:00 UTC', markets=[dict(slug='one',title='A market?',probability=50,volume='10',closes='09/20 18:30 UTC',status='OPEN',history=[[50,1000],[51,2000]])])
frame = mailbox_frame(snapshot).decode()
assert reader(frame)['markets'][1]['history'][2][1] == 51
for cut in range(len(frame)):
    assert reader(frame[:cut]) is None
for bad in [frame+'junk\n',frame.replace('END\t123','END\t124'),frame.replace('5000','10001'),frame.replace('2000\t5100','500\t5100'),frame.replace('\t2\nH','\t33\nH'),frame.replace('GS1','GS2')]:
    assert reader(bad) is None
many=dict(snapshot,markets=[dict(snapshot['markets'][0],slug=str(i),history=[[50,j] for j in range(32)]) for i in range(4)])
assert reader(mailbox_frame(many).decode()) is None
print('Mailbox reader: truncation, invalid/reordered data, frame/footer mismatch, and total memory bounds passed.')


step=reader(frame,True)
assert step() is False
assert step()['markets'][1]['title']=='A market?'
step=reader(frame.replace('END\t123','END\t124'),True)
assert step() is False
assert step() is None
