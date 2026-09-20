from pathlib import Path
from lupa.lua54 import LuaRuntime
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from cloud_snapshot import detail_mailbox_frame

lua=LuaRuntime(unpack_returned_tuples=True)
reader=lua.execute((Path(__file__).resolve().parents[1]/'src/detail_reader.lua').read_text())
detail=dict(generation='123',slug='market-one',rangeStart=1000,rangeEnd=3601000,
            currentProbabilityBps=6123,sampledFrom=41,downsampled=True,source='PROBABILITY',
            history=[[5000,0],[6123,1801000]])
frame=detail_mailbox_frame(detail).decode()
parsed=reader(frame)
assert frame.startswith('GH2\t')
assert parsed['slug']=='market-one' and parsed['history'][2][1]==6123
assert parsed['currentProbabilityBps']==6123 and parsed['sampledFrom']==41 and parsed['downsampled']
assert parsed['source']=='PROBABILITY' and parsed['endAt']-parsed['startAt']==3600000
for cut in range(len(frame)): assert reader(frame[:cut]) is None
for bad in (frame+'junk\n',frame.replace('GH2','GH1'),frame.replace('3601000','3601001'),
            frame.replace('\t6123\tPROBABILITY','\t10001\tPROBABILITY'),
            frame.replace('\t41\t1\t','\t1\t1\t'),frame.replace('\t1\t6123\t','\t2\t6123\t'),
            frame.replace('PROBABILITY','SMOOTHED'),frame.replace('1801000','-1'),
            frame.replace('END\t123','END\t124')):
    assert reader(bad) is None
print('Detail reader: GH2 exact 1H domain, BPS, coherent current, sampling metadata, ordering, truncation and footer checks passed.')
