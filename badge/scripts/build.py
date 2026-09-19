import json
import argparse
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=root / 'badge/dist')
args = parser.parse_args()
# paper_v1 holds positions by index. Preserve its original catalog until a
# deliberate slug-based migration is implemented for the new upstream markets.
markets = json.loads((root / 'badge/catalog-v1.json').read_text())
assert len(markets) == 11
rows = []
for m in markets:
    rows.append('  {' + ','.join([json.dumps(m['shortTitle']), json.dumps(m['title']),
        str(m['qYes']), str(m['qNo']), str(m['orderBook']).lower(), json.dumps(m['slug'])]) + '},')
expected = json.loads((root / 'badge/market-order.json').read_text())
if [m['slug'] for m in markets] != expected:
    raise SystemExit('Market order changed: migrate paper_v1 before rebuilding')
code = (root / 'badge/src/main.lua').read_text().replace('__MARKETS__', '\n'.join(rows))
# Only remove full-line comments, blank lines and leading indentation. Keep
# literals and statement boundaries intact; smaller source reduces load buffers.
code = '\n'.join(line.lstrip() for line in code.splitlines()
                 if line.strip() and not line.lstrip().startswith('--')) + '\n'
manifest = 'slug=goosey_base\nname=Goosey\nicon=GSY\napi=2\nheap_kb=96\nversion=0.6.0\nauthor=Goosey\n'
out = args.output
out.mkdir(parents=True, exist_ok=True)
(out / 'goosey.lua').write_text('--[==[badge-app\n' + manifest + ']==]\n\n' + code)
(out / 'main.lua').write_text(code)
(out / 'manifest.cfg').write_text(manifest)
shutil.copyfile(root / 'public/brand/goosey-mark.png', out / 'goosey-logo.png')
(out / 'markets.json').write_text(json.dumps(markets, indent=2))
assert (out / 'goosey.lua').stat().st_size < 48 * 1024
print(f'Built {len(markets)} markets; bundle {(out / "goosey.lua").stat().st_size} bytes')
