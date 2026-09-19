"""Fetch public Goosey data for an explicitly dated, read-only badge build.

No sessions, account balances, credentials or local practice data are exported.
"""
import json
import math
import re
import time
from datetime import datetime, timezone
from urllib.request import urlopen
from urllib.parse import urlparse, quote


FOUR_HOURS_MS = 14_400_000


def timestamp(value):
    return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)


def validated_origin(origin):
    parsed = urlparse(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('Cloud origin must be an HTTPS origin without credentials or a path')
    return origin.rstrip('/')


def public_json(origin, path):
    with urlopen(origin + path, timeout=15) as response:
        raw = response.read(262145)
    if len(raw) > 262144:
        raise ValueError('API response exceeds badge exporter limit')
    return json.loads(raw)


def _bounded_history(points, limit):
    if len(points) <= limit:
        return points
    chosen = {0, len(points) - 1}
    chosen.add(min(range(len(points)), key=lambda index: points[index][0]))
    chosen.add(max(range(len(points)), key=lambda index: points[index][0]))
    while len(chosen) < limit:
        ordered = sorted(chosen)
        best = None
        for left, right in zip(ordered, ordered[1:]):
            if right - left <= 1:
                continue
            start_probability, start_time = points[left]
            end_probability, end_time = points[right]
            for index in range(left + 1, right):
                probability, point_time = points[index]
                progress = 0 if end_time == start_time else (point_time - start_time) / (end_time - start_time)
                deviation = abs(probability - (start_probability + (end_probability - start_probability) * progress))
                candidate = (deviation, right - left, -index, index)
                if best is None or candidate > best:
                    best = candidate
        if best is None:
            break
        chosen.add(best[3])
    return [points[index] for index in sorted(chosen)]


def fetch_snapshot(origin, now=None):
    origin = validated_origin(origin)
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError('Snapshot time must include a timezone')
    now = now.astimezone(timezone.utc)
    range_end = int(now.timestamp() * 1000)
    range_start = range_end - FOUR_HOURS_MS
    catalog = public_json(origin, '/api/markets?limit=50')
    if catalog.get('nextCursor'):
        raise ValueError('Catalog has another page; refusing to silently omit markets')
    # Explicitly retired, untouched contracts remain in the database for audit.
    # Keep any with activity: never hide a participant's old contract/holdings.
    retired = {'htn-2026-winner-stage-dance'} | {
        'htn-2026-winner-first-dance-' + option for option in ('worm', 'dab', 'floss', 'none')
    }
    items = [market for market in catalog['items'] if not (
        market.get('slug') in retired and market.get('status') == 'PAUSED'
        and market.get('volumeMilli') == '0' and market.get('traderCount') == 0
    )]
    if not 1 <= len(items) <= 16:
        raise ValueError('Badge snapshot requires 1–16 markets; refusing a truncated catalog')
    point_limit = max(2, min(8, 96 // len(items)))
    result = []
    seen = set()
    for market in items:
        slug, title = market['slug'], market['title']
        short_title, category = market.get('shortTitle', title), market.get('category')
        if not isinstance(slug, str) or not 1 <= len(slug) <= 120 or slug in seen:
            raise ValueError('Invalid or duplicate market slug')
        seen.add(slug)
        if not isinstance(title, str) or not 1 <= len(title) <= 240:
            raise ValueError('Invalid market title')
        if not isinstance(short_title, str) or not 1 <= len(short_title) <= 160:
            raise ValueError('Invalid market short title')
        if not isinstance(category, str) or not 1 <= len(category) <= 40:
            raise ValueError('Invalid market category')
        bps = market['probabilityYesBps']
        if isinstance(bps, bool) or not isinstance(bps, int) or not 0 <= bps <= 10000:
            raise ValueError('Invalid probability')
        volume = market['volumeMilli']
        if not isinstance(volume, str) or not volume.isascii() or not volume.isdigit() or len(volume) > 16:
            raise ValueError('Invalid volume')
        accepting = market.get('acceptingOrders')
        if not isinstance(accepting, bool):
            raise ValueError('Invalid market tradability')
        raw_history = market.get('priceHistory')
        if not isinstance(raw_history, list) or len(raw_history) > 30:
            raise ValueError('Invalid market history')
        history = []
        all_history = []
        for point in raw_history:
            point_bps = point.get('probabilityYesBps') if isinstance(point, dict) else None
            if isinstance(point_bps, bool) or not isinstance(point_bps, int) or not 0 <= point_bps <= 10000:
                raise ValueError('Invalid market history probability')
            point_time = timestamp(point.get('timestamp', ''))
            if all_history and point_time < all_history[-1][1]:
                raise ValueError('Unordered market history')
            all_history.append([point_bps / 100, point_time])
            if range_start <= point_time <= range_end:
                history.append([point_bps / 100, point_time])
        history = _bounded_history(history, point_limit)
        previous = None
        if all_history:
            previous = all_history[-2][0] if len(all_history) > 1 and round(all_history[-1][0] * 100) == bps else all_history[-1][0]
        change_bps = None if previous is None else bps - round(previous * 100)
        whole_volume = (int(volume) + 500) // 1000
        result.append(dict(slug=slug, title=title, shortTitle=short_title, category=category,
                           probability=bps / 100, changeBps=change_bps,
                           history=history, volume=f'{whole_volume:,}', acceptingOrders=accepting,
                           closes=datetime.fromisoformat(market['closesAt'].replace('Z', '+00:00')).strftime('%m/%d %H:%M UTC'),
                           status=market['status']))
    return dict(origin=origin, generation=str(time.time_ns()), capturedAt=now.strftime('%m/%d %H:%M UTC'),
                rangeStart=range_start, rangeEnd=range_end, markets=result)


def fetch_market_history(origin, slug, limit=32):
    origin = validated_origin(origin)
    if not re.fullmatch(r'[a-z0-9-]{1,120}', slug) or not 1 <= limit <= 32:
        raise ValueError('Invalid detail history request')
    payload = public_json(origin, '/api/markets/' + quote(slug, safe='') + f'/history?range=4H&limit={limit}')
    if payload.get('range') != '4H' or not isinstance(payload.get('rangeStart'), str):
        raise ValueError('History response is missing its four-hour range')
    start = timestamp(payload['rangeStart'])
    end = start + 14_400_000
    history = payload.get('snapshots')
    if not isinstance(history, list) or len(history) > limit:
        raise ValueError('History exceeds requested bound')
    points = []
    for point in history:
        p = point.get('yesProbabilityBps')
        t = timestamp(point.get('createdAt', ''))
        if isinstance(p, bool) or not isinstance(p, int) or not 0 <= p <= 10000 or t > end or (points and t < points[-1][1]):
            raise ValueError('Invalid or unordered history')
        points.append([p / 100, t])
    return dict(generation=str(time.time_ns()), slug=slug, rangeStart=start, rangeEnd=end, history=points)


def detail_mailbox_frame(detail):
    generation = detail['generation']
    lines = [['GH1', generation, detail['slug'], str(detail['rangeStart']), str(detail['rangeEnd']), str(len(detail['history']))]]
    lines.extend(['H', str(t), str(round(p * 100))] for p, t in detail['history'])
    lines.append(['END', generation])
    data = ('\n'.join('\t'.join(row) for row in lines) + '\n').encode()
    if len(data) > 6000:
        raise ValueError('Detail history frame exceeds badge file limit')
    return data


def mailbox_frame(snapshot):
    generation = snapshot.get('generation', str(time.time_ns()))
    lines = [['GS2', generation, snapshot['capturedAt'], str(snapshot['rangeStart']), str(snapshot['rangeEnd']), str(len(snapshot['markets']))]]
    for m in snapshot['markets']:
        lines.append(['M', m['slug'], m['title'], m['shortTitle'], m['category'], str(round(m['probability'] * 100)),
                      '-' if m['changeBps'] is None else str(m['changeBps']), m['volume'], m['closes'], m['status'],
                      '1' if m['acceptingOrders'] else '0', str(len(m['history']))])
        lines.extend(['H', str(t), str(round(p * 100))] for p, t in m['history'])
    lines.append(['END', generation])
    for row in lines:
        for field in row:
            if any(ord(c) < 32 or ord(c) == 127 for c in field):
                raise ValueError('Control characters in mailbox frame')
    data = ('\n'.join('\t'.join(row) for row in lines) + '\n').encode()
    if len(data) > 16000:
        raise ValueError('Mailbox frame exceeds badge file limit')
    return data


def lua_literal(value):
    if value is None:
        return 'nil'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, str):
        # Lua accepts UTF-8, but not JSON's \u escape syntax.
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('Control characters are not allowed in snapshot text')
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return str(value)
    if isinstance(value, list):
        return '{' + ','.join(lua_literal(v) for v in value) + '}'
    if isinstance(value, dict):
        return '{' + ','.join('[' + lua_literal(k) + ']=' + lua_literal(v) for k, v in value.items()) + '}'
    raise ValueError('Unsupported snapshot value')
