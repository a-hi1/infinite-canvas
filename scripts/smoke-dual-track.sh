#!/usr/bin/env bash
# Dual-track smoke: page must stay up when api is stopped; then restore api.
# Usage:
#   chmod +x scripts/smoke-dual-track.sh
#   ./scripts/smoke-dual-track.sh
#   BASE_URL=http://127.0.0.1:3001 ./scripts/smoke-dual-track.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.local.yml}"
BASE_URL="${BASE_URL:-http://127.0.0.1:3001}"
FAIL=0

note() { printf '%s\n' "$*"; }
ok() { printf '[OK] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
bad() { printf '[FAIL] %s\n' "$*"; FAIL=$((FAIL + 1)); }

note "== dual-track smoke =="
note "compose: $COMPOSE_FILE"
note "base: $BASE_URL"
note ""

note "-- baseline --"
page_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$BASE_URL/" 2>/dev/null || echo 000)"
if [[ "$page_code" == "200" ]]; then ok "page up before stop"; else bad "page status $page_code"; fi
health_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$BASE_URL/api/health" 2>/dev/null || echo 000)"
if [[ "$health_code" == "200" ]]; then ok "api health up before stop"; else warn "api health status $health_code"; fi
note ""

note "-- stop api --"
if ! docker compose -f "$COMPOSE_FILE" stop api; then bad "docker compose stop api failed"; fi
sleep 2

note "-- while api down --"
page_down="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$BASE_URL/" 2>/dev/null || echo 000)"
if [[ "$page_down" == "200" ]]; then ok "page still 200 with api stopped (static/local track)"; else bad "page status with api down: $page_down"; fi
api_down="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/api/health" 2>/dev/null || echo 000)"
if [[ "$api_down" == "000" || "$api_down" -ge 500 ]]; then ok "api health $api_down while stopped (expected)"; else warn "api health unexpected while stopped: $api_down"; fi
note ""

note "-- start api --"
if ! docker compose -f "$COMPOSE_FILE" start api; then bad "docker compose start api failed"; fi
sleep 3
health_body="$(curl -sS --max-time 10 "$BASE_URL/api/health" 2>/dev/null || true)"
if printf '%s' "$health_body" | grep -q '"ok":true'; then ok "api health restored"; else bad "api health not ok after start: ${health_body:-empty}"; fi

note ""
note "Manual still required: unauthenticated generate image/canvas/assets/prompts while api stopped."
note ""

if [[ "$FAIL" -gt 0 ]]; then
  bad "finished with $FAIL failure(s)"
  exit 1
fi
ok "dual-track smoke finished with no hard failures"
exit 0
