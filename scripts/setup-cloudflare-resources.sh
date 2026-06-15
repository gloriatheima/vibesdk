#!/usr/bin/env bash
# Creates all Cloudflare resources needed by wrangler.jsonc
# Run once before `wrangler dev --remote` or `wrangler deploy`
#
# Usage: bash scripts/setup-cloudflare-resources.sh

set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[INFO]${RESET} $*"; }
ok()      { echo -e "${GREEN}[OK]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[SKIP]${RESET} $*"; }
section() { echo -e "\n${BOLD}── $* ──${RESET}"; }

WRANGLER="npx wrangler"

# ── D1 Database ────────────────────────────────────────────────────────────────
section "D1 Database: vibesdk-db"
D1_OUTPUT=$($WRANGLER d1 create vibesdk-db 2>&1 || true)

if echo "$D1_OUTPUT" | grep -q "already exists"; then
    warn "vibesdk-db already exists"
    DB_ID=$(npx wrangler d1 list 2>&1 | grep "vibesdk-db" | awk '{print $NF}' || true)
else
    ok "Created vibesdk-db"
    DB_ID=$(echo "$D1_OUTPUT" | grep '"database_id"' | sed 's/.*"database_id": "\([^"]*\)".*/\1/')
fi

if [[ -n "$DB_ID" ]]; then
    ok "D1 database_id: $DB_ID"
    echo ""
    echo -e "${YELLOW}ACTION REQUIRED:${RESET} Update wrangler.jsonc:"
    echo "  \"database_id\": \"$DB_ID\","
    echo "  \"preview_database_id\": \"$DB_ID\","
else
    warn "Could not parse DB_ID — run 'npx wrangler d1 list' to find it manually"
fi

# ── R2 Bucket ─────────────────────────────────────────────────────────────────
section "R2 Bucket: vibesdk-templates"
R2_OUTPUT=$($WRANGLER r2 bucket create vibesdk-templates 2>&1 || true)
if echo "$R2_OUTPUT" | grep -q "already exists\|Created"; then
    ok "vibesdk-templates bucket ready"
else
    warn "$R2_OUTPUT"
fi

# ── Workers for Platforms Dispatch Namespace ──────────────────────────────────
section "Workers for Platforms: vibesdk-default-namespace"
WFP_OUTPUT=$($WRANGLER dispatch-namespace create vibesdk-default-namespace 2>&1 || true)
if echo "$WFP_OUTPUT" | grep -q "already exists\|Created\|created"; then
    ok "vibesdk-default-namespace ready"
else
    warn "$WFP_OUTPUT"
fi

# ── AI Gateway ────────────────────────────────────────────────────────────────
section "AI Gateway: vibesdk-gateway"
GW_OUTPUT=$($WRANGLER ai gateway create vibesdk-gateway 2>&1 || true)
if echo "$GW_OUTPUT" | grep -q "already exists\|Created\|created"; then
    ok "vibesdk-gateway ready"
else
    warn "AI Gateway may need to be created via dashboard: https://dash.cloudflare.com → AI → AI Gateway"
    warn "$GW_OUTPUT"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
section "Done"
echo "Resources created. Next steps:"
echo "  1. Update wrangler.jsonc with the D1 database_id printed above"
echo "  2. Run: npx wrangler dev --remote"
echo "  3. Run: bash scripts/verify-phase1.sh (set TOKEN= if needed)"
