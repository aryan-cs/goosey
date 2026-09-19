"""Single-badge USB gateway. Private bearer keys NEVER enter shared app files.

Approve the displayed /badge# link once in your own website session. This process
must keep running for quotes/trades. Pending confirmations use durable, immutable
requests and server idempotency keys; restarting cannot duplicate a fill.
"""
from concurrent.futures import ThreadPoolExecutor
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import time
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.parse import urlparse, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from badge_console import Console
from cloud_snapshot import detail_mailbox_frame, fetch_market_history, fetch_snapshot, mailbox_frame
from pairing_qr import make_qr

PRIVATE = '/littlefs/appdata/goosey_base/'
HEX = re.compile(r'^[a-f0-9]{64}$')

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        # Never forward an authenticated request to a redirected destination.
        return None

class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message

def clean(value, limit=64):
    return re.sub(r'[^ -~]', ' ', str(value)).replace('\t',' ')[:limit] or '-'

def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f);f.flush();os.fsync(f.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)

def api(origin, token, path, body=None, key=None):
    headers = {'Authorization':'Bearer '+token, 'Accept':'application/json'}
    if body is not None: headers['Content-Type']='application/json'
    if key: headers['Idempotency-Key']=key
    request = Request(origin+'/api/badge/'+path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        with build_opener(NoRedirect()).open(request, timeout=12) as response:
            raw=response.read(262145)
            if len(raw)>262144: raise ValueError('Oversized API response')
            return json.loads(raw)
    except HTTPError as error:
        try: message=json.loads(error.read(8192)).get('error',{}).get('message','Request rejected')
        except (ValueError, AttributeError): message='Request rejected'
        raise APIError(error.code, clean(message)) from None

def parse_request(raw):
    # Console output includes its command echo and prompt; only full frames count.
    lines=[line for line in raw.replace('\r','').split('\n') if line.startswith('GQ1\t')]
    if len(lines)!=1: return None
    parts=lines[0].split('\t')
    if len(parts)!=11 or parts[-1]!='END': return None
    _,rid,challenge,kind,slug,side,action,quantity,qid,bound,_=parts
    if not rid.isdigit() or len(rid)>10 or not HEX.fullmatch(challenge): return None
    if kind not in ('QUOTE','TRADE') or not re.fullmatch(r'[a-z0-9-]{1,160}',slug): return None
    if side not in ('YES','NO') or action not in ('BUY','SELL') or not quantity.isdigit() or not 1<=int(quantity)<=20: return None
    if kind=='TRADE' and (not re.fullmatch(r'c[a-z0-9]{20,40}',qid) or not re.fullmatch(r'\d{1,18}',bound)): return None
    return dict(id=rid,challenge=challenge,kind=kind,slug=slug,side=side,action=action,quantity=int(quantity),quoteId=qid,bound=bound)

def parse_detail_request(raw):
    lines=[line for line in raw.replace('\r','').split('\n') if line.startswith('GD1\t')]
    if len(lines)!=1: return None
    parts=lines[0].split('\t')
    return parts[1] if len(parts)==2 and re.fullmatch(r'[a-z0-9-]{1,120}',parts[1]) else None

def response_frame(request, state, message='-', qid='-', amount='0', fee='0', ttl=0):
    return ('\t'.join(['GR1',request['id'],request['challenge'],state,qid,str(amount),str(fee),str(ttl),clean(message),'END'])+'\n').encode()

class Gateway:
    def __init__(self, origin, config, path):
        self.origin,self.config,self.path=origin,config,path
        self.token=config['token']
        self.challenge=hashlib.sha256(self.token.encode()).hexdigest()
        self.cached_request=None;self.cached_response=None

    def process(self, request):
        if request['challenge']!=self.challenge:
            # May be a confirmation from a previously linked owner. Never execute it.
            return response_frame(request,'PENDING','Account changed. Check trade on website.')
        if request==self.cached_request and self.cached_response is not None:
            return self.cached_response
        if request['kind']=='QUOTE':
            try:
                q=api(self.origin,self.token,'markets/'+quote(request['slug'],safe='')+'/quote',
                      {k:request[k] for k in ('side','action','quantity')})
                remaining=int((datetime.fromisoformat(q['expiresAt'].replace('Z','+00:00'))-datetime.now(timezone.utc)).total_seconds())-2
                amount=q['totalDebitMilli'] if request['action']=='BUY' else q['netCreditMilli']
                frame=response_frame(request,'QUOTE',qid=q['quoteId'],amount=amount,fee=q['feeMilli'],ttl=max(0,min(25,remaining)))
            except APIError as error: frame=response_frame(request,'ERROR',error.message)
            except (OSError,ValueError,KeyError): frame=response_frame(request,'ERROR','Network unavailable. Request a fresh quote.')
            self.cached_request,self.cached_response=request,frame
            return frame
        # A confirmation is journaled BEFORE any network call. Never alter the body
        # after an uncertain timeout, even if the badge request file is modified.
        qid=request['quoteId']
        body={'quoteId':qid, 'maxDebitMilli' if request['action']=='BUY' else 'minCreditMilli':request['bound']}
        journal=self.config.setdefault('trades',{})
        entry=journal.get(qid)
        if entry and (entry['body']!=body or entry['slug']!=request['slug']):
            return response_frame(request,'PENDING','Confirmation mismatch. Check website.')
        if entry is None:
            entry={'body':body,'slug':request['slug'],'status':'PENDING'}
            journal[qid]=entry;atomic_json(self.path,self.config)
        if entry['status'] in ('DONE','ERROR'):
            return response_frame(request,entry['status'],entry['message'])
        try:
            receipt=api(self.origin,self.token,'markets/'+quote(entry['slug'],safe='')+'/trades',entry['body'],'badge:'+qid)
            entry.update(status='DONE',message='Trade complete',receipt=receipt)
        except APIError as error:
            # Auth loss/server/rate errors do not establish whether an earlier
            # attempt committed. Only a definitive business rejection is final.
            if error.status in (400,404,409,422): entry.update(status='ERROR',message=error.message)
            else: return response_frame(request,'PENDING','Waiting for receipt. Keep USB connected.')
        except (OSError,ValueError):
            return response_frame(request,'PENDING','Waiting for receipt. Keep USB connected.')
        atomic_json(self.path,self.config)
        return response_frame(request,entry['status'],entry['message'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',required=True)
    parser.add_argument('--origin',default='https://getgoosey.vercel.app')
    parser.add_argument('--state-dir',type=Path,default=Path(__file__).resolve().parents[2]/'output/badge-gateway')
    parser.add_argument('--new-link',action='store_true',help='Rotate expired/revoked access. Refuses unresolved trades.')
    args=parser.parse_args()
    origin=args.origin.rstrip('/')
    parsed=urlparse(origin)
    if parsed.scheme!='https' or not parsed.netloc or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        parser.error('Origin must be an HTTPS origin with no credentials/path')
    with Console(args.port) as console:
        console.cmd('')
        output=console.cmd('cat '+PRIVATE+'device_id.txt')
        ids=[s[4:] for s in output.replace('\r','').split('\n') if s.startswith('GB1\t')]
        if len(ids)!=1 or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',ids[0]):
            raise SystemExit('Open the new Goosey app first so it can identify this USB badge.')
        identity=ids[0]
        path=args.state_dir/(hashlib.sha256((origin+'|'+identity).encode()).hexdigest()[:24]+'.json')
        config=json.loads(path.read_text()) if path.exists() else {'origin':origin,'badge':identity,'token':secrets.token_hex(32),'trades':{}}
        if config['origin']!=origin or config['badge']!=identity or not HEX.fullmatch(config['token']): raise SystemExit('Invalid gateway identity configuration')
        if args.new_link:
            if any(t['status']=='PENDING' for t in config.get('trades',{}).values()): raise SystemExit('Resolve pending trades before changing accounts.')
            # Keep prior receipts locally for audit; never lose an uncertain order.
            atomic_json(path.with_suffix('.previous.json'),config)
            config={'origin':origin,'badge':identity,'token':secrets.token_hex(32),'trades':{}}
        atomic_json(path,config)
        gateway=Gateway(origin,config,path)
        # Public QR is guarded by a private per-device stamp; copied app assets cannot
        # display someone else's pairing challenge on another badge.
        console.put(PRIVATE+'qr_challenge.txt',b'')
        console.put('/littlefs/apps/goosey_base/pairing.bin',make_qr(origin,gateway.challenge))
        console.put(PRIVATE+'qr_challenge.txt',gateway.challenge.encode())
        print('Scan the badge QR or open this link and approve the matching code:',flush=True)
        print(origin+'/badge#'+gateway.challenge,flush=True)
        account_at=market_at=detail_at=0;last_response=None;last_auth=None;detail_slug=None
        workers=ThreadPoolExecutor(max_workers=2);snapshot_job=detail_job=None
        while True:
            now=time.monotonic()
            if now>=account_at:
                account_at=now+10
                try:
                    account=api(origin,gateway.token,'account')
                    name=account['username'];balance=str(account['balanceMilli'])
                    if not re.fullmatch(r'[a-z0-9_]{3,24}',name) or not re.fullmatch(r'\d{1,18}',balance): raise ValueError('Invalid account')
                    state='READY'
                except APIError as error:
                    state='LINK' if error.status==401 else 'OFFLINE';name='-';balance='0'
                except (OSError,ValueError,KeyError): state='OFFLINE';name='-';balance='0'
                generation=str(time.time_ns())
                frame='\t'.join(['GA1',generation,gateway.challenge,state,name,balance,'END'])+'\n'
                console.put(PRIVATE+'account.txt',frame.encode())
                if state!=last_auth: print('Account '+state.lower(),flush=True);last_auth=state
            # Trade requests take priority over downloading public chart histories.
            request=parse_request(console.cmd('cat '+PRIVATE+'request.txt'))
            if request:
                response=gateway.process(request)
                if response!=last_response:
                    console.put(PRIVATE+'response.txt',response);last_response=response
                    if b'\tDONE\t' in response: account_at=0
            requested_slug=parse_detail_request(console.cmd('cat '+PRIVATE+'detail_request.txt'))
            if requested_slug and requested_slug!=detail_slug:
                detail_slug=requested_slug;detail_at=0
            if snapshot_job is not None and snapshot_job.done():
                try:
                    snapshot=snapshot_job.result()
                    console.put(PRIVATE+'market_snapshot.txt',mailbox_frame(snapshot))
                    console.put(PRIVATE+'market_generation.txt',snapshot['generation'].encode())
                except (OSError,ValueError): print('Market update unavailable; keeping previous snapshot.',flush=True)
                snapshot_job=None
            if detail_job is not None and detail_job.done():
                try:
                    detail=detail_job.result()
                    if detail['slug']==detail_slug: console.put(PRIVATE+'detail_history.txt',detail_mailbox_frame(detail))
                except (OSError,ValueError): print('Four-hour history unavailable; keeping previous detail.',flush=True)
                detail_job=None
            if now>=market_at and snapshot_job is None and not (request and request['kind']=='TRADE'):
                market_at=now+30
                snapshot_job=workers.submit(fetch_snapshot,origin)
            if detail_slug and now>=detail_at and detail_job is None and not (request and request['kind']=='TRADE'):
                detail_at=now+30
                detail_job=workers.submit(fetch_market_history,origin,detail_slug)
            time.sleep(2)

if __name__=='__main__': main()
