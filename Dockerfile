# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 运行镜像：启动静态前端；可通过 nginx 同源转发到可选 ai-proxy 服务。
FROM nginx:1.27-alpine

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx-entrypoint.sh /nginx-entrypoint.sh
# Windows 检出常见 CRLF；Alpine 会报 exec ... no such file or directory
RUN sed -i 's/\r$//' /nginx-entrypoint.sh \
    && chmod +x /nginx-entrypoint.sh \
    && printf '%s\n' '# placeholder until entrypoint writes LAN_AI_UPSTREAM config' 'location /lan-ai/ { return 503; }' > /etc/nginx/conf.d/lan-ai.inc

EXPOSE 3000
ENTRYPOINT ["/nginx-entrypoint.sh"]
