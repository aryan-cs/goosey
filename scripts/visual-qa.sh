#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
PWCLI="/Users/aryan/.codex/skills/playwright/scripts/playwright_cli.sh"
SERVER_LOG="/tmp/goosey-visual-qa-server.log"

cd "$PROJECT_DIR"
mkdir -p output/playwright

npm start -- --hostname 127.0.0.1 --port 3000 >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  set +e
  "$PWCLI" close >/dev/null 2>&1
  kill "$SERVER_PID" >/dev/null 2>&1
  wait "$SERVER_PID" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

for attempt in {1..80}; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    sed -n '1,220p' "$SERVER_LOG"
    exit 1
  fi
  sleep 0.25
done

curl -fsS http://127.0.0.1:3000/api/health
"$PWCLI" open http://127.0.0.1:3000 --headed
"$PWCLI" screenshot --filename output/playwright/goosey-home-desktop.png --full-page --hires
"$PWCLI" goto http://127.0.0.1:3000/markets/closing-ceremony-on-time
"$PWCLI" screenshot --filename output/playwright/goosey-market-desktop.png --full-page --hires
"$PWCLI" resize 390 844
"$PWCLI" goto http://127.0.0.1:3000
"$PWCLI" screenshot --filename output/playwright/goosey-home-mobile.png --full-page --hires
"$PWCLI" goto http://127.0.0.1:3000/markets/closing-ceremony-on-time
"$PWCLI" screenshot --filename output/playwright/goosey-market-mobile.png --full-page --hires
