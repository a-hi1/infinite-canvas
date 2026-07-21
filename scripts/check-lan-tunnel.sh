#!/usr/bin/env sh
# 在公网服务器上检查：frp 隧道出口 + /lan-ai 中继（不修改任何服务）。
set -eu
TUNNEL_URL="${TUNNEL_URL:-http://127.0.0.1:18000/v1/models}"
LAN_AI_URL="${LAN_AI_URL:-http://127.0.0.1:3001/lan-ai/v1/models}"

code_of() {
  url="$1"
  curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 8 "$url" 2>/dev/null || echo "000"
}

t="$(code_of "$TUNNEL_URL")"
l="$(code_of "$LAN_AI_URL")"
echo "tunnel $TUNNEL_URL -> HTTP $t"
echo "lan-ai $LAN_AI_URL -> HTTP $l"

if [ "$t" = "000" ]; then
  echo "HINT: 隧道出口不通。检查 frps 是否 up、家里 frpc 是否在线、token/localIP。"
  exit 1
fi
if [ "$l" = "503" ]; then
  echo "HINT: /lan-ai 未配置。根目录 .env 设置 LAN_AI_UPSTREAM=host.docker.internal:18000 后 rebuild app。"
  exit 1
fi
if [ "$l" = "000" ] || [ "$l" = "504" ] || [ "$l" = "502" ]; then
  echo "HINT: /lan-ai 网关失败。核对 app 日志 LAN AI relay enabled 指向是否为 host.docker.internal:18000。"
  exit 1
fi
echo "OK: 通路可用（401 表示通但需 API Key，200 表示已返回模型列表）。"
exit 0
