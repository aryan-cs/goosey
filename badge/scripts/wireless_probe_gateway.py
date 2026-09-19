"""Public diagnostic bridge. NEVER accepts account tokens, passwords or orders.

A second badge runs goosey_relay_test and stays connected to this Mac. The
participant runs goosey_radio_test unplugged. A valid PING produces a public
backend health reply; successful reception does not establish authentication.
"""
import argparse
import json
import re
import time
from urllib.request import Request, build_opener
from urllib.error import URLError
from badge_console import Console
from usb_trading_gateway import NoRedirect

ROOT='/littlefs/appdata/goosey_relay_test/'
ORIGIN='https://getgoosey.vercel.app'
FRAME=re.compile(r'^([a-f0-9]{8})\|([a-f0-9]{8})\|PING$')

def parse(raw):
    matches=[FRAME.fullmatch(line) for line in raw.replace('\r','').split('\n')]
    matches=[m for m in matches if m]
    if len(matches)!=1:return None
    return matches[0].group(1),matches[0].group(2)

def health():
    try:
        with build_opener(NoRedirect()).open(Request(ORIGIN+'/api/health',headers={'Accept':'application/json'}),timeout=5) as response:
            raw=response.read(4097)
            if len(raw)>4096:return 'INVALID'
            data=json.loads(raw)
            return 'OK' if data.get('status')=='ok' and data.get('database')=='reachable' else 'NOT_READY'
    except (URLError,OSError,ValueError):return 'OFFLINE'

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port',required=True)
    args=p.parse_args()
    with Console(args.port) as console:
        console.cmd('')
        print('Relay connected. Open Goosey Wireless Test on the unplugged client and press A.',flush=True)
        while True:
            request=parse(console.cmd('cat '+ROOT+'rx.txt'))
            if request:
                route,mid=request
                result=health()
                body=f'{route}|{mid}|PONG backend {result}\n'.encode()
                # Preserve the request if writing the response fails; retry on restart.
                console.put(ROOT+'tx.txt',body)
                console.put(ROOT+'rx.txt',b'')
                print('Public health request relayed: '+result,flush=True)
            time.sleep(.25)

if __name__=='__main__':main()
