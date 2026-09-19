#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
PORT=$(node --input-type=module -e 'import { createServer } from "node:net"; const server = createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')
ORIGIN="http://127.0.0.1:${PORT}"
RUN_DIR="$(mktemp -d /tmp/goosey-e2e.XXXXXX)"
DB_FILE="${RUN_DIR}/goosey.db"
COOKIE_JAR="${RUN_DIR}/cookies.txt"
COOKIE_JAR_TWO="${RUN_DIR}/cookies-two.txt"
COOKIE_JAR_ADMIN="${RUN_DIR}/cookies-admin.txt"
COOKIE_JAR_EXTRA="${RUN_DIR}/cookies-extra.txt"
SERVER_LOG="${RUN_DIR}/server.log"
ADMIN_EMAIL="invite-fixture-admin@goosey.test"
ADMIN_PASSWORD="Invite-fixture-password-only"

# This harness asserts delivery-unavailable behavior. Never inherit a real
# developer mail transport or let Next reload it from .env for test accounts.
export SMTP_HOST="" SMTP_PORT="" SMTP_FROM="" SMTP_USER="" SMTP_PASSWORD=""

cd "$PROJECT_DIR"
touch "$DB_FILE"
env -u POSTGRES_DATABASE_URL -u POSTGRES_DIRECT_DATABASE_URL \
  DATABASE_PROVIDER="sqlite" \
  DATABASE_URL="file:${DB_FILE}" \
  npx prisma db push --skip-generate >/dev/null
env -u POSTGRES_DATABASE_URL -u POSTGRES_DIRECT_DATABASE_URL \
  DATABASE_PROVIDER="sqlite" \
  DATABASE_URL="file:${DB_FILE}" \
  ADMIN_EMAIL="$ADMIN_EMAIL" \
  ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  npx tsx prisma/seed.ts >/dev/null

# This journey specifically verifies the gated onboarding path. Opt in for this
# isolated server without changing Goosey's default verification policy.
REQUIRE_EMAIL_VERIFICATION="true" DATABASE_PROVIDER="sqlite" DATABASE_URL="file:${DB_FILE}" APP_URL="$ORIGIN" NEXT_PUBLIC_APP_URL="$ORIGIN" GOOSEY_TOKEN_SECRET="$(openssl rand -hex 32)" RATE_LIMIT_KEY_SECRET="$(openssl rand -hex 32)" npm start -- --hostname 127.0.0.1 --port "$PORT" >"$SERVER_LOG" 2>&1 &
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
curl -fsS -c "$COOKIE_JAR" "$ORIGIN/api/auth/registration-device" >/dev/null
REGISTER=$(curl -fsS -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"username\":\"$USERNAME\",\"displayName\":\"Smoke Forecaster\",\"password\":\"CorrectHorseBattery42!\",\"acceptedCodeOfConduct\":true}" "$ORIGIN/api/auth/register")
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
curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/me" | jq -e '.balanceMilli == "1000000"' >/dev/null

MARKETS=$(curl -fsS "$ORIGIN/api/markets?limit=1")
MARKET_ID=$(jq -r '.items[0].id' <<<"$MARKETS")
MARKET_SLUG=$(jq -r '.items[0].slug' <<<"$MARKETS")
EVENTS=$(curl -fsS "$ORIGIN/api/events?timing=all&limit=10")
jq -e '.items | (length > 0 and all(.[]; .markets | length > 0))' <<<"$EVENTS" >/dev/null
[[ "$(jq -r '.items[0] | has("createdById") or has("version")' <<<"$EVENTS")" == "false" ]]
CATALOG_EVENT_SLUG=$(jq -r '.items[0].slug' <<<"$EVENTS")
CATALOG_EVENT_MARKET_COUNT=$(jq '.items[0].markets | length' <<<"$EVENTS")
curl -fsS "$ORIGIN/api/events/$CATALOG_EVENT_SLUG" | jq -e --argjson count "$CATALOG_EVENT_MARKET_COUNT" '.event.markets | length == $count' >/dev/null
CATALOG_SEARCH=$(jq -r '.items[0].shortTitle | @uri' <<<"$MARKETS")
curl -fsS "$ORIGIN/api/search?q=$CATALOG_SEARCH&limit=5" | jq -e --arg id "$MARKET_ID" '.markets | any(.[]; .id == $id)' >/dev/null
curl -fsS "$ORIGIN/api/calendar" | jq -e '(.events | length) > 0 and (.markets | length) > 0' >/dev/null
curl -fsS "$ORIGIN/api/discovery" | jq -e '(.trending | length) > 0 and (.newest | length) > 0 and (.closingSoon | length) > 0' >/dev/null

curl -fsS -c "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" "$ORIGIN/api/auth/login" | jq -e '.user.role == "ADMIN"' >/dev/null
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "$ORIGIN/api/admin/audit-logs")" == "403" ]]
curl -fsS -b "$COOKIE_JAR_ADMIN" "$ORIGIN/api/admin/audit-logs?limit=10" | jq -e '.items | type == "array"' >/dev/null
# Invite management is independent of the existing public registration policy.
# No redemption is attempted: this checks issuance and revocation only.
INVITE_KEY="smoke-admin-invite-${RANDOM}-$$"
INVITE_BODY='{"label":"Isolated integration invitation","maxUses":1,"expiresAt":null}'
[[ "$(curl -sS -o "${RUN_DIR}/invite-created.json" -w '%{http_code}' -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H "Idempotency-Key: $INVITE_KEY" -H 'Content-Type: application/json' -d "$INVITE_BODY" "$ORIGIN/api/admin/invites")" == "201" ]]
jq -e '.replayed == false and .invite.status == "ACTIVE" and .invite.maxUses == 1 and .invite.useCount == 0 and (.code | type == "string" and length > 0)' "${RUN_DIR}/invite-created.json" >/dev/null
INVITE_ID=$(jq -er '.invite.id' "${RUN_DIR}/invite-created.json")
[[ "$(curl -sS -o "${RUN_DIR}/invite-replayed.json" -w '%{http_code}' -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H "Idempotency-Key: $INVITE_KEY" -H 'Content-Type: application/json' -d "$INVITE_BODY" "$ORIGIN/api/admin/invites")" == "200" ]]
jq -e --slurpfile original "${RUN_DIR}/invite-created.json" '.replayed == true and .invite.id == $original[0].invite.id and .code == $original[0].code' "${RUN_DIR}/invite-replayed.json" >/dev/null
INVITE_CHANGED_BODY=$(jq -c '.maxUses = 2' <<<"$INVITE_BODY")
[[ "$(curl -sS -o "${RUN_DIR}/invite-conflict.json" -w '%{http_code}' -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H "Idempotency-Key: $INVITE_KEY" -H 'Content-Type: application/json' -d "$INVITE_CHANGED_BODY" "$ORIGIN/api/admin/invites")" == "409" ]]
jq -e '.error.code == "IDEMPOTENCY_CONFLICT"' "${RUN_DIR}/invite-conflict.json" >/dev/null
curl -fsS -b "$COOKIE_JAR_ADMIN" "$ORIGIN/api/admin/invites" | jq -e --arg id "$INVITE_ID" '
  ([.items[] | select(.id == $id)] | length == 1) and
  any(.items[]; .id == $id and .status == "ACTIVE" and .maxUses == 1 and .useCount == 0) and
  all(.items[]; (has("code") or has("codeHash") or has("requestHash") or has("issuanceKey")) | not)
' >/dev/null
for invite_revoke_attempt in 1 2; do
  curl -fsS -b "$COOKIE_JAR_ADMIN" -X DELETE -H "Origin: $ORIGIN" "$ORIGIN/api/admin/invites/$INVITE_ID" | jq -e --arg id "$INVITE_ID" '.invite == {id: $id, status: "REVOKED"}' >/dev/null
  # Read persisted state after both the first revoke and its retry.
  curl -fsS -b "$COOKIE_JAR_ADMIN" "$ORIGIN/api/admin/invites" | jq -e --arg id "$INVITE_ID" 'any(.items[]; .id == $id and .status == "REVOKED" and .useCount == 0 and .maxUses == 1)' >/dev/null
done
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
BOOK_MARKET_SLUG="smoke-order-book-${RANDOM}-$$"
BOOK_MARKET_KEY="smoke-order-book-${RANDOM}-$$"
BOOK_MARKET_BODY=$(jq --arg slug "$BOOK_MARKET_SLUG" '. + {slug: $slug, pricingModel: "ORDER_BOOK"}' <<<"$ADMIN_MARKET_BODY")
BOOK_MARKET=$(curl -fsS -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H "Idempotency-Key: $BOOK_MARKET_KEY" -H 'Content-Type: application/json' -d "$BOOK_MARKET_BODY" "$ORIGIN/api/admin/markets")
jq -e '.market.pricingModel == "ORDER_BOOK" and .subsidyMilli == "0" and .replayed == false' <<<"$BOOK_MARKET" >/dev/null
curl -fsS -b "$COOKIE_JAR_ADMIN" -H "Origin: $ORIGIN" -H "Idempotency-Key: $BOOK_MARKET_KEY" -H 'Content-Type: application/json' -d "$BOOK_MARKET_BODY" "$ORIGIN/api/admin/markets" | jq -e --arg id "$(jq -r '.market.id' <<<"$BOOK_MARKET")" '.market.id == $id and .replayed == true and .subsidyMilli == "0"' >/dev/null
curl -fsS "$ORIGIN/api/markets/$BOOK_MARKET_SLUG" | jq -e '.probabilityYesBps == null and .probabilitySource == "NONE" and (.priceHistory | length) == 0' >/dev/null
curl -fsS "$ORIGIN/api/v1/markets/$BOOK_MARKET_SLUG/orderbook" | jq -e '(.bids | length) == 0 and (.asks | length) == 0' >/dev/null
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
UNIFIED_HISTORY=$(curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/portfolio/history?limit=1")
jq -e '.items | length == 1' <<<"$UNIFIED_HISTORY" >/dev/null
jq -e --arg amount "$(jq -r '.trades[0].amountMilli' <<<"$PORTFOLIO")" --arg fee "$(jq -r '.trades[0].feeMilli' <<<"$PORTFOLIO")" '.items[0].source == "LMSR" and .items[0].amountMilli == $amount and .items[0].feeMilli == $fee and .nextCursor == null' <<<"$UNIFIED_HISTORY" >/dev/null
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "$ORIGIN/api/portfolio/history")" == "401" ]]
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
curl -fsS -c "$COOKIE_JAR_TWO" "$ORIGIN/api/auth/registration-device" >/dev/null
curl -fsS -b "$COOKIE_JAR_TWO" -c "$COOKIE_JAR_TWO" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL_TWO\",\"username\":\"$USERNAME_TWO\",\"displayName\":\"Second Forecaster\",\"password\":\"CorrectHorseBattery43!\",\"acceptedCodeOfConduct\":true}" "$ORIGIN/api/auth/register" | jq -e '.balanceMilli == "0" and .emailVerification.required == true' >/dev/null
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
# Community discovery respects profile visibility independently of the market
# discussion. Publish both real test authors, then hide the parent below.
COMMUNITY_PRIVATE=$(curl -fsS "$ORIGIN/community")
[[ "$COMMUNITY_PRIVATE" != *"The published organizer schedule and stage timestamp"* ]]
[[ "$COMMUNITY_PRIVATE" != *"The stage timestamp is a strong source"* ]]
for profile_cookie in "$COOKIE_JAR" "$COOKIE_JAR_TWO"; do
  curl -fsS -b "$profile_cookie" -X PATCH -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"profilePublic":true}' "$ORIGIN/api/profile" | jq -e '.profile.profilePublic == true' >/dev/null
done
COMMUNITY_PUBLIC=$(curl -fsS "$ORIGIN/community")
[[ "$COMMUNITY_PUBLIC" == *"The published organizer schedule and stage timestamp"* ]]
[[ "$COMMUNITY_PUBLIC" == *"The stage timestamp is a strong source"* ]]
[[ "$COMMUNITY_PUBLIC" == *"comment=$COMMENT_ID#discussion-heading"* ]]
COMMUNITY_INVALID=$(curl -fsS "$ORIGIN/community?cursor=invalid")
[[ "$COMMUNITY_INVALID" == *"This discussion link is no longer valid"* ]]
COMMUNITY_DUPLICATE=$(curl -fsS "$ORIGIN/community?cursor=one&cursor=two")
[[ "$COMMUNITY_DUPLICATE" == *"This discussion link is no longer valid"* ]]
REPORT=$(curl -fsS -b "$COOKIE_JAR_TWO" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"reason":"OTHER","details":"Authorized moderation workflow smoke test."}' "$ORIGIN/api/comments/$COMMENT_ID/report")
jq -e '.report.status == "PENDING"' <<<"$REPORT" >/dev/null
REPORT_ID=$(jq -er '.report.id' <<<"$REPORT")
ADMIN_DENIED=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR_TWO" "$ORIGIN/api/admin/reports")
[[ "$ADMIN_DENIED" == "403" ]]

# Review a real participant report, observing public state before and after.
curl -fsS -b "$COOKIE_JAR_ADMIN" "$ORIGIN/api/admin/reports" | jq -e --arg id "$REPORT_ID" --arg comment "$COMMENT_ID" '.items | any(.[]; .id == $id and .comment.id == $comment and .status == "PENDING")' >/dev/null
curl -fsS "$ORIGIN/api/markets/$MARKET_SLUG/comments?comment=$COMMENT_ID" | jq -e --arg id "$COMMENT_ID" '.items | any(.[]; .id == $id and .status == "VISIBLE")' >/dev/null
COMMENT_COUNT_BEFORE_HIDE=$(curl -fsS "$ORIGIN/api/markets/$MARKET_SLUG" | jq -er '.commentCount | select(type == "number" and . > 0)')
HIDE_BODY='{"action":"HIDE","note":"Hidden after reviewing the participant report in the isolated integration journey."}'
curl -fsS -b "$COOKIE_JAR_ADMIN" -X PATCH -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "$HIDE_BODY" "$ORIGIN/api/admin/reports/$REPORT_ID" | jq -e --arg id "$REPORT_ID" '.report.id == $id and .report.status == "ACTIONED" and .report.resolvedAt != null and .report.resolvedById != null' >/dev/null
COMMENT_COUNT_AFTER_HIDE=$(( COMMENT_COUNT_BEFORE_HIDE - 1 ))
curl -fsS "$ORIGIN/api/markets/$MARKET_SLUG" | jq -e --argjson count "$COMMENT_COUNT_AFTER_HIDE" '.commentCount == $count' >/dev/null
curl -fsS "$ORIGIN/api/markets/$MARKET_SLUG/comments?limit=100" | jq -e --arg id "$COMMENT_ID" 'all(.items[]; .id != $id)' >/dev/null
[[ "$(curl -sS -o "${RUN_DIR}/hidden-comment.json" -w '%{http_code}' "$ORIGIN/api/markets/$MARKET_SLUG/comments?comment=$COMMENT_ID")" == "404" ]]
jq -e '.error.code == "COMMENT_NOT_FOUND"' "${RUN_DIR}/hidden-comment.json" >/dev/null
COMMUNITY_MODERATED=$(curl -fsS "$ORIGIN/community")
[[ "$COMMUNITY_MODERATED" != *"The published organizer schedule and stage timestamp"* ]]
[[ "$COMMUNITY_MODERATED" != *"The stage timestamp is a strong source"* ]]
curl -fsS -b "$COOKIE_JAR_ADMIN" "$ORIGIN/api/admin/reports" | jq -e --arg id "$REPORT_ID" 'all(.items[]; .id != $id)' >/dev/null
curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/notifications" | jq -e '[.items[] | select(.type == "COMMENT_MODERATED")] | length == 1' >/dev/null
# Review is a one-way transition, not a replay-success API: retry must be 409
# and must neither decrement the counter again nor notify the author twice.
[[ "$(curl -sS -o "${RUN_DIR}/report-replay.json" -w '%{http_code}' -b "$COOKIE_JAR_ADMIN" -X PATCH -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "$HIDE_BODY" "$ORIGIN/api/admin/reports/$REPORT_ID")" == "409" ]]
jq -e '.error.code == "REPORT_ALREADY_REVIEWED"' "${RUN_DIR}/report-replay.json" >/dev/null
curl -fsS "$ORIGIN/api/markets/$MARKET_SLUG" | jq -e --argjson count "$COMMENT_COUNT_AFTER_HIDE" '.commentCount == $count' >/dev/null
curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/notifications" | jq -e '[.items[] | select(.type == "COMMENT_MODERATED")] | length == 1' >/dev/null

curl -fsS -b "$COOKIE_JAR" -X PATCH -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"displayName":"Smoke Forecaster","bio":"Forecasting with public evidence.","profilePublic":true,"leaderboardVisible":true}' "$ORIGIN/api/profile" | jq -e '.profile.profilePublic == true and .profile.leaderboardVisible == true' >/dev/null

curl -fsS -b "$COOKIE_JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"marketId\":\"$MARKET_ID\"}" "$ORIGIN/api/watchlist" | jq -e '.saved == true' >/dev/null
curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/watchlist" | jq -e --arg id "$MARKET_ID" '.items | any(.[]; .marketId == $id)' >/dev/null
SUGGESTION=$(curl -fsS -b "$COOKIE_JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"title":"Will the main stage open by its published start time?","description":"Resolve against the organizer schedule and the timestamp of the first official main-stage announcement.","category":"Hack the North"}' "$ORIGIN/api/suggestions")
jq -e '.suggestion.status == "PENDING"' <<<"$SUGGESTION" >/dev/null
SUGGESTION_ID=$(jq -er '.suggestion.id' <<<"$SUGGESTION")
curl -fsS -b "$COOKIE_JAR_ADMIN" "$ORIGIN/api/admin/suggestions" | jq -e --arg id "$SUGGESTION_ID" '.items | any(.[]; .id == $id and .status == "PENDING")' >/dev/null
SUGGESTION_NOTE="Approved after reviewing the proposed public resolution source."
SUGGESTION_REVIEW_BODY=$(jq -nc --arg note "$SUGGESTION_NOTE" '{action:"APPROVE",note:$note}')
curl -fsS -b "$COOKIE_JAR_ADMIN" -X PATCH -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "$SUGGESTION_REVIEW_BODY" "$ORIGIN/api/admin/suggestions/$SUGGESTION_ID" | jq -e --arg id "$SUGGESTION_ID" --arg note "$SUGGESTION_NOTE" '.suggestion.id == $id and .suggestion.status == "APPROVED" and .suggestion.reviewNote == $note and .suggestion.reviewedAt != null and .suggestion.reviewedById != null' >/dev/null
curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/suggestions" | jq -e --arg id "$SUGGESTION_ID" --arg note "$SUGGESTION_NOTE" '.items | any(.[]; .id == $id and .status == "APPROVED" and .reviewNote == $note)' >/dev/null
curl -fsS -b "$COOKIE_JAR_ADMIN" "$ORIGIN/api/admin/suggestions" | jq -e --arg id "$SUGGESTION_ID" 'all(.items[]; .id != $id)' >/dev/null
curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/notifications" | jq -e --arg note "$SUGGESTION_NOTE" '[.items[] | select(.type == "SUGGESTION_REVIEWED" and .body == $note)] | length == 1' >/dev/null
[[ "$(curl -sS -o "${RUN_DIR}/suggestion-replay.json" -w '%{http_code}' -b "$COOKIE_JAR_ADMIN" -X PATCH -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "$SUGGESTION_REVIEW_BODY" "$ORIGIN/api/admin/suggestions/$SUGGESTION_ID")" == "409" ]]
jq -e '.error.code == "SUGGESTION_ALREADY_REVIEWED"' "${RUN_DIR}/suggestion-replay.json" >/dev/null
curl -fsS -b "$COOKIE_JAR" "$ORIGIN/api/notifications" | jq -e --arg note "$SUGGESTION_NOTE" '[.items[] | select(.type == "SUGGESTION_REVIEWED" and .body == $note)] | length == 1' >/dev/null

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

# Snapshot the still-running application's actual state, then restore into a
# separate file. Reconciliation may set SQLite connection pragmas, so never run
# it against the retained archive itself.
node --import tsx scripts/backup-sqlite.ts --source "$DB_FILE" --output "$RUN_DIR/archive.db"
node --import tsx scripts/backup-sqlite.ts --source "$RUN_DIR/archive.db" --output "$RUN_DIR/restored.db"
node --import tsx scripts/verify-sqlite-restore.ts --source "$RUN_DIR/archive.db" --restored "$RUN_DIR/restored.db"
env -u POSTGRES_DATABASE_URL -u POSTGRES_DIRECT_DATABASE_URL \
  DATABASE_PROVIDER=sqlite DATABASE_URL="file:$RUN_DIR/restored.db" \
  node --import tsx scripts/reconcile.ts

echo "Goosey API E2E passed: discovery rails, grouped events, admin events and audit export, recovery-route failure handling, invite issuance/replay/conflict/redaction/revocation, two-account registration, session isolation, authz, quote, atomic trade, idempotent replay, portfolio, notifications, comment ownership and report moderation with replay-safe counters, privacy controls, watchlist, participant suggestion review, origin defense, request IDs, malformed-body handling, and live SQLite backup/restore reconciliation."
