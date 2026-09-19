import json
import argparse
import shutil
from cloud_snapshot import fetch_snapshot, lua_literal
from pathlib import Path

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=root / 'badge/dist')
parser.add_argument('--cloud-url', help='Build a dated public database snapshot, without local trading')
args = parser.parse_args()
# Shared catalog with the web seed. A new save namespace prevents old indexed
# holdings from being interpreted as positions in these new questions.
selected = json.loads((root / 'prisma/selected-markets.json').read_text())
markets = [dict(slug=m['slug'], title=m['title'], shortTitle=m['shortTitle'],
                qYes=0, qNo=0, orderBook=False) for m in selected]
expected = json.loads((root / 'badge/market-order-v2.json').read_text())
assert len(markets) == len(expected) and all(m['openingProbability'] == 0.5 for m in selected)
rows = []
for m in markets:
    rows.append('  {' + ','.join([json.dumps(m['shortTitle']), json.dumps(m['title']),
        str(m['qYes']), str(m['qNo']), str(m['orderBook']).lower(), json.dumps(m['slug'])]) + '},')
if [m['slug'] for m in markets] != expected:
    raise SystemExit('Market order changed: migrate paper_v2 before rebuilding')
initial = json.loads((root / 'badge/market-order-v2-initial.json').read_text())
assert len(initial) == 3 and expected[:3] == initial, 'Legacy paper_v2 prefix must stay unchanged'
source = 'cloud_main.lua' if args.cloud_url else 'main.lua'
code = (root / 'badge/src' / source).read_text().replace('__MARKETS__', '\n'.join(rows))
snapshot = fetch_snapshot(args.cloud_url) if args.cloud_url else None
code = code.replace('__CLOUD__', lua_literal(snapshot) if snapshot else 'nil')
code = code.replace('__CLOUD_READER__', (root / 'badge/src/cloud_reader.lua').read_text() if snapshot else 'local readCloudFrame=nil')
# Only remove full-line comments, blank lines and leading indentation. Keep
# literals and statement boundaries intact; smaller source reduces load buffers.
code = '\n'.join(line.lstrip() for line in code.splitlines()
                 if line.strip() and not line.lstrip().startswith('--')) + '\n'
manifest = 'slug=goosey_base\nname=Goosey\nicon=GSY\napi=2\nheap_kb=96\nversion=0.10.0\nauthor=Goosey\n'
out = args.output
out.mkdir(parents=True, exist_ok=True)
(out / 'goosey.lua').write_text('--[==[badge-app\n' + manifest + ']==]\n\n' + code)
(out / 'main.lua').write_text(code)
(out / 'manifest.cfg').write_text(manifest)
shutil.copyfile(root / 'public/brand/goosey-mark.png', out / 'goosey-logo.png')
(out / 'markets.json').write_text(json.dumps(snapshot['markets'] if snapshot else markets, indent=2))
if snapshot:
    (out / 'snapshot.json').write_text(json.dumps(snapshot, indent=2))
assert (out / 'goosey.lua').stat().st_size < 48 * 1024
print(f'Built {len(markets)} markets; bundle {(out / "goosey.lua").stat().st_size} bytes')
