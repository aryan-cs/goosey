"""Public market sync for one USB-connected badge. Never sends account data.

Run after installing a --cloud-url build. Close the browser serial connection
first. USB CDC must already expose the normal badge console (not bootloader).
"""
import argparse
import time
from badge_console import Console
from cloud_snapshot import fetch_snapshot, mailbox_frame


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', required=True)
    parser.add_argument('--origin', default='https://getgoosey.vercel.app')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--interval', type=int, default=30)
    args = parser.parse_args()
    if args.interval < 15:
        parser.error('Use an interval of at least 15 seconds to bound flash writes')
    # Fail before opening USB if the server is unavailable or invalid.
    snapshot = fetch_snapshot(args.origin)
    with Console(args.port) as console:
        console.cmd('')
        response = console.cmd('mkdir /littlefs/appdata/goosey_base')
        while True:
            frame = mailbox_frame(snapshot)
            console.put('/littlefs/appdata/goosey_base/market_snapshot.txt', frame)
            console.put('/littlefs/appdata/goosey_base/market_generation.txt', snapshot['generation'].encode())
            print(f"Updated {len(snapshot['markets'])} public markets ({len(frame)} bytes), {snapshot['capturedAt']}", flush=True)
            if args.once:
                return
            time.sleep(args.interval)
            # Fetch failure leaves the last complete snapshot intact. Reconnect
            # by rerunning; the badge marks the snapshot stale after 45 seconds.
            snapshot = fetch_snapshot(args.origin)


if __name__ == '__main__':
    main()
