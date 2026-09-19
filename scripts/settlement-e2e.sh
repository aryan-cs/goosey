#!/bin/zsh
set -euo pipefail
PROJECT_DIR="${0:A:h:h}"
RUN_DIR="$(mktemp -d /tmp/goosey-settlement.XXXXXX)"
trap 'rm -rf "$RUN_DIR"' EXIT INT TERM
DB_FILE="$RUN_DIR/goosey.db"
cd "$PROJECT_DIR"
touch "$DB_FILE"
DATABASE_URL="file:$DB_FILE" npx prisma db push --skip-generate >/dev/null
DATABASE_URL="file:$DB_FILE" RATE_LIMIT_KEY_SECRET="$(openssl rand -hex 32)" npx tsx scripts/settlement-e2e.ts
