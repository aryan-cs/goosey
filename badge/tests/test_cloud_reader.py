from pathlib import Path
from lupa.lua54 import LuaRuntime
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from cloud_snapshot import mailbox_frame

lua = LuaRuntime(unpack_returned_tuples=True)
reader = lua.execute((Path(__file__).resolve().parents[1] / 'src/cloud_reader.lua').read_text() + '\nreturn readCloudFrame')
snapshot = dict(generation='1234567890123456789', capturedAt='09/19 19:00 UTC', rangeStart=1000, rangeEnd=14401000,
                markets=[dict(slug='one',title='A market?',shortTitle='A market?',category='Hack the North',probabilityBps=5050,
                              changeBps=100,volume='10',closes='09/20 18:30 UTC',status='OPEN',acceptingOrders=True,
                              history=[[5000,1000],[5123,2000]])])
frame = mailbox_frame(snapshot).decode()
parsed=reader(frame)
assert parsed['markets'][1]['probabilityBps']==5050
assert parsed['markets'][1]['history'][2][1] == 5123
assert parsed['markets'][1]['category']=='Hack the North' and parsed['markets'][1]['changeBps']==100
assert parsed['rangeEnd']-parsed['rangeStart']==14400000
for cut in range(len(frame)):
    assert reader(frame[:cut]) is None
for bad in [frame+'junk\n',frame.replace('END\t123','END\t124'),frame.replace('\t5050\t100\t','\t10001\t100\t'),frame.replace('2000\t5123','500\t5123'),frame.replace('\t2\nH','\t33\nH'),frame.replace('GS2','GS3'),frame.replace('\t1\t2\nH','\tyes\t2\nH')]:
    assert reader(bad) is None
many=dict(snapshot,markets=[dict(snapshot['markets'][0],slug=str(i),history=[[5000,j] for j in range(32)]) for i in range(4)])
assert reader(mailbox_frame(many).decode()) is None
legacy='GS1\t7\t09/19 19:00 UTC\t1\nM\tone\tLegacy market?\t5000\t10\t09/20 18:30 UTC\tOPEN\t0\nEND\t7\n'
legacy_market=reader(legacy)['markets'][1]
assert legacy_market['category']=='Market' and legacy_market['shortTitle']=='Legacy market?' and legacy_market['acceptingOrders']
print('Mailbox reader: truncation, invalid/reordered data, frame/footer mismatch, and total memory bounds passed.')


step=reader(frame,True)
assert step() is False
assert step()['markets'][1]['title']=='A market?'
step=reader(frame.replace('END\t123','END\t124'),True)
assert step() is False
assert step() is None
