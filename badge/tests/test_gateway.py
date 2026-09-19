import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import usb_trading_gateway as gateway

class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'state.json'
        self.config={'token':'1'*64,'trades':{}}
        self.g=gateway.Gateway('https://example.test',self.config,self.path)
        self.request=dict(id='1',challenge=self.g.challenge,kind='TRADE',slug='market-one',side='YES',action='BUY',quantity=1,quoteId='c123456789012345678901234',bound='50001')
    def tearDown(self):self.tmp.cleanup()
    def test_pending_restart_and_idempotent_receipt(self):
        def uncertain(*args):
            self.assertEqual(json.loads(self.path.read_text())['trades'][self.request['quoteId']]['status'],'PENDING')
            self.assertEqual(args[-1],'badge:'+self.request['quoteId'])
            raise OSError('response lost after server commit')
        with patch.object(gateway,'api',side_effect=uncertain):self.assertIn(b'\tPENDING\t',self.g.process(self.request))
        restored=gateway.Gateway('https://example.test',json.loads(self.path.read_text()),self.path)
        with patch.object(gateway,'api',return_value={'trade':{'id':'one'},'balanceMilli':'949999'}) as api:
            self.assertIn(b'\tDONE\t',restored.process(self.request))
            self.assertIn(b'\tDONE\t',restored.process(self.request))
            self.assertEqual(api.call_count,1)
        self.assertEqual(self.path.stat().st_mode & 0o777,0o600)
    def test_changed_request_never_retries_new_body(self):
        with patch.object(gateway,'api',side_effect=OSError()):self.g.process(self.request)
        with patch.object(gateway,'api') as api:
            self.assertIn(b'\tPENDING\t',self.g.process(dict(self.request,bound='999999')))
            api.assert_not_called()
    def test_wrong_account_never_trades(self):
        with patch.object(gateway,'api') as api:
            self.assertIn(b'\tPENDING\t',self.g.process(dict(self.request,challenge='b'*64)))
            api.assert_not_called()
    def test_auth_loss_is_not_definitive_rejection(self):
        with patch.object(gateway,'api',side_effect=gateway.APIError(401,'Revoked')):
            self.assertIn(b'\tPENDING\t',self.g.process(self.request))
            self.assertEqual(self.config['trades'][self.request['quoteId']]['status'],'PENDING')
    def test_frames(self):
        line='GQ1\t1\t'+'a'*64+'\tQUOTE\tmarket-one\tYES\tBUY\t1\t-\t0\tEND\n'
        self.assertEqual(gateway.parse_request('command\r\n'+line+'badge> ')['quantity'],1)
        self.assertIsNone(gateway.parse_request(line[:-5]))
        self.assertIsNone(gateway.parse_request(line.replace('\t1\t-','\t999\t-')))
        self.assertIsNone(gateway.parse_request(line+line))
        self.assertEqual(gateway.parse_detail_request('cat\r\nGD1\tmarket-one\nbadge> '),'market-one')
        self.assertIsNone(gateway.parse_detail_request('GD1\t../market\n'))
if __name__=='__main__':unittest.main()
