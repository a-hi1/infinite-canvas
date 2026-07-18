#!/usr/bin/env bash
# Health check for infinite-canvas docker stack (app + api + ai-proxy).
# Usage (server or Linux):
#   chmod +x scripts/check-cloud-stack.sh
#   ./scripts/check-cloud-stack.sh
#   BASE_URL=http://127.0.0.1:3001 ./scripts/check-cloud-stack.sh
#   SKIP_VIDGEN=1 ./scripts/check-cloud-stack.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.local.yml}"
BASE_URL="${BASE_URL:-http://127.0.0.1:3001}"
SKIP_VIDGEN="${SKIP_VIDGEN:-0}"
FAIL=0

note() { printf '%s\n' "$*"; }
ok() { printf '[OK] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
bad() { printf '[FAIL] %s\n' "$*"; FAIL=$((FAIL + 1)); }

note "== infinite-canvas cloud stack check =="
note "root: $ROOT_DIR"
note "compose: $COMPOSE_FILE"
note "base: $BASE_URL"
note ""

if command -v git >/dev/null 2>&1 && [[ -d .git ]]; then
  note "-- git --"
  git log -1 --oneline 2>/dev/null || warn "git log failed"
  note ""
fi

note "-- compose ps --"
if ! command -v docker >/dev/null 2>&1; then
  bad "docker not found"
else
  if docker compose -f "$COMPOSE_FILE" ps 2>/dev/null; then
    for svc in app api ai-proxy; do
      state="$(docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -x "$svc" || true)"
      if [[ -n "$state" ]]; then
        ok "service running: $svc"
      else
        bad "service not running: $svc"
      fi
    done
  else
    bad "docker compose ps failed (file=$COMPOSE_FILE)"
  fi
fi
note ""

note "-- http health --"
page_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$BASE_URL/" 2>/dev/null || echo 000)"
if [[ "$page_code" == "200" ]]; then
  ok "page $BASE_URL/ -> $page_code"
else
  bad "page $BASE_URL/ -> $page_code"
fi

health_body="$(curl -sS --max-time 8 "$BASE_URL/api/health" 2>/dev/null || true)"
if printf '%s' "$health_body" | grep -q '"ok":true'; then
  ok "api health ok: $health_body"
else
  bad "api health unexpected: ${health_body:-<empty>}"
fi

proxy_health="$(curl -sS --max-time 8 "$BASE_URL/ai-proxy/health" 2>/dev/null || true)"
if printf '%s' "$proxy_health" | grep -q '"ok":true'; then
  ok "ai-proxy health ok: $proxy_health"
else
  bad "ai-proxy health unexpected: ${proxy_health:-<empty>}"
fi
note ""

note "-- platform readiness (opt-in; default off is OK) --"
# Non-secret readiness from /api/health.platform (P1). Default false/false is expected for personal BYOK.
if printf '%s' "$health_body" | grep -q '"platform"'; then
  img_on="$(printf '%s' "$health_body" | grep -o '"image_enabled":[^,]*' | head -1 | cut -d: -f2 | tr -d ' ')"
  vid_on="$(printf '%s' "$health_body" | grep -o '"video_enabled":[^,]*' | head -1 | cut -d: -f2 | tr -d ' ')"
  if [[ "$img_on" == "true" || "$vid_on" == "true" ]]; then
    warn "platform enabled: image_enabled=$img_on video_enabled=$vid_on (billing product still deferred unless you intentionally charge)"
  else
    ok "platform gateways disabled (default BYOK path; billing deferred)"
  fi
else
  warn "api health has no platform field (rebuild api if you expect P1 readiness)"
fi
note ""

note "-- env hygiene (optional .env) --"
if [[ -f .env ]]; then
  if grep -Eiq 'HTTP_PROXY|HTTPS_PROXY' .env; then
    if grep -Eiq '7897|7890|host\.docker\.internal' .env; then
      warn ".env sets host proxy (fine for local dev; avoid on public server unless intentional)"
      grep -Ei 'HTTP_PROXY|HTTPS_PROXY|NO_PROXY' .env | sed 's/=.*/=***/' || true
    else
      warn ".env sets HTTP(S)_PROXY (confirm this is intended for this host)"
    fi
  else
    ok ".env present without HTTP(S)_PROXY"
  fi
  if grep -Eiq 'API_COOKIE_SECURE\s*=\s*true' .env; then
    ok "API_COOKIE_SECURE=true"
  else
    warn "API_COOKIE_SECURE is not true (required for public HTTPS)"
  fi
else
  warn "no root .env (compose defaults only)"
fi
note ""

if [[ "$SKIP_VIDGEN" != "1" ]] && command -v docker >/dev/null 2>&1; then
  note "-- optional: ai-proxy reachability to vidgen.x.ai --"
  note "(Grok remote CDN; failure means preview/upload-from-url may 502, not that local mode is broken)"
  if docker compose -f "$COMPOSE_FILE" exec -T ai-proxy \
    wget -q -O /dev/null --timeout=15 https://vidgen.x.ai/ 2>/dev/null; then
    ok "ai-proxy can reach https://vidgen.x.ai/"
  else
    warn "ai-proxy cannot reach vidgen.x.ai (timeout/blocked). Local BYOK still OK; Grok cloud media may fail until egress works"
  fi
  note ""
fi

note "-- dual-track reminder --"
note "Gate before release: stop api container, then unauthenticated image/canvas/assets/prompts must still work."
note ""

if [[ "$FAIL" -gt 0 ]]; then
  bad "finished with $FAIL failure(s)"
  exit 1
fi
ok "finished with no hard failures"
exit 0
