#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
PORT=3100
ORIGIN="http://127.0.0.1:${PORT}"
RUN_DIR="$(mktemp -d /tmp/goosey-e2e.XXXXXX)"
DB_FILE="${RUN_DIR}/goosey.db"
COOKIE_JAR="${RUN_DIR}/cookies.txt"
COOKIE_JAR_TWO="${RUN_DIR}/cookies-two.txt"
COOKIE_JAR_ADMIN="${RUN_DIR}/cookies-admin.txt"
COOKIE_JAR_EXTRA="${RUN_DIR}/cookies-extra.txt"
SERVER_LOG="${RUN_DIR}/server.log"

cd "$PROJECT_DIR"
cp prisma/dev.db "$DB_FILE"

DATABASE_PROVIDER="sqlite" DATABASE_URL="file:${DB_FILE}" APP_URL="$ORIGIN" NEXT_PUBLIC_APP_URL="$ORIGIN" RATE_LIMIT_KEY_SECRET="$(openssl rand -hex 32)" npm start -- --hostname 127.0.0.1 --port "$PORT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  local exit_code=$?
  set +e
  kill "$SERVER_PID" >/dev/null 2>&1
  wait "$SERVER_PID" >/dev/null 2>&1
  if (( exit_code != 0 )); then
    print -u2 -- "Goosey API E2E server log:"
    sed -n '1,260p' "$SERVER_LOG" >&2
  fi
  rm -rf "$RUN_DIR"
  return "$exit_code"
}
trap cleanup EXIT INT TERM

for attempt in {1..80}; do
  curl -fsS "$ORIGIN/api/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" >/dev/null 2>&1 || { sed -n '1,220p' "$SERVER_LOG"; exit 1; }
  sleep 0.25
done

EMAIL="smoke-${RANDOM}-$$@uwaterloo.ca"
USERNAME="smoke_${RANDOM}_$$"
REGISTER=$(curl -fsS -c "$COOKIE_JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"username\":\"$USERNAME\",\"displayName\":\"Smoke Forecaster\",\"password\":\"CorrectHorseBattery42!\",\"acceptedCodeOfConduct\":true}" "$ORIGIN/api/auth/register")
[[ "$(jq -r '.balanceMilli' <<<"$REGISTER")" == "0" ]]
[[ "$(jq -r '.emailVerification.required' <<<"$REGISTER")" == "true" ]]
[[ "$(curl -sS -o "${RUN_DIR}/unverified-portfolio.json" -w '%{http_code}' -b "$COOKIE_JAR" "$ORIGIN/api/portfolio")" == "403" ]]
jq -e '.error.code == "EMAIL_VERIFICATION_REQUIRED"' "${RUN_DIR}/unverified-portfolio.json" >/dev/null
INVALID_VERIFY=$(curl -sS -o "${RUN_DIR}/invalid-verify.json" -w '%{http_code}' -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"token":"not-a-valid-token"}' "$ORIGIN/api/auth/email-verification/confirm")
[[ "$INVALID_VERIFY" == "400" ]]
jq -e '.error.code == "INVALID_OR_EXPIRED_TOKEN"' "${RUN_DIR}/invalid-verify.json" >/dev/null
EMAIL_UNAVAILABLE=$(curl -sS -o "${RUN_DIR}/email-unavailable.json" -w '%{http_code}' -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}" "$ORIGIN/api/auth/password-reset/request")
[[ "$EMAIL_UNAVAILABLE" == "503" ]]
jq -e '.error.code == "EMAIL_UNAVAILABLE"' "${RUN_DIR}/email-unavailable.json" >/dev/null
VERIFY_TOKEN=$(DATABASE_URL="file:${DB_FILE}" npx tsx scripts/setup-e2e-verification.ts "$EMAIL")
curl -fsS -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"token\":\"$VERIFY_TOKEN\"}" "$ORIGIN/api/auth/email-verification/confirm" | jq -e '.verified == true and .welcomeGrantIssued == true' >/dev/null
curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/me" | jq -e '.balanceMilli == "10000000"' >/dev/null

MARKETS=$(curl -fsS "$ORIGIN/api/markets?limit=1")
MARKET_ID=$(jq -r '.items[0].id' <<<"$MARKETS")
MARKET_SLUG=$(jq -r '.items[0].slug' <<<"$MARKETS")
EVENTS=$(curl -fsS "$ORIGIN/api/events?timing=all&limit=10")
jq -e '.items | (length >= 2 and all(.[]; .markets | length > 0))' <<<"$EVENTS" >/dev/null
[[ "$(jq -r '.items[0] | has("createdById") or has("version")' <<<"$EVENTS")" == "false" ]]
curl -fsS "$ORIGIN/api/events/hack-the-north-finals" | jq -e '.event.markets | length == 7' >/dev/null
curl -fsS "$ORIGIN/api/search?q=finalist&limit=5" | jq -e '.markets | length > 0' >/dev/null
curl -fsS "$ORIGIN/api/calendar" | jq -e '(.events | length) > 0 and (.markets | length) > 0' >/dev/null
curl -fsS "$ORIGIN/api/discovery" | jq -e '(.trending | length) > 0 and (.newest | length) > 0 and (.closingSoon | length) > 0' >/dev/null

curl -fsS -c "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"email":"invite-fixture-admin@goosey.test","password":"Invite-fixture-password-only"}' "$ORIGIN/api/auth/login" | jq -e '.user.role == "ADMIN"' >/dev/null
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "$ORIGIN/api/admin/audit-logs")" == "403" ]]
curl -fsS -b "$COOKIE_JAR_ADMIN" "$ORIGIN/api/admin/audit-logs?limit=10" | jq -e '.items | type == "array"' >/dev/null
EVENT_KEY="smoke-event-${RANDOM}-$$"
EVENT_SLUG="smoke-event-${RANDOM}-$$"
EVENT_BODY="{\"slug\":\"$EVENT_SLUG\",\"title\":\"API smoke test forecast collection\",\"shortTitle\":\"Smoke collection\",\"description\":\"A temporary event created in the isolated API integration database.\",\"category\":\"Testing\",\"featured\":false,\"color\":\"gold\",\"icon\":\"sparkles\",\"startsAt\":\"2030-09-18T10:00:00.000Z\",\"endsAt\":\"2030-09-19T10:00:00.000Z\"}"
NONADMIN_EVENT=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -H "Origin: $ORIGIN" -H 'Idempotency-Key: unauthorized-event' -H 'Content-Type: application/json' -d "$EVENT_BODY" "$ORIGIN/api/admin/events")
[[ "$NONADMIN_EVENT" == "403" ]]
CREATED_EVENT=$(curl -fsS -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H "Idempotency-Key: $EVENT_KEY" -H 'Content-Type: application/json' -d "$EVENT_BODY" "$ORIGIN/api/admin/events")
REPLAYED_EVENT=$(curl -fsS -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H "Idempotency-Key: $EVENT_KEY" -H 'Content-Type: application/json' -d "$EVENT_BODY" "$ORIGIN/api/admin/events")
EVENT_ID=$(jq -r '.event.id' <<<"$CREATED_EVENT")
[[ "$EVENT_ID" == "$(jq -r '.event.id' <<<"$REPLAYED_EVENT")" ]]
[[ "$(jq -r '.replayed' <<<"$REPLAYED_EVENT")" == "true" ]]
curl -fsS -b "$COOKIE_JAR_ADMIN" -X PATCH -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"expectedVersion":0,"shortTitle":"Updated smoke collection"}' "$ORIGIN/api/admin/events/$EVENT_ID" | jq -e '.event.version == 1 and .event.shortTitle == "Updated smoke collection"' >/dev/null
EVENT_CONFLICT=$(curl -sS -o "${RUN_DIR}/event-conflict.json" -w '%{http_code}' -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H "Idempotency-Key: $EVENT_KEY" -H 'Content-Type: application/json' -d "${EVENT_BODY/Smoke collection/Different collection}" "$ORIGIN/api/admin/events")
[[ "$EVENT_CONFLICT" == "409" ]]
jq -e '.error.code == "IDEMPOTENCY_CONFLICT"' "${RUN_DIR}/event-conflict.json" >/dev/null

ADMIN_MARKET_KEY="smoke-admin-market-${RANDOM}-$$"
ADMIN_MARKET_SLUG="smoke-admin-market-${RANDOM}-$$"
ADMIN_MARKET_BODY="{\"slug\":\"$ADMIN_MARKET_SLUG\",\"title\":\"Will the isolated API smoke market resolve correctly?\",\"shortTitle\":\"Smoke market resolves?\",\"description\":\"A temporary ungrouped contract used to verify event membership behavior.\",\"rules\":\"Resolves YES only when the isolated API smoke assertions all complete successfully.\",\"resolutionSource\":\"Automated API integration test output\",\"category\":\"Testing\",\"status\":\"OPEN\",\"featured\":false,\"color\":\"blue\",\"icon\":\"sparkles\",\"closesAt\":\"2030-09-18T20:00:00.000Z\",\"resolvesAt\":\"2030-09-18T22:00:00.000Z\",\"liquidityParameter\":40,\"payoutMilli\":\"100000\",\"feeBps\":0}"
CREATED_MARKET=$(curl -fsS -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H "Idempotency-Key: $ADMIN_MARKET_KEY" -H 'Content-Type: application/json' -d "$ADMIN_MARKET_BODY" "$ORIGIN/api/admin/markets")
ADMIN_MARKET_ID=$(jq -r '.market.id' <<<"$CREATED_MARKET")
curl -fsS -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"expectedMarketVersion":0,"expectedEventVersion":1}' "$ORIGIN/api/admin/events/$EVENT_ID/markets/$ADMIN_MARKET_ID/attach" | jq -e --arg event "$EVENT_ID" '.market.eventId == $event and .market.version == 1 and .eventVersion == 2 and .replayed == false' >/dev/null
curl -fsS -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"expectedMarketVersion":0,"expectedEventVersion":1}' "$ORIGIN/api/admin/events/$EVENT_ID/markets/$ADMIN_MARKET_ID/attach" | jq -e '.market.version == 1 and .eventVersion == 2 and .replayed == true' >/dev/null
curl -fsS "$ORIGIN/api/events/$EVENT_SLUG" | jq -e --arg slug "$ADMIN_MARKET_SLUG" '.event.markets | any(.[]; .slug == $slug)' >/dev/null
STALE_ATTACH=$(curl -sS -o "${RUN_DIR}/stale-attach.json" -w '%{http_code}' -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"expectedMarketVersion":0,"expectedEventVersion":2}' "$ORIGIN/api/admin/events/$EVENT_ID/markets/$ADMIN_MARKET_ID/detach")
[[ "$STALE_ATTACH" == "409" ]]
jq -e '.error.code == "STALE_MARKET_VERSION"' "${RUN_DIR}/stale-attach.json" >/dev/null
STALE_EVENT=$(curl -sS -o "${RUN_DIR}/stale-event.json" -w '%{http_code}' -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"expectedMarketVersion":1,"expectedEventVersion":1}' "$ORIGIN/api/admin/events/$EVENT_ID/markets/$ADMIN_MARKET_ID/detach")
[[ "$STALE_EVENT" == "409" ]]
jq -e '.error.code == "STALE_EVENT_VERSION"' "${RUN_DIR}/stale-event.json" >/dev/null
curl -fsS -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"expectedMarketVersion":1,"expectedEventVersion":2}' "$ORIGIN/api/admin/events/$EVENT_ID/markets/$ADMIN_MARKET_ID/detach" | jq -e '.market.eventId == null and .market.version == 2 and .eventVersion == 3 and .replayed == false' >/dev/null
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "$ORIGIN/api/events/$EVENT_SLUG")" == "404" ]]

UNAUTH_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"side":"YES","action":"BUY","quantity":1}' "$ORIGIN/api/markets/$MARKET_SLUG/quote")
[[ "$UNAUTH_CODE" == "401" ]]

QUOTE=$(curl -fsS -b "$COOKIE_JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"side":"YES","action":"BUY","quantity":2}' "$ORIGIN/api/markets/$MARKET_SLUG/quote")
QUOTE_ID=$(jq -r '.quoteId' <<<"$QUOTE")
VERSION=$(jq -r '.marketVersion' <<<"$QUOTE")
MAX_DEBIT=$(jq -r '.totalDebitMilli' <<<"$QUOTE")
TRADE_KEY="smoke-trade-${RANDOM}-$$"
TRADE_BODY="{\"quoteId\":\"$QUOTE_ID\",\"marketVersion\":$VERSION,\"maxDebitMilli\":\"$MAX_DEBIT\"}"
TRADE=$(curl -fsS -b "$COOKIE_JAR" -H "Origin: $ORIGIN" -H "Idempotency-Key: $TRADE_KEY" -H 'Content-Type: application/json' -d "$TRADE_BODY" "$ORIGIN/api/markets/$MARKET_SLUG/trades")
REPLAY=$(curl -fsS -b "$COOKIE_JAR" -H "Origin: $ORIGIN" -H "Idempotency-Key: $TRADE_KEY" -H 'Content-Type: application/json' -d "$TRADE_BODY" "$ORIGIN/api/markets/$MARKET_SLUG/trades")
[[ "$(jq -r '.trade.id' <<<"$TRADE")" == "$(jq -r '.trade.id' <<<"$REPLAY")" ]]
HISTORY=$(curl -fsS "$ORIGIN/api/markets/$MARKET_SLUG/history?range=ALL&limit=20")
jq -e --arg executedAt "$(jq -r '.trade.createdAt' <<<"$TRADE")" '
  (.snapshots | length) >= 2 and
  .downsampled == false and
  .sampledFrom == (.snapshots | length) and
  (.snapshots[-1].createdAt == $executedAt) and
  (.snapshots[-1].yesProbabilityBps != .snapshots[0].yesProbabilityBps)
' <<<"$HISTORY" >/dev/null

PORTFOLIO=$(curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/portfolio")
[[ "$(jq -r '.positions | length' <<<"$PORTFOLIO")" == "1" ]]
NOTIFICATIONS=$(curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/notifications")
[[ "$(jq -r '.unreadCount' <<<"$NOTIFICATIONS")" == "1" ]]
[[ "$(jq -r '.items[0].type' <<<"$NOTIFICATIONS")" == "TRADE_CONFIRMED" ]]
curl -fsS -b "$COOKIE_JAR" -X PATCH -H "Origin: $ORIGIN" "$ORIGIN/api/notifications" | jq -e '.markedRead == 1' >/dev/null

COMMENT_KEY="smoke-comment-${RANDOM}-$$"
COMMENT_BODY='{"body":"The published ceremony schedule and organizer stage timestamp make this objectively resolvable.","parentId":null}'
COMMENT=$(curl -fsS -b "$COOKIE_JAR" -H "Origin: $ORIGIN" -H "Idempotency-Key: $COMMENT_KEY" -H 'Content-Type: application/json' -d "$COMMENT_BODY" "$ORIGIN/api/markets/$MARKET_SLUG/comments")
COMMENT_REPLAY=$(curl -fsS -b "$COOKIE_JAR" -H "Origin: $ORIGIN" -H "Idempotency-Key: $COMMENT_KEY" -H 'Content-Type: application/json' -d "$COMMENT_BODY" "$ORIGIN/api/markets/$MARKET_SLUG/comments")
[[ "$(jq -r '.comment.id' <<<"$COMMENT")" == "$(jq -r '.comment.id' <<<"$COMMENT_REPLAY")" ]]
COMMENT_ID=$(jq -r '.comment.id' <<<"$COMMENT")

EMAIL_TWO="smoke-two-${RANDOM}-$$@uwaterloo.ca"
USERNAME_TWO="smoke_two_${RANDOM}_$$"
curl -fsS -c "$COOKIE_JAR_TWO" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL_TWO\",\"username\":\"$USERNAME_TWO\",\"displayName\":\"Second Forecaster\",\"password\":\"CorrectHorseBattery43!\",\"acceptedCodeOfConduct\":true}" "$ORIGIN/api/auth/register" | jq -e '.balanceMilli == "0" and .emailVerification.required == true' >/dev/null
VERIFY_TOKEN_TWO=$(DATABASE_URL="file:${DB_FILE}" npx tsx scripts/setup-e2e-verification.ts "$EMAIL_TWO")
curl -fsS -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"token\":\"$VERIFY_TOKEN_TWO\"}" "$ORIGIN/api/auth/email-verification/confirm" | jq -e '.verified == true and .welcomeGrantIssued == true' >/dev/null
OTHER_EDIT=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR_TWO" -X PATCH -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"body":"Unauthorized edit attempt."}' "$ORIGIN/api/comments/$COMMENT_ID")
[[ "$OTHER_EDIT" == "403" ]]
OTHER_DELETE=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR_TWO" -X DELETE -H "Origin: $ORIGIN" "$ORIGIN/api/comments/$COMMENT_ID")
[[ "$OTHER_DELETE" == "403" ]]
curl -fsS -b "$COOKIE_JAR" -X PATCH -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"body":"The published organizer schedule and stage timestamp make this objectively resolvable."}' "$ORIGIN/api/comments/$COMMENT_ID" | jq -e '.comment.body | contains("organizer schedule")' >/dev/null
REPLY_KEY="smoke-reply-${RANDOM}-$$"
curl -fsS -b "$COOKIE_JAR_TWO" -H "Origin: $ORIGIN" -H "Idempotency-Key: $REPLY_KEY" -H 'Content-Type: application/json' -d "{\"body\":\"The stage timestamp is a strong source; I would also preserve the published schedule snapshot.\",\"parentId\":\"$COMMENT_ID\"}" "$ORIGIN/api/markets/$MARKET_SLUG/comments" | jq -e '.comment.id != null' >/dev/null
curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/notifications" | jq -e '.items | any(.[]; .type == "COMMENT_REPLY")' >/dev/null
curl -fsS -b "$COOKIE_JAR_TWO" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"reason":"OTHER","details":"Authorized moderation workflow smoke test."}' "$ORIGIN/api/comments/$COMMENT_ID/report" | jq -e '.report.status == "PENDING"' >/dev/null
ADMIN_DENIED=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR_TWO" "$ORIGIN/api/admin/reports")
[[ "$ADMIN_DENIED" == "403" ]]

curl -fsS -b "$COOKIE_JAR" -X PATCH -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"displayName":"Smoke Forecaster","bio":"Forecasting with public evidence.","profilePublic":true,"leaderboardVisible":true}' "$ORIGIN/api/profile" | jq -e '.profile.profilePublic == true and .profile.leaderboardVisible == true' >/dev/null

curl -fsS -b "$COOKIE_JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"marketId\":\"$MARKET_ID\"}" "$ORIGIN/api/watchlist" | jq -e '.saved == true' >/dev/null
curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/watchlist" | jq -e --arg id "$MARKET_ID" '.items | any(.[]; .marketId == $id)' >/dev/null
curl -fsS -b "$COOKIE_JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"title":"Will the main stage open by its published start time?","description":"Resolve against the organizer schedule and the timestamp of the first official main-stage announcement.","category":"Hack the North"}' "$ORIGIN/api/suggestions" | jq -e '.suggestion.status == "PENDING"' >/dev/null

BAD_ORIGIN=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -H 'Origin: https://attacker.invalid' -H 'Content-Type: application/json' -d "{\"marketId\":\"$MARKET_ID\"}" "$ORIGIN/api/watchlist")
[[ "$BAD_ORIGIN" == "403" ]]
BAD_JSON=$(curl -sS -o "${RUN_DIR}/bad-json.json" -w '%{http_code}' -b "$COOKIE_JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{' "$ORIGIN/api/watchlist")
[[ "$BAD_JSON" == "400" ]]
jq -e '.error.requestId | test("^[0-9a-f-]{36}$")' "${RUN_DIR}/bad-json.json" >/dev/null

curl -fsS -c "$COOKIE_JAR_EXTRA" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"CorrectHorseBattery42!\"}" "$ORIGIN/api/auth/login" | jq -e '.user.email != null' >/dev/null
SESSIONS=$(curl -fsS -b "$COOKIE_JAR_EXTRA" "$ORIGIN/api/auth/sessions")
OLD_SESSION_ID=$(jq -r '.items[] | select(.current == false) | .id' <<<"$SESSIONS" | head -n 1)
[[ -n "$OLD_SESSION_ID" ]]
curl -fsS -b "$COOKIE_JAR_EXTRA" -X DELETE -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"sessionId\":\"$OLD_SESSION_ID\"}" "$ORIGIN/api/auth/sessions" | jq -e '.revoked == 1' >/dev/null
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "$ORIGIN/api/me")" == "401" ]]
curl -fsS -b "$COOKIE_JAR_EXTRA" "$ORIGIN/api/me" | jq -e '.user.email != null' >/dev/null

echo "Goosey API E2E passed: discovery rails, grouped events, admin events and audit export, recovery-route failure handling, one-time invitations, two-account registration, session isolation, authz, quote, atomic trade, idempotent replay, portfolio, notifications, comment ownership and reporting, privacy controls, watchlist, suggestions, origin defense, request IDs, and malformed-body handling."
