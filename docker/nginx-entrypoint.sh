#!/bin/sh
set -eu

LAN_INC=/etc/nginx/conf.d/lan-ai.inc
UPSTREAM="${LAN_AI_UPSTREAM:-}"

if [ -n "$UPSTREAM" ]; then
  # Accept host:port or full http://host:port
  case "$UPSTREAM" in
    http://*|https://*) TARGET="$UPSTREAM" ;;
    *) TARGET="http://$UPSTREAM" ;;
  esac
  cat >"$LAN_INC" <<EOF
# Generated from LAN_AI_UPSTREAM=${UPSTREAM}
# Browser uses same-origin /lan-ai/* ; nginx strips prefix and forwards to LAN AI.
location /lan-ai/ {
    # Docker embedded DNS; variable proxy_pass needs resolver
    resolver 127.0.0.11 valid=30s ipv6=off;
    set \$lan_ai_target "${TARGET}";
    rewrite ^/lan-ai/(.*)\$ /\$1 break;
    proxy_pass \$lan_ai_target;
    proxy_http_version 1.1;
    proxy_set_header Host \$proxy_host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_connect_timeout 30s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
EOF
  echo "[nginx] LAN AI relay enabled: /lan-ai/ -> ${TARGET}"
else
  cat >"$LAN_INC" <<'EOF'
# LAN_AI_UPSTREAM not set — /lan-ai disabled (browser CORS cannot hit private LAN IPs).
location /lan-ai/ {
    default_type application/json;
    return 503 '{"error":{"message":"内网 AI 中继未配置。请在 compose 环境变量 LAN_AI_UPSTREAM 填入例如 192.168.6.78:8000，重建 app 后，渠道 Base URL 使用 /lan-ai"}}';
}
EOF
  echo "[nginx] LAN AI relay disabled (set LAN_AI_UPSTREAM to enable)"
fi

exec nginx -g 'daemon off;'
