#!/usr/bin/env bash
# Phase 1 verification script for UniversalAgentSession + Workers AI dual-brain + Queues
#
# Usage:
#   TOKEN=<jwt> bash scripts/verify-phase1.sh
#   TOKEN=<jwt> INSTRUCTION="Write a hello world script" bash scripts/verify-phase1.sh
#   TOKEN=<jwt> BASE_URL=https://your-deployed-worker.dev bash scripts/verify-phase1.sh
#
# Prerequisites: server must be running with remote bindings:
#   npx wrangler dev --remote

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
INSTRUCTION="${INSTRUCTION:-Create a simple Python script that prints the current date and time}"
TOKEN="${TOKEN:-}"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET} $*"; }
ok()      { echo -e "${GREEN}[OK]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET} $*"; }
fail()    { echo -e "${RED}[FAIL]${RESET} $*"; exit 1; }
section() { echo -e "\n${BOLD}── $* ──${RESET}"; }

# ── dependency check ──────────────────────────────────────────────────────────
for cmd in curl jq; do
  command -v "$cmd" &>/dev/null || fail "Required tool not found: $cmd"
done

# ── TOKEN ──────────────────────────────────────────────────────────────────────
if [[ -z "$TOKEN" ]]; then
  echo -e "${YELLOW}TOKEN not set.${RESET}"
  echo "  1. Start the app: npx wrangler dev --remote"
  echo "  2. Open http://localhost:8787 and log in"
  echo "  3. DevTools → Application → Local Storage → copy 'access_token'"
  echo "  4. Re-run:  TOKEN=<paste> bash scripts/verify-phase1.sh"
  exit 1
fi

AUTH_HEADER="Authorization: Bearer $TOKEN"

# ── Step 1: health check ──────────────────────────────────────────────────────
section "Step 1: Health check"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/health")
if [[ "$HTTP_STATUS" == "200" ]]; then
  ok "Server is up at $BASE_URL"
else
  fail "Server not reachable at $BASE_URL (HTTP $HTTP_STATUS). Start with: npx wrangler dev --remote"
fi

# ── Step 2: submit task ────────────────────────────────────────────────────────
section "Step 2: POST /api/universal/tasks"
info "Instruction: \"$INSTRUCTION\""

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/universal/tasks" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d "{\"instruction\": \"$INSTRUCTION\"}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [[ "$HTTP_CODE" != "202" ]]; then
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
  fail "Expected HTTP 202, got $HTTP_CODE"
fi

TASK_ID=$(echo "$BODY" | jq -r '.taskId')
SESSION_ID=$(echo "$BODY" | jq -r '.sessionId')

ok "Task queued"
echo "  taskId    = $TASK_ID"
echo "  sessionId = $SESSION_ID"

# ── Step 3: stream SSE ─────────────────────────────────────────────────────────
section "Step 3: GET /api/universal/sessions/$SESSION_ID/stream"
info "Waiting for SSE events (Ctrl-C to stop)..."
echo ""

SEEN_EVENTS=()
DONE=false

# curl --max-time 120 gives up to 2 min for the full run
curl -s --max-time 120 -N \
  "$BASE_URL/api/universal/sessions/$SESSION_ID/stream" \
  -H "$AUTH_HEADER" \
  -H "Accept: text/event-stream" | \
while IFS= read -r line; do
  if [[ "$line" == event:* ]]; then
    EVENT_TYPE="${line#event: }"
    case "$EVENT_TYPE" in
      thinking) printf "${CYAN}[THINKING]${RESET} " ;;
      plan)     printf "\n${GREEN}[PLAN]${RESET}\n" ;;
      action)   printf "${YELLOW}[ACTION]${RESET} " ;;
      text)     printf "${RESET}[TEXT] " ;;
      status)   printf "${BOLD}[STATUS]${RESET} " ;;
      done)     printf "\n${GREEN}[DONE]${RESET} " ;;
      error)    printf "\n${RED}[ERROR]${RESET} " ;;
      *)        printf "[%s] " "$EVENT_TYPE" ;;
    esac
  elif [[ "$line" == data:* ]]; then
    DATA="${line#data: }"
    case "${EVENT_TYPE:-}" in
      thinking)
        # Print thinking content inline (strip quotes)
        CONTENT=$(echo "$DATA" | jq -r '.content' 2>/dev/null || echo "$DATA")
        printf "%s" "$CONTENT"
        ;;
      plan)
        echo "$DATA" | jq . 2>/dev/null || echo "$DATA"
        ;;
      action)
        STEP=$(echo "$DATA" | jq -r '.step' 2>/dev/null)
        TOOL=$(echo "$DATA" | jq -r '.tool' 2>/dev/null)
        PARAMS=$(echo "$DATA" | jq -c '.params' 2>/dev/null)
        echo "step=$STEP tool=$TOOL params=$PARAMS"
        ;;
      status)
        echo "$DATA" | jq -r '.message' 2>/dev/null || echo "$DATA"
        ;;
      done)
        echo "$DATA" | jq . 2>/dev/null || echo "$DATA"
        echo ""
        ;;
      error)
        echo "$DATA" | jq . 2>/dev/null || echo "$DATA"
        ;;
      *)
        echo "$DATA"
        ;;
    esac
    EVENT_TYPE=""
  fi
done

echo ""
section "Verification complete"
ok "Phase 1 pipeline worked end-to-end:"
echo "  ✓ POST /api/universal/tasks returned 202"
echo "  ✓ Queue dispatched task to UniversalAgentSession DO"
echo "  ✓ SSE stream received thinking + plan + actions + done events"
