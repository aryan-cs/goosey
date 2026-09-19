#!/bin/zsh
set -euo pipefail

export DATABASE_URL="${DATABASE_URL:-file:./browser-e2e.db}"
export DATABASE_PROVIDER="sqlite"
export APP_URL="${APP_URL:-http://127.0.0.1:8081}"
export NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL:-$APP_URL}"
export EMAIL_VERIFICATION_URL="${EMAIL_VERIFICATION_URL:-$APP_URL/verify-email}"
# Browser journeys exercise gated signup explicitly; this opt-in is scoped to
# their isolated server and does not alter the application default.
export REQUIRE_EMAIL_VERIFICATION="true"
export RATE_LIMIT_KEY_SECRET="${RATE_LIMIT_KEY_SECRET:-goosey-browser-e2e-rate-limit-secret-32-bytes}"
export GOOSEY_TOKEN_SECRET="${GOOSEY_TOKEN_SECRET:-goosey-browser-e2e-token-secret-32-bytes}"

sqlite3 prisma/dev.db ".backup 'prisma/browser-e2e.db'"
npx tsx prisma/seed.ts
exec npx next start --hostname 127.0.0.1 --port 8081
