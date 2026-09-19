import importlib.util
import json
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cloud_snapshot', Path(__file__).resolve().parents[1] / 'scripts/cloud_snapshot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SnapshotTest(unittest.TestCase):
    def fetch(self, **changes):
        market = dict(slug='market-one', title='Is it happening?', probabilityYesBps=5123,
                      closesAt='2026-09-20T18:30:00.000Z', volumeMilli='12345', status='OPEN')
        market.update(changes)
        payloads = [{'items': [market], 'nextCursor': None}, {'snapshots': []}]
        with patch.object(module, 'urlopen', side_effect=lambda *a, **k: BytesIO(json.dumps(payloads.pop(0)).encode())):
            return module.fetch_snapshot('https://getgoosey.vercel.app')

    def test_database_values_and_empty_history(self):
        m = self.fetch()['markets'][0]
        self.assertEqual(m['probability'], 51.23)
        self.assertEqual(m['history'], [])
        self.assertEqual(m['volume'], '12')
        self.assertEqual(m['closes'], '09/20 18:30 UTC')

    def test_bad_probability_and_volume(self):
        for data in ({'probabilityYesBps': 10001}, {'probabilityYesBps': True}, {'volumeMilli': '-1'}):
            with self.assertRaises(ValueError): self.fetch(**data)

    def test_no_truncated_catalog(self):
        with patch.object(module, 'urlopen', return_value=BytesIO(b'{"items":[],"nextCursor":"another-page"}')):
            with self.assertRaises(ValueError): module.fetch_snapshot('https://getgoosey.vercel.app')

    def test_retired_dances_omit_only_when_paused_and_untouched(self):
        base = dict(slug='htn-2026-winner-first-dance-worm', title='Old dance',
                    probabilityYesBps=5000, closesAt='2026-09-20T18:30:00.000Z',
                    volumeMilli='0', traderCount=0, status='PAUSED')
        active = dict(base, slug='htn-2026-winning-team-worm', status='OPEN')
        for change, count in (({}, 1), ({'traderCount': 1}, 2), ({'volumeMilli': '1000'}, 2), ({'status': 'CLOSED'}, 2)):
            payloads = [{'items': [dict(base, **change), active], 'nextCursor': None}] + [{'snapshots': []}] * count
            with patch.object(module, 'urlopen', side_effect=lambda *a, **k: BytesIO(json.dumps(payloads.pop(0)).encode())):
                self.assertEqual(len(module.fetch_snapshot('https://getgoosey.vercel.app')['markets']), count)

    def test_reject_unsafe_origins(self):
        for origin in ('http://getgoosey.vercel.app', 'https://user:password@host', 'https://host/api'):
            with self.assertRaises(ValueError): module.fetch_snapshot(origin)

    def test_text_is_not_executable_lua(self):
        self.assertEqual(module.lua_literal('"; os.exit(); --'), '"\\"; os.exit(); --"')
        with self.assertRaises(ValueError): module.lua_literal('title\x01')


if __name__ == '__main__': unittest.main()
