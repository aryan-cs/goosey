from pathlib import Path
from lupa.lua54 import LuaRuntime
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from cloud_snapshot import detail_mailbox_frame

lua=LuaRuntime(unpack_returned_tuples=True)
reader=lua.execute((Path(__file__).resolve().parents[1]/'src/detail_reader.lua').read_text())
detail=dict(generation='123',slug='market-one',rangeStart=1000,rangeEnd=14401000,
            history=[[50,0],[61.23,7201000]])
frame=detail_mailbox_frame(detail).decode()
parsed=reader(frame)
assert parsed['slug']=='market-one' and parsed['history'][2][1]==61.23
for cut in range(len(frame)): assert reader(frame[:cut]) is None
for bad in (frame+'junk\n',frame.replace('GH1','GH2'),frame.replace('14401000','14401001'),
            frame.replace('6123','10001'),frame.replace('7201000','-1'),frame.replace('END\t123','END\t124')):
    assert reader(bad) is None
print('Detail reader: exact 4H domain, bounds, ordering, truncation and footer checks passed.')
