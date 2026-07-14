import http from "node:http";
import { URL } from "node:url";

const port = Number(process.env.PORT || 3002);
const upstreamBaseUrl = normalizeBaseUrl(process.env.AI_PROXY_BASE_URL || "");
const upstreamApiKey = process.env.AI_PROXY_API_KEY || "";
const proxyAccessToken = process.env.AI_PROXY_ACCESS_TOKEN || "";
const allowedOrigins = parseCsv(process.env.AI_PROXY_ALLOWED_ORIGINS || "*");
const maxBodyBytes = Number(process.env.AI_PROXY_MAX_BODY_BYTES || 80 * 1024 * 1024);
const timeoutMs = Number(process.env.AI_PROXY_TIMEOUT_MS || 300000);
const allowedHeaders = new Set(["accept", "accept-language", "content-type", "range", "if-range", "user-agent", "x-goog-api-client"]);
const blockedResponseHeaders = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"]);
const rateLimitWindowMs = Number(process.env.AI_PROXY_RATE_LIMIT_WINDOW_MS || 60000);
const rateLimitMax = Number(process.env.AI_PROXY_RATE_LIMIT_MAX || 120);
const rateLimitBuckets = new Map();

const endpointRules = [
    /^\/v1\/images\/generations$/,
    /^\/v1\/images\/edits$/,
    /^\/v1\/responses$/,
    /^\/v1\/models$/,
    /^\/v1\/videos(?:\/[^/]+(?:\/content)?)?$/,
    /^\/videos$/,
    /^\/agnesapi$/,
    /^\/media$/,
    /^\/v1\/audio\/speech$/,
    /^\/v1\/t2a_v2$/,
    /^\/api\/plan\/v3\/contents\/generations\/tasks(?:\/[^/]+)?$/,
    /^\/api\/v3\/contents\/generations\/tasks(?:\/[^/]+)?$/,
    /^\/v1beta\/models(?:\/[^:]+:(?:generateContent|streamGenerateContent))?$/,
    /^\/v1\/models(?:\/[^:]+:(?:generateContent|streamGenerateContent))?$/,
];

const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const origin = req.headers.origin || "";
    setCorsHeaders(res, origin);

    if (req.method === "OPTIONS") {
        res.writeHead(isOriginAllowed(origin) ? 204 : 403);
        res.end();
        return;
    }

    if (req.url === "/health") {
        writeJson(res, 200, { ok: true, upstreamConfigured: Boolean(upstreamBaseUrl), authRequired: Boolean(proxyAccessToken) });
        return;
    }

    try {
        const incomingUrl = new URL(req.url || "/", "http://proxy.local");
        const path = normalizeIncomingPath(incomingUrl.pathname);
        const isMediaRequest = path === "/media";

        if (!isMediaRequest) assertProxyReady();
        assertOriginAllowed(origin);
        if (!isMediaRequest) assertRateLimit(req);
        if (isMediaRequest) assertMediaAuthorized(req, incomingUrl);
        else assertAuthorized(req);
        assertMethodAllowed(req.method);
        assertEndpointAllowed(path);
        if (isMediaRequest && req.method !== "GET") throw httpError(405, "AI 代理媒体转发只允许 GET 请求");

        const body = isMediaRequest ? Buffer.alloc(0) : await readBody(req, maxBodyBytes);
        const targetUrl = isMediaRequest ? buildMediaTargetUrl(incomingUrl) : buildTargetUrl(path, incomingUrl.search);
        const headers = isMediaRequest ? buildMediaForwardHeaders(req) : buildForwardHeaders(req, targetUrl);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let upstreamResponse;
        try {
            upstreamResponse = await fetch(targetUrl, {
                method: req.method,
                headers,
                body: body.length ? body : undefined,
                signal: controller.signal,
            });
        } catch (error) {
            if (isMediaRequest) throw mediaFetchError(targetUrl, error);
            throw error;
        } finally {
            clearTimeout(timer);
        }

        forwardResponseHeaders(res, upstreamResponse, origin);
        res.writeHead(upstreamResponse.status, upstreamResponse.statusText);
        if (upstreamResponse.body) {
            await upstreamResponse.body.pipeTo(
                new WritableStream({
                    write(chunk) {
                        res.write(Buffer.from(chunk));
                    },
                    close() {
                        res.end();
                    },
                    abort(error) {
                        res.destroy(error);
                    },
                }),
            );
        } else {
            res.end();
        }
        logRequest(req, path, upstreamResponse.status, Date.now() - startedAt);
    } catch (error) {
        const status = error.status || 500;
        writeJson(res, status, { error: { message: error.publicMessage || "AI 代理请求失败" } });
        logRequest(req, req.url || "", status, Date.now() - startedAt, error.publicMessage || sanitizeErrorMessage(error.message));
    }
});

server.listen(port, "0.0.0.0", () => {
    console.log(`AI proxy listening on 0.0.0.0:${port}`);
    console.log(`Upstream configured: ${upstreamBaseUrl ? "yes" : "no"}; access token required: ${proxyAccessToken ? "yes" : "no"}`);
});

function normalizeBaseUrl(value) {
    return value.trim().replace(/\/+$/, "");
}

function parseCsv(value) {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function assertProxyReady() {
    if (!upstreamBaseUrl) throw httpError(500, "AI 代理未配置上游 Base URL");
    if (!upstreamApiKey) throw httpError(500, "AI 代理未配置上游 API Key");
}

function normalizeIncomingPath(pathname) {
    if (pathname.startsWith("/ai-proxy/")) return pathname.slice("/ai-proxy".length);
    return pathname;
}

function assertEndpointAllowed(path) {
    if (!endpointRules.some((rule) => rule.test(path))) throw httpError(404, "AI 代理不允许访问该接口路径");
}

function assertMethodAllowed(method) {
    if (!method || !["GET", "POST"].includes(method)) throw httpError(405, "AI 代理只允许 GET/POST 请求");
}

function assertOriginAllowed(origin) {
    if (!isOriginAllowed(origin)) throw httpError(403, "当前来源不允许访问 AI 代理");
}

function isOriginAllowed(origin) {
    if (!origin) return true;
    if (allowedOrigins.includes("*")) return true;
    return allowedOrigins.includes(origin);
}

function assertAuthorized(req) {
    if (!proxyAccessToken) return;
    if (readRequestToken(req) === proxyAccessToken) return;
    throw httpError(401, "AI 代理访问令牌无效");
}

function assertMediaAuthorized(req, incomingUrl) {
    if (!proxyAccessToken) return;
    if (readRequestToken(req) === proxyAccessToken) return;
    if (incomingUrl.searchParams.get("token") === proxyAccessToken) return;
    throw httpError(401, "AI 代理访问令牌无效");
}

function readRequestToken(req) {
    const header = req.headers.authorization || "";
    const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const explicit = String(req.headers["x-ai-proxy-token"] || "").trim();
    const gemini = String(req.headers["x-goog-api-key"] || "").trim();
    return bearer || explicit || gemini;
}

function assertRateLimit(req) {
    if (!rateLimitWindowMs || !rateLimitMax) return;
    const key = clientKey(req);
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        rateLimitBuckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
        cleanupRateLimitBuckets(now);
        return;
    }
    bucket.count += 1;
    if (bucket.count > rateLimitMax) throw httpError(429, "AI 代理请求过于频繁，请稍后重试");
}

function clientKey(req) {
    return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim() || "unknown";
}

function cleanupRateLimitBuckets(now) {
    if (rateLimitBuckets.size < 1000) return;
    for (const [key, bucket] of rateLimitBuckets.entries()) {
        if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
    }
}

function setCorsHeaders(res, origin) {
    if (origin && isOriginAllowed(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
    else if (allowedOrigins.includes("*")) res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Range,If-Range,X-AI-Proxy-Token,x-goog-api-client");
    res.setHeader("Access-Control-Max-Age", "86400");
}

function buildTargetUrl(path, search) {
    const target = new URL(upstreamBaseUrl);
    const basePath = target.pathname.replace(/\/+$/, "");
    const requestPath = path.startsWith("/") ? path : `/${path}`;
    if ((requestPath === "/videos" || requestPath === "/agnesapi") && basePath.toLowerCase().endsWith("/v1")) {
        target.pathname = `${basePath.slice(0, -3) || ""}${requestPath}`;
    } else {
        target.pathname = basePath && requestPath.toLowerCase().startsWith(`${basePath.toLowerCase()}/`) ? requestPath : joinPath(basePath, requestPath);
    }
    target.search = search;
    for (const key of Array.from(target.searchParams.keys())) {
        if (/key|token|secret|password/i.test(key)) target.searchParams.delete(key);
    }
    return target;
}

function joinPath(basePath, requestPath) {
    const base = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
    return `${base}/${requestPath.replace(/^\/+/, "")}` || "/";
}

function buildMediaTargetUrl(incomingUrl) {
    const rawUrl = incomingUrl.searchParams.get("url") || "";
    let target;
    try {
        target = new URL(rawUrl);
    } catch {
        throw httpError(400, "媒体地址无效");
    }
    if (!isAllowedMediaTarget(target)) throw httpError(403, "AI 代理不允许访问该媒体地址");
    return target;
}

function isAllowedMediaTarget(target) {
    if (target.protocol !== "https:" && target.protocol !== "http:") return false;
    const hostname = target.hostname.toLowerCase();
    return (
        hostname === "platform-outputs.agnes-ai.space" ||
        hostname.endsWith(".agnes-ai.space") ||
        hostname === "apihub.agnes-ai.com" ||
        hostname.endsWith(".agnes-ai.com") ||
        hostname === "imgen.x.ai" ||
        hostname.endsWith(".imgen.x.ai") ||
        hostname === "cdn.x.ai" ||
        hostname.endsWith(".cdn.x.ai")
    );
}

function buildMediaForwardHeaders(req) {
    const headers = new Headers();
    for (const key of ["accept", "accept-language", "range", "if-range", "user-agent"]) {
        const value = req.headers[key];
        if (Array.isArray(value)) headers.set(key, value.join(", "));
        else if (value !== undefined) headers.set(key, value);
    }
    return headers;
}

function buildForwardHeaders(req, targetUrl) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        if (!allowedHeaders.has(lower)) continue;
        if (Array.isArray(value)) headers.set(key, value.join(", "));
        else if (value !== undefined) headers.set(key, value);
    }
    if (isGeminiTarget(targetUrl)) headers.set("x-goog-api-key", upstreamApiKey);
    else headers.set("Authorization", `Bearer ${upstreamApiKey}`);
    return headers;
}

function isGeminiTarget(targetUrl) {
    return targetUrl.hostname.includes("generativelanguage.googleapis.com") || targetUrl.pathname.includes("/v1beta/models") || targetUrl.pathname.includes("/v1/models/") && targetUrl.pathname.includes(":generateContent") || targetUrl.pathname.includes(":streamGenerateContent");
}

function forwardResponseHeaders(res, upstreamResponse, origin) {
    setCorsHeaders(res, origin);
    for (const [key, value] of upstreamResponse.headers.entries()) {
        if (blockedResponseHeaders.has(key.toLowerCase())) continue;
        if (key.toLowerCase() === "access-control-allow-origin") continue;
        res.setHeader(key, value);
    }
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(httpError(413, "请求体过大，AI 代理已拒绝"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function writeJson(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
}

function httpError(status, publicMessage) {
    const error = new Error(publicMessage);
    error.status = status;
    error.publicMessage = publicMessage;
    return error;
}

function mediaFetchError(targetUrl, error) {
    const host = (() => {
        try {
            return new URL(targetUrl).hostname;
        } catch {
            return "远程媒体";
        }
    })();
    const causeCode = error?.cause?.code || error?.code || "";
    if (causeCode === "UND_ERR_CONNECT_TIMEOUT" || /timeout/i.test(String(error?.message || ""))) {
        return httpError(502, `AI 代理无法连接 ${host}（连接超时）。请检查服务器到该媒体域名的网络出口`);
    }
    if (causeCode === "ENOTFOUND" || causeCode === "EAI_AGAIN") {
        return httpError(502, `AI 代理无法解析 ${host}。请检查服务器 DNS`);
    }
    return httpError(502, `AI 代理下载 ${host} 媒体失败`);
}

function logRequest(req, path, status, durationMs, error) {
    const method = req.method || "";
    const safePath = redactPath(path);
    const message = `${method} ${safePath} -> ${status} ${durationMs}ms${error ? ` (${error})` : ""}`;
    if (status >= 500) console.error(message);
    else if (status >= 400) console.warn(message);
    else console.log(message);
}

function redactPath(path) {
    try {
        const url = new URL(path, "http://proxy.local");
        for (const key of url.searchParams.keys()) {
            if (/key|token|secret|password/i.test(key)) url.searchParams.set(key, "[redacted]");
        }
        return `${url.pathname}${url.search}`;
    } catch {
        return sanitizeErrorMessage(String(path || ""));
    }
}

function sanitizeErrorMessage(message) {
    return String(message || "").replace(/([?&][^=]*(?:key|token|secret|password)[^=]*=)[^&\s)]+/gi, "$1[redacted]");
}
