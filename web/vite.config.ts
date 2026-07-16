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
        },
    },
});
