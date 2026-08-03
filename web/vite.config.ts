import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
    // 默认 assetsDir=assets 会与 SPA 路由 /assets（我的资产）冲突：
    // Docker nginx try_files 命中真实目录 /assets/ 时刷新页面返回 403。
    build: {
        assetsDir: "static",
    },
    server: {
        // 本地 dev（localhost:3000）把 /api、/ai-proxy 转到 Docker app(nginx)。
        // 默认 3011：配合 docker-compose.dev-host.yml，避开 VS Code 端口转发占用的 127.0.0.1:3001/8080
        //（转发常指向远端旧服务，会出现 501 / 来源不被允许）。
        // 覆盖：VITE_DEV_PROXY_TARGET=http://127.0.0.1:3001
        proxy: {
            "/api": {
                target: process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:3011",
                changeOrigin: true,
            },
            "/ai-proxy": {
                target: process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:3011",
                changeOrigin: true,
            },
            // 本地 bun dev 直连内网 AI（绕过浏览器 CORS）。例：VITE_LAN_AI_TARGET=http://192.168.6.78:8000
            // Docker 部署请用 compose LAN_AI_UPSTREAM + 渠道 Base URL=/lan-ai，不必走本项。
            ...(process.env.VITE_LAN_AI_TARGET
                ? {
                      "/lan-ai": {
                          target: process.env.VITE_LAN_AI_TARGET,
                          changeOrigin: true,
                          rewrite: (path: string) => path.replace(/^\/lan-ai/, ""),
                      },
                  }
                : {
                      "/lan-ai": {
                          target: process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:3011",
                          changeOrigin: true,
                      },
                  }),
        },
    },
});
