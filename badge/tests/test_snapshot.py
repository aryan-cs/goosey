import importlib.util
import json
import unittest
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cloud_snapshot', Path(__file__).resolve().parents[1] / 'scripts/cloud_snapshot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SnapshotTest(unittest.TestCase):
    def fetch(self, **changes):
        market = dict(slug='market-one', title='Is it happening?', probabilityYesBps=5123,
                      shortTitle='Is it happening?', category='Hack the North', acceptingOrders=True,
                      closesAt='2026-09-20T18:30:00.000Z', volumeMilli='12345', status='OPEN',
                      priceHistory=[
                          {'timestamp':'2026-09-19T22:00:00.000Z','probabilityYesBps':5000},
                          {'timestamp':'2026-09-19T23:00:00.000Z','probabilityYesBps':5123},
                      ])
        market.update(changes)
        payload = {'items': [market], 'nextCursor': None}
        with patch.object(module, 'urlopen', return_value=BytesIO(json.dumps(payload).encode())):
            return module.fetch_snapshot('https://getgoosey.vercel.app', datetime(2026,9,20,tzinfo=timezone.utc))

    def test_database_values_and_real_bounded_history(self):
        m = self.fetch()['markets'][0]
        self.assertEqual(m['probability'], 51.23)
        self.assertEqual(m['history'], [[50,1789855200000],[51.23,1789858800000]])
        self.assertEqual(m['changeBps'], 123)
        self.assertEqual(m['category'], 'Hack the North')
        self.assertEqual(m['shortTitle'], 'Is it happening?')
        self.assertTrue(m['acceptingOrders'])
        self.assertEqual(m['volume'], '12')
        self.assertEqual(m['closes'], '09/20 18:30 UTC')

    def test_history_budget_scales_with_catalog(self):
        history=[{'timestamp':f'2026-09-19T{hour:02d}:00:00.000Z','probabilityYesBps':4000+hour*100} for hour in range(16,24)]
        catalog = [dict(slug=f'market-{i}',title='Market?',shortTitle='Market?',category='Other',probabilityYesBps=6300,
                        closesAt='2026-09-20T18:30:00.000Z',volumeMilli='0',status='OPEN',acceptingOrders=True,
                        priceHistory=history) for i in range(13)]
        paths=[]
        def get(url,**kwargs):
            paths.append(url)
            return BytesIO(json.dumps({'items':catalog}).encode())
        with patch.object(module,'urlopen',side_effect=get):
            result=module.fetch_snapshot('https://getgoosey.vercel.app',datetime(2026,9,20,tzinfo=timezone.utc))
        self.assertEqual(len(result['markets']),13)
        self.assertEqual(len(paths),1)
        self.assertTrue(all(2 <= len(m['history']) <= 7 for m in result['markets']))
        self.assertLessEqual(sum(len(m['history']) for m in result['markets']),96)
        self.assertTrue(all(m['history'][0][1] == 1789848000000 and m['history'][-1][1] == 1789858800000 for m in result['markets']))

    def test_selected_market_gets_real_four_hour_history(self):
        payload={'range':'4H','rangeStart':'2026-09-19T18:00:00.000Z','snapshots':[
            {'createdAt':'2026-09-19T17:00:00.000Z','yesProbabilityBps':5000},
            {'createdAt':'2026-09-19T20:00:00.000Z','yesProbabilityBps':6123},
        ]}
        with patch.object(module,'urlopen',return_value=BytesIO(json.dumps(payload).encode())) as get:
            detail=module.fetch_market_history('https://getgoosey.vercel.app','market-one')
        self.assertIn('/history?range=4H&limit=32',get.call_args.args[0])
        self.assertEqual(detail['rangeEnd']-detail['rangeStart'],14_400_000)
        self.assertEqual(detail['history'],[[50,1789837200000],[61.23,1789848000000]])
        self.assertIn('\tmarket-one\t',module.detail_mailbox_frame(detail).decode())

    def test_selected_history_rejects_wrong_range(self):
        payload={'range':'1D','rangeStart':'2026-09-19T18:00:00.000Z','snapshots':[]}
        with patch.object(module,'urlopen',return_value=BytesIO(json.dumps(payload).encode())):
            with self.assertRaises(ValueError): module.fetch_market_history('https://getgoosey.vercel.app','market-one')

    def test_bad_probability_and_volume(self):
        for data in ({'probabilityYesBps': 10001}, {'probabilityYesBps': True}, {'volumeMilli': '-1'}):
            with self.assertRaises(ValueError): self.fetch(**data)

    def test_bad_catalog_metadata_and_history(self):
        for data in ({'category': ''}, {'shortTitle': ''}, {'acceptingOrders': 'yes'},
                     {'priceHistory': [{'timestamp':'2026-09-19T23:00:00.000Z','probabilityYesBps':10001}]},
                     {'priceHistory': [
                         {'timestamp':'2026-09-19T23:00:00.000Z','probabilityYesBps':5000},
                         {'timestamp':'2026-09-19T22:00:00.000Z','probabilityYesBps':5000},
                     ]}):
            with self.assertRaises(ValueError): self.fetch(**data)

    def test_no_truncated_catalog(self):
        with patch.object(module, 'urlopen', return_value=BytesIO(b'{"items":[],"nextCursor":"another-page"}')):
            with self.assertRaises(ValueError): module.fetch_snapshot('https://getgoosey.vercel.app')

    def test_retired_dances_omit_only_when_paused_and_untouched(self):
        base = dict(slug='htn-2026-winner-first-dance-worm', title='Old dance', shortTitle='Old dance', category='Hack the North',
                    probabilityYesBps=5000, closesAt='2026-09-20T18:30:00.000Z',
                    volumeMilli='0', traderCount=0, status='PAUSED', acceptingOrders=False, priceHistory=[])
        active = dict(base, slug='htn-2026-winning-team-worm', status='OPEN')
        for change, count in (({}, 1), ({'traderCount': 1}, 2), ({'volumeMilli': '1000'}, 2), ({'status': 'CLOSED'}, 2)):
            payloads = [{'items': [dict(base, **change), active], 'nextCursor': None}]
            with patch.object(module, 'urlopen', side_effect=lambda *a, **k: BytesIO(json.dumps(payloads.pop(0)).encode())):
                self.assertEqual(len(module.fetch_snapshot('https://getgoosey.vercel.app')['markets']), count)

    def test_reject_unsafe_origins(self):
        for origin in ('http://getgoosey.vercel.app', 'https://user:password@host', 'https://host/api'):
            with self.assertRaises(ValueError): module.fetch_snapshot(origin)

    def test_text_is_not_executable_lua(self):
        self.assertEqual(module.lua_literal('"; os.exit(); --'), '"\\"; os.exit(); --"')
        self.assertEqual(module.lua_literal(True), 'true')
        self.assertEqual(module.lua_literal(False), 'false')
        self.assertEqual(module.lua_literal(None), 'nil')
        with self.assertRaises(ValueError): module.lua_literal('title\x01')


if __name__ == '__main__': unittest.main()
