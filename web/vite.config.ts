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
    server: {
        // 本地 dev（localhost:3000）同源代理到 Docker app(nginx):3001。
        // api 默认不再映射宿主机 8080（避免抢端口）；浏览器 / Vite 都经 Nginx 的 /api/、/ai-proxy/。
        // 覆盖：VITE_DEV_PROXY_TARGET=http://127.0.0.1:8081（若你临时打开了 8081:8080）
        proxy: {
            "/api": {
                target: process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:3001",
                changeOrigin: true,
            },
            "/ai-proxy": {
                target: process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:3001",
                changeOrigin: true,
            },
        },
    },
});
