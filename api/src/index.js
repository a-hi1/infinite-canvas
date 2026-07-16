import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { URL } from "node:url";

import { createDb, publicJob, publicUser } from "./db.js";
import { CLOUD_ERROR_REASON, JOB_SOURCE, JOB_STATUS, SAVE_STATUS } from "./model/cloud-domain.js";
import { createUsersRepo } from "./repositories/users-repo.js";
import { createSessionsRepo } from "./repositories/sessions-repo.js";
import { createJobsRepo } from "./repositories/jobs-repo.js";
import { createFilesRepo } from "./repositories/files-repo.js";
import {
    clearCookie,
    clientIp,
    ensureDir,
    extForMime,
    fail,
    hashPassword,
    isPrivateOrLocalHost,
    isValidEmail,
    json,
    parseCookies,
    parseMultipart,
    randomId,
    randomToken,
    readBody,
    safeJoin,
    setCookie,
    sniffMime,
    verifyPassword,
} from "./util.js";

const port = Number(process.env.PORT || 8080);
const dataDir = process.env.DATA_DIR || path.resolve("data");
const uploadsDir = path.join(dataDir, "uploads");
const inviteCode = String(process.env.API_INVITE_CODE || "").trim();
const sessionTtlSec = Number(process.env.API_SESSION_TTL_SEC || 7 * 24 * 3600);
const cookieSecure = String(process.env.API_COOKIE_SECURE || "").toLowerCase() === "true";
const maxBodyBytes = Number(process.env.API_MAX_BODY_BYTES || 220 * 1024 * 1024);
const maxImageBytes = Number(process.env.API_MAX_IMAGE_BYTES || 20 * 1024 * 1024);
const maxVideoBytes = Number(process.env.API_MAX_VIDEO_BYTES || 200 * 1024 * 1024);
const maxUserBytes = Number(process.env.API_MAX_USER_BYTES || 5 * 1024 * 1024 * 1024);
const maxRemoteRedirects = Math.min(5, Math.max(0, Number(process.env.API_REMOTE_FETCH_MAX_REDIRECTS || 3)));
const allowedOrigins = String(process.env.API_ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    // Credentialed cookie API must never honor wildcard origins.
    .filter((s) => s !== "*");
// When true (default), browser same-origin calls via reverse proxy are allowed if
// Origin matches Host / X-Forwarded-Host + X-Forwarded-Proto. Explicit whitelist still wins.
// Disable only for hardened multi-host setups that rely solely on API_ALLOWED_ORIGINS.
const trustProxySameOrigin = String(process.env.API_TRUST_PROXY_SAME_ORIGIN || "true").toLowerCase() !== "false";

const SESSION_COOKIE = "ic_session";
const loginHits = new Map();
const registerHits = new Map();
const uploadHits = new Map();

function requestIdOf(req) {
    return String(req.headers["x-request-id"] || "").trim() || randomId();
}

function withRequestId(res, requestId) {
    if (requestId) res.setHeader("X-Request-Id", requestId);
}

function logInfo(requestId, message, extra = undefined) {
    console.log(`[api][${requestId}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`);
}

function logWarn(requestId, message, extra = undefined) {
    console.warn(`[api][${requestId}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`);
}

function logError(requestId, message, extra = undefined) {
    console.error(`[api][${requestId}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`);
}

ensureDir(uploadsDir);
const db = createDb(dataDir);
const usersRepo = createUsersRepo(db);
const sessionsRepo = createSessionsRepo(db);
const jobsRepo = createJobsRepo(db);
const filesRepo = createFilesRepo(db);
// Keep JSON session table small before Postgres; does not affect active logins.
try {
    const pruned = sessionsRepo.pruneExpired();
    if (pruned > 0) console.log(`pruned ${pruned} expired/revoked sessions`);
} catch (error) {
    console.error("session prune failed", error);
}
setInterval(() => {
    try {
        sessionsRepo.pruneExpired();
    } catch (error) {
        console.error("session prune failed", error);
    }
}, 60 * 60 * 1000).unref?.();

const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestId = requestIdOf(req);
    withRequestId(res, requestId);
    const origin = req.headers.origin || "";
    setCors(res, origin, req);

    if (req.method === "OPTIONS") {
        res.writeHead(isOriginAllowed(origin, req) ? 204 : 403);
        res.end();
        return;
    }

    try {
        if (origin && !isOriginAllowed(origin, req)) {
            logWarn(requestId, "origin rejected", { origin, publicOrigin: getRequestPublicOrigin(req), method: req.method, url: req.url });
            fail(res, 403, originRejectMessage(origin, req), CLOUD_ERROR_REASON.ORIGIN_NOT_ALLOWED);
            return;
        }

        const url = new URL(req.url || "/", "http://api.local");
        const pathname = url.pathname.replace(/\/+$/, "") || "/";

        if (req.method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
            json(res, 200, {
                ok: true,
                auth: true,
                inviteRequired: Boolean(inviteCode),
                dataDir,
                uploadsDir,
                allowedOriginCount: allowedOrigins.length,
                trustProxySameOrigin,
                envProxy: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy),
            });
            return;
        }

        // strip optional /api prefix when proxied inconsistently
        const route = pathname.startsWith("/api") ? pathname.slice(4) || "/" : pathname;

        // Always await async handlers so rejections are converted to JSON instead of crashing the process.
        if (req.method === "POST" && route === "/auth/register") return await handleRegister(req, res);
        if (req.method === "POST" && route === "/auth/login") return await handleLogin(req, res);
        if (req.method === "POST" && route === "/auth/logout") return await handleLogout(req, res);
        if (req.method === "GET" && route === "/auth/me") return await handleMe(req, res);

        if (req.method === "GET" && route === "/jobs") return await handleListJobs(req, res, url);
        if (req.method === "GET" && route.startsWith("/jobs/")) return await handleGetJob(req, res, route.slice("/jobs/".length));
        if (req.method === "DELETE" && route.startsWith("/jobs/")) return await handleDeleteJob(req, res, route.slice("/jobs/".length));
        if (req.method === "POST" && route === "/jobs/image") return await handleUploadJob(req, res, "image");
        if (req.method === "POST" && route === "/jobs/video") return await handleUploadJob(req, res, "video");
        // Browser cannot fetch imgen/vidgen due to CORS; server pulls allowlisted URL then stores.
        if (req.method === "POST" && route === "/jobs/image/from-url") return await handleUploadJobFromUrl(req, res, "image");
        if (req.method === "POST" && route === "/jobs/video/from-url") return await handleUploadJobFromUrl(req, res, "video");

        if (req.method === "GET" && route.startsWith("/files/")) return await handleGetFile(req, res, route.slice("/files/".length));

        fail(res, 404, "接口不存在");
        logWarn(requestId, "route not found", { method: req.method, url: req.url, ms: Date.now() - startedAt });
    } catch (error) {
        const status = error.status || 500;
        if (!res.headersSent) fail(res, status, error.status ? error.message : "服务器错误");
        if (error.status) {
            logWarn(requestId, "request failed", { status, method: req.method, url: req.url, ms: Date.now() - startedAt, message: error.message });
        } else {
            logError(requestId, "request crashed", { status, method: req.method, url: req.url, ms: Date.now() - startedAt, message: error?.message || String(error) });
        }
    }
});

server.listen(port, "0.0.0.0", () => {
    console.log(`API listening on 0.0.0.0:${port}`);
    console.log(`data dir: ${dataDir}; invite required: ${Boolean(inviteCode)}; env proxy: ${Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy)}`);
});

function setCors(res, origin, req) {
    if (origin && isOriginAllowed(origin, req)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
}

/** First value of a possibly comma-stacked proxy header. */
function firstHeaderValue(value) {
    return String(value || "")
        .split(",")[0]
        .trim();
}

/**
 * Rebuild the browser-facing origin from reverse-proxy headers.
 * Nginx/Caddy should pass X-Forwarded-Proto / Host (see nginx.conf).
 */
function getRequestPublicOrigin(req) {
    if (!req?.headers) return "";
    const xfHost = firstHeaderValue(req.headers["x-forwarded-host"]);
    const host = xfHost || firstHeaderValue(req.headers.host);
    if (!host) return "";
    // Basic host sanity: no spaces / scheme injection
    if (/[\s/]/.test(host) || host.includes("://")) return "";
    const xfProto = firstHeaderValue(req.headers["x-forwarded-proto"]).toLowerCase();
    const proto = xfProto === "https" || xfProto === "http" ? xfProto : "http";
    return `${proto}://${host}`;
}

function isOriginAllowed(origin, req) {
    // No Origin (same-origin form navigation / curl / server-side) is allowed.
    if (!origin) return true;
    if (allowedOrigins.includes(origin)) return true;
    // Same-origin SPA → /api via reverse proxy (typical self-host: http://IP:3001).
    // Still rejects true cross-site Origins that don't match this request's public Host.
    if (trustProxySameOrigin && req) {
        const publicOrigin = getRequestPublicOrigin(req);
        if (publicOrigin && publicOrigin === origin) return true;
    }
    return false;
}

function originRejectMessage(origin, req) {
    const publicOrigin = req ? getRequestPublicOrigin(req) : "";
    const received = String(origin || "").slice(0, 200);
    if (publicOrigin && received && publicOrigin !== received) {
        return `来源不被允许（Origin: ${received}；当前 Host 视角: ${publicOrigin}）。请用与地址栏一致的网址访问，或把该 Origin 写入服务器 API_ALLOWED_ORIGINS 后重启 api`;
    }
    return `来源不被允许（Origin: ${received || "空"}）。自部署请确认经同源 /api 访问；或将浏览器地址栏的协议+主机+端口写入 API_ALLOWED_ORIGINS 后执行 docker compose up -d api`;
}

function rateLimit(map, key, limit, windowMs) {
    const now = Date.now();
    const item = map.get(key);
    if (!item || item.resetAt <= now) {
        map.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    item.count += 1;
    return item.count <= limit;
}

async function readJson(req) {
    const raw = await readBody(req, Math.min(maxBodyBytes, 1024 * 1024));
    if (!raw.length) return {};
    try {
        return JSON.parse(raw.toString("utf8"));
    } catch {
        throw Object.assign(new Error("JSON 无效"), { status: 400 });
    }
}

function getSessionUser(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    const token = cookies[SESSION_COOKIE];
    if (!token) return { user: null, token: "" };
    const session = sessionsRepo.findByToken(token);
    if (!session) return { user: null, token };
    const user = usersRepo.findById(session.user_id);
    if (!user || user.status !== "active") return { user: null, token };
    return { user, token };
}

function requireUser(req, res) {
    const { user, token } = getSessionUser(req);
    if (!user) {
        fail(res, 401, "请先登录", CLOUD_ERROR_REASON.AUTH_REQUIRED);
        return null;
    }
    return { user, token };
}

async function handleRegister(req, res) {
    const ip = clientIp(req);
    if (!rateLimit(registerHits, ip, 5, 60 * 60 * 1000)) return fail(res, 429, "注册过于频繁，请稍后再试", CLOUD_ERROR_REASON.REGISTER_RATE_LIMITED);

    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const displayName = String(body.display_name || body.displayName || "").trim();
    const code = String(body.invite_code || body.inviteCode || "").trim();

    if (!isValidEmail(email)) return fail(res, 400, "邮箱格式不正确", CLOUD_ERROR_REASON.INVALID_EMAIL);
    if (password.length < 8) return fail(res, 400, "密码至少 8 位", CLOUD_ERROR_REASON.WEAK_PASSWORD);
    if (inviteCode && code !== inviteCode) return fail(res, 403, "邀请码无效", CLOUD_ERROR_REASON.INVITE_CODE_INVALID);
    if (usersRepo.findByEmail(email)) return fail(res, 409, "该邮箱已注册", CLOUD_ERROR_REASON.EMAIL_ALREADY_REGISTERED);

    const passwordHash = await hashPassword(password);
    const user = usersRepo.create({ email, passwordHash, displayName });
    const token = issueSession(req, res, user.id);
    json(res, 200, { user: publicUser(user), session: Boolean(token) }, "注册成功");
}

async function handleLogin(req, res) {
    const ip = clientIp(req);
    if (!rateLimit(loginHits, ip, 10, 60 * 1000)) return fail(res, 429, "登录过于频繁，请稍后再试", CLOUD_ERROR_REASON.LOGIN_RATE_LIMITED);

    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = usersRepo.findByEmail(email);
    if (!user) return fail(res, 401, "邮箱或密码错误", CLOUD_ERROR_REASON.LOGIN_INVALID_CREDENTIALS);
    if (user.status !== "active") return fail(res, 403, "账号不可用", CLOUD_ERROR_REASON.ACCOUNT_DISABLED);
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) return fail(res, 429, "账号暂时锁定，请稍后再试", CLOUD_ERROR_REASON.ACCOUNT_TEMPORARILY_LOCKED);

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
        user.failed_login_count = (user.failed_login_count || 0) + 1;
        if (user.failed_login_count >= 8) {
            user.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
            user.failed_login_count = 0;
        }
        usersRepo.update(user);
        return fail(res, 401, "邮箱或密码错误", CLOUD_ERROR_REASON.LOGIN_INVALID_CREDENTIALS);
    }

    user.failed_login_count = 0;
    user.locked_until = null;
    usersRepo.update(user);
    issueSession(req, res, user.id);
    json(res, 200, { user: publicUser(user) }, "登录成功");
}

function handleLogout(req, res) {
    const { token } = getSessionUser(req);
    if (token) sessionsRepo.revokeByToken(token);
    clearCookie(res, SESSION_COOKIE, { secure: cookieSecure });
    json(res, 200, { ok: true }, "已退出");
}

function handleMe(req, res) {
    const { user } = getSessionUser(req);
    if (!user) {
        json(res, 200, { user: null, usage: null, limits: publicLimits() });
        return;
    }
    // usage 供前端账号区展示；limits 方便以后计费/套餐扩展而不改契约形态
    json(res, 200, {
        user: publicUser(user),
        usage: {
            used_bytes: filesRepo.countUserBytes(user.id),
            job_count: jobsRepo.countForUser(user.id),
            image_job_count: jobsRepo.countForUser(user.id, "image"),
            video_job_count: jobsRepo.countForUser(user.id, "video"),
        },
        limits: publicLimits(),
    });
}

function publicLimits() {
    return {
        max_user_bytes: maxUserBytes,
        max_image_bytes: maxImageBytes,
        max_video_bytes: maxVideoBytes,
    };
}

function issueSession(req, res, userId) {
    const token = randomToken(32);
    sessionsRepo.create({
        userId,
        token,
        ip: clientIp(req),
        userAgent: String(req.headers["user-agent"] || ""),
        ttlSec: sessionTtlSec,
    });
    // Force flush so a quick refresh after login still hits a persisted session on disk.
    db.flush();
    setCookie(res, SESSION_COOKIE, token, {
        maxAge: sessionTtlSec,
        httpOnly: true,
        secure: cookieSecure,
        sameSite: "Lax",
        path: "/",
    });
    return token;
}

function handleListJobs(req, res, url) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const type = url.searchParams.get("type") || "";
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("page_size") || 20)));
    const result = jobsRepo.listForUser(auth.user.id, { type: type || undefined, page, pageSize });
    const items = result.items.map((job) => {
        const file = job.result_file_id ? filesRepo.findForUser(job.result_file_id, auth.user.id) : null;
        return publicJob(job, file);
    });
    json(res, 200, { ...result, items });
}

function handleGetJob(req, res, jobId) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const job = jobsRepo.findForUser(jobId, auth.user.id);
    if (!job) return fail(res, 404, "任务不存在");
    const file = job.result_file_id ? filesRepo.findForUser(job.result_file_id, auth.user.id) : null;
    json(res, 200, publicJob(job, file));
}

function handleDeleteJob(req, res, jobId) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const job = jobsRepo.findForUser(jobId, auth.user.id);
    if (!job) return fail(res, 404, "任务不存在");
    const fileIds = [job.result_file_id, job.cover_file_id].filter(Boolean);
    const storageKeys = fileIds.map((id) => filesRepo.findForUser(id, auth.user.id)?.storage_key).filter(Boolean);
    jobsRepo.deleteForUser(jobId, auth.user.id);
    for (const key of storageKeys) {
        try {
            const abs = safeJoin(uploadsDir, ...String(key).split("/"));
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } catch {
            // ignore disk cleanup errors
        }
    }
    json(res, 200, { ok: true });
}

async function handleUploadJob(req, res, type) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const ip = clientIp(req);
    if (!rateLimit(uploadHits, `${auth.user.id}:${ip}`, 60, 60 * 60 * 1000)) return fail(res, 429, "上传过于频繁", CLOUD_ERROR_REASON.UPLOAD_RATE_LIMITED);

    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("multipart/form-data")) return fail(res, 400, "请使用 multipart 上传");

    const raw = await readBody(req, maxBodyBytes);
    const { fields, file } = parseMultipart(raw, contentType);
    if (!file?.data?.length) return fail(res, 400, "缺少文件");

    const sniffed = sniffMime(file.data) || file.mime || "";
    const allowed =
        type === "image"
            ? ["image/jpeg", "image/png", "image/webp"]
            : ["video/mp4", "video/webm"];
    if (!allowed.includes(sniffed)) return fail(res, 400, `不支持的文件类型: ${sniffed || "unknown"}`);

    const maxBytes = type === "image" ? maxImageBytes : maxVideoBytes;
    if (file.data.length > maxBytes) return fail(res, 413, "文件过大");

    let params = {};
    try {
        params = fields.params_json ? JSON.parse(fields.params_json) : {};
    } catch {
        params = {};
    }

    const clientLocalId = String(fields.client_local_id || "").trim();
    // Idempotent retry: same user + type + client_local_id returns existing job (no double disk / future double charge).
    if (clientLocalId) {
        const existing = jobsRepo.findByClientLocalId(auth.user.id, type, clientLocalId);
        if (existing) {
            const existingFile = existing.result_file_id ? filesRepo.findForUser(existing.result_file_id, auth.user.id) : null;
            if (existingFile) {
                // verify blob still on disk
                try {
                    const absExisting = safeJoin(uploadsDir, ...String(existingFile.storage_key).split("/"));
                    if (fs.existsSync(absExisting)) {
                        return json(res, 200, publicJob(existing, existingFile, { deduped: true }), "已存在相同本机结果，未重复上传");
                    }
                } catch {
                    // fall through to rewrite file
                }
            }
            // Job row exists but file missing: rewrite file and relink (still one logical job).
            if (filesRepo.countUserBytes(auth.user.id) + file.data.length > maxUserBytes) return fail(res, 413, "云端存储空间不足", CLOUD_ERROR_REASON.STORAGE_QUOTA_EXCEEDED);
            const repaired = writeUserFile({
                userId: auth.user.id,
                type,
                sniffed,
                bytes: file.data,
                width: Number(fields.width || 0) || 0,
                height: Number(fields.height || 0) || 0,
                durationMs: Number(fields.duration_ms || 0) || 0,
                filename: file.filename,
            });
            repaired.job_id = existing.id;
            jobsRepo.updateResultFile(existing.id, auth.user.id, repaired.id);
            if (existingFile) filesRepo.softDeleteForUser(existingFile.id, auth.user.id);
            db.flush();
            const job = jobsRepo.findForUser(existing.id, auth.user.id);
            return json(res, 200, publicJob(job, repaired, { deduped: true, repaired: true }), "已修复云端文件");
        }
    }

    if (filesRepo.countUserBytes(auth.user.id) + file.data.length > maxUserBytes) return fail(res, 413, "云端存储空间不足", CLOUD_ERROR_REASON.STORAGE_QUOTA_EXCEEDED);

    const fileRow = writeUserFile({
        userId: auth.user.id,
        type,
        sniffed,
        bytes: file.data,
        width: Number(fields.width || 0) || 0,
        height: Number(fields.height || 0) || 0,
        durationMs: Number(fields.duration_ms || 0) || 0,
        filename: file.filename,
    });

    const job = jobsRepo.create({
        userId: auth.user.id,
        type,
        status: JOB_STATUS.SUCCESS,
        prompt: String(fields.prompt || ""),
        model: String(fields.model || ""),
        params,
        resultFileId: fileRow.id,
        clientLocalId,
        source: JOB_SOURCE.CLIENT_UPLOAD,
        provider: String(fields.provider || ""),
        saveStatus: SAVE_STATUS.STORED,
    });
    fileRow.job_id = job.id;
    db.flush();

    json(res, 200, publicJob(job, fileRow, { deduped: false }), "已保存到云端历史");
}

function writeUserFile({ userId, type, sniffed, bytes, width, height, durationMs, filename }) {
    const fileId = randomId();
    const ext = extForMime(sniffed) || path.extname(filename || "") || (type === "image" ? ".png" : ".mp4");
    const relKey = path.posix.join(userId, type === "image" ? "images" : "videos", `${fileId}${ext}`);
    const abs = safeJoin(uploadsDir, ...relKey.split("/"));
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, bytes);
    return filesRepo.create({
        userId,
        kind: type,
        storageKey: relKey,
        mime: sniffed,
        bytes: bytes.length,
        width,
        height,
        durationMs,
    });
}

async function handleUploadJobFromUrl(req, res, type) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const ip = clientIp(req);
    if (!rateLimit(uploadHits, `${auth.user.id}:${ip}`, 60, 60 * 60 * 1000)) return fail(res, 429, "上传过于频繁", CLOUD_ERROR_REASON.UPLOAD_RATE_LIMITED);

    const body = await readJson(req);
    const remoteUrl = String(body.url || body.remote_url || "").trim();
    const clientLocalId = String(body.client_local_id || body.clientLocalId || "").trim();
    const prompt = String(body.prompt || "");
    const model = String(body.model || "");
    const provider = String(body.provider || "");
    const width = Number(body.width || 0) || 0;
    const height = Number(body.height || 0) || 0;
    const durationMs = Number(body.duration_ms || body.durationMs || 0) || 0;
    let params = body.params && typeof body.params === "object" ? body.params : {};

    if (!remoteUrl) return fail(res, 400, "缺少 url");

    if (clientLocalId) {
        const existing = jobsRepo.findByClientLocalId(auth.user.id, type, clientLocalId);
        if (existing) {
            const existingFile = existing.result_file_id ? filesRepo.findForUser(existing.result_file_id, auth.user.id) : null;
            if (existingFile) {
                try {
                    const absExisting = safeJoin(uploadsDir, ...String(existingFile.storage_key).split("/"));
                    if (fs.existsSync(absExisting)) {
                        return json(res, 200, publicJob(existing, existingFile, { deduped: true }), "已存在相同本机结果，未重复上传");
                    }
                } catch {
                    // continue fetch
                }
            }
        }
    }

    const fetched = await fetchAllowlistedMedia(remoteUrl, type);
    if (filesRepo.countUserBytes(auth.user.id) + fetched.bytes.length > maxUserBytes) return fail(res, 413, "云端存储空间不足", CLOUD_ERROR_REASON.STORAGE_QUOTA_EXCEEDED);

    // re-check dedupe after fetch in case concurrent upload finished
    if (clientLocalId) {
        const existing = jobsRepo.findByClientLocalId(auth.user.id, type, clientLocalId);
        if (existing) {
            const existingFile = existing.result_file_id ? filesRepo.findForUser(existing.result_file_id, auth.user.id) : null;
            if (existingFile) {
                try {
                    const absExisting = safeJoin(uploadsDir, ...String(existingFile.storage_key).split("/"));
                    if (fs.existsSync(absExisting)) {
                        return json(res, 200, publicJob(existing, existingFile, { deduped: true }), "已存在相同本机结果，未重复上传");
                    }
                } catch {
                    // repair below
                }
            }
            const repaired = writeUserFile({
                userId: auth.user.id,
                type,
                sniffed: fetched.mime,
                bytes: fetched.bytes,
                width: width || 0,
                height: height || 0,
                durationMs,
                filename: fetched.filename,
            });
            repaired.job_id = existing.id;
            jobsRepo.updateResultFile(existing.id, auth.user.id, repaired.id);
            if (existingFile) filesRepo.softDeleteForUser(existingFile.id, auth.user.id);
            db.flush();
            const job = jobsRepo.findForUser(existing.id, auth.user.id);
            return json(res, 200, publicJob(job, repaired, { deduped: true, repaired: true, source: JOB_SOURCE.SERVER_FETCH }), "已修复云端文件");
        }
    }

    const fileRow = writeUserFile({
        userId: auth.user.id,
        type,
        sniffed: fetched.mime,
        bytes: fetched.bytes,
        width,
        height,
        durationMs,
        filename: fetched.filename,
    });
    const job = jobsRepo.create({
        userId: auth.user.id,
        type,
        status: JOB_STATUS.SUCCESS,
        prompt,
        model,
        params: { ...params, remote_url: remoteUrl },
        resultFileId: fileRow.id,
        clientLocalId,
        source: JOB_SOURCE.SERVER_FETCH,
        provider,
        saveStatus: SAVE_STATUS.STORED,
    });
    fileRow.job_id = job.id;
    db.flush();
    json(res, 200, publicJob(job, fileRow, { deduped: false, source: JOB_SOURCE.SERVER_FETCH }), "已从远程拉取并保存到云端历史");
}

function isAllowedMediaHost(hostname) {
    const host = String(hostname || "")
        .toLowerCase()
        .replace(/\.$/, "");
    if (!host || isPrivateOrLocalHost(host)) return false;
    const exact = new Set(["imgen.x.ai", "vidgen.x.ai", "cdn.x.ai", "x.ai"]);
    if (exact.has(host)) return true;
    // Keep CDN suffixes for temporary media; still blocked if DNS resolves private (assertPublicResolvedHost).
    const suffixes = [".imgen.x.ai", ".vidgen.x.ai", ".cdn.x.ai", ".x.ai", ".amazonaws.com", ".cloudfront.net", ".r2.dev"];
    return suffixes.some((s) => host.endsWith(s));
}

/** Reject URL credentials and DNS that points at private networks (SSRF / rebinding). */
async function assertSafeRemoteMediaUrl(remoteUrl) {
    let parsed;
    try {
        parsed = new URL(remoteUrl);
    } catch {
        throw Object.assign(new Error("远程地址无效"), { status: 400 });
    }
    if (parsed.protocol !== "https:") throw Object.assign(new Error("仅允许 https 远程媒体"), { status: 400 });
    if (parsed.username || parsed.password) throw Object.assign(new Error("远程地址不允许携带账号信息"), { status: 400 });
    if (!isAllowedMediaHost(parsed.hostname)) throw Object.assign(new Error("远程媒体域名不在白名单"), { status: 403 });
    await assertPublicResolvedHost(parsed.hostname);
    return parsed;
}

async function assertPublicResolvedHost(hostname) {
    if (isPrivateOrLocalHost(hostname)) {
        throw Object.assign(new Error("远程媒体域名不在白名单"), { status: 403 });
    }
    let records;
    try {
        records = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
        throw Object.assign(new Error("远程媒体域名无法解析"), { status: 502 });
    }
    if (!records?.length) throw Object.assign(new Error("远程媒体域名无法解析"), { status: 502 });
    for (const record of records) {
        if (isPrivateOrLocalHost(record.address)) {
            throw Object.assign(new Error("远程媒体解析到内网地址，已拒绝"), { status: 403 });
        }
    }
}

async function fetchAllowlistedMedia(remoteUrl, type, redirectLeft = maxRemoteRedirects) {
    const parsed = await assertSafeRemoteMediaUrl(remoteUrl);

    // 视频默认更长：能出网时尽量下完；出网不通则到点失败并给出可操作提示。
    // 可用环境变量覆盖：API_REMOTE_FETCH_TIMEOUT_MS
    const defaultTimeout = type === "video" ? 90000 : 15000;
    const fetchTimeoutMs = Number(process.env.API_REMOTE_FETCH_TIMEOUT_MS || defaultTimeout);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    let response;
    try {
        response = await fetch(parsed.toString(), {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
                Accept: type === "image" ? "image/*,*/*" : "video/*,*/*",
                // 部分 CDN 对无 UA 请求不友好
                "User-Agent": "infinite-canvas-api/0.1",
            },
        });
    } catch (error) {
        const cause = error && typeof error === "object" ? error.cause || error : error;
        const code = String(cause?.code || error?.code || "");
        const name = String(error?.name || "");
        let msg = "拉取远程媒体失败";
        if (name === "AbortError" || code.includes("TIMEOUT") || code.includes("ABORT")) {
            msg = `拉取远程媒体超时（${Math.round(fetchTimeoutMs / 1000)}s）。本机/容器访问不了 imgen/vidgen 时会失败：可配置 ai-proxy 出网后重试生成以落盘，或浏览器打开视频链接下载后导入`;
        } else if (code.includes("ECONNREFUSED") || code.includes("ENOTFOUND") || code.includes("ECONNRESET") || code.includes("UND_ERR") || code.includes("EAI_AGAIN")) {
            msg = "服务器无法连接远程媒体（DNS/出网失败）。中转站视频链在浏览器也因 CORS 无法直读；请启动可访问外网的 ai-proxy 后重试，或手动下载导入";
        }
        throw Object.assign(new Error(msg), { status: 502 });
    } finally {
        clearTimeout(timer);
    }

    // Do not follow redirects to non-allowlisted / private hosts; hop-limited for safety.
    if (response.status >= 300 && response.status < 400) {
        if (redirectLeft <= 0) throw Object.assign(new Error("远程媒体重定向次数过多"), { status: 502 });
        const location = response.headers.get("location") || "";
        if (!location) throw Object.assign(new Error("远程媒体重定向无效"), { status: 502 });
        let next;
        try {
            next = new URL(location, parsed);
        } catch {
            throw Object.assign(new Error("远程媒体重定向无效"), { status: 502 });
        }
        // Re-run full safety checks on every hop (host allowlist + DNS private reject).
        return fetchAllowlistedMedia(next.toString(), type, redirectLeft - 1);
    }

    if (!response.ok) throw Object.assign(new Error(`远程媒体返回 ${response.status}`), { status: 502 });

    const maxBytes = type === "image" ? maxImageBytes : maxVideoBytes;
    const len = Number(response.headers.get("content-length") || 0);
    if (len && len > maxBytes) throw Object.assign(new Error("远程文件过大"), { status: 413 });

    const ab = await response.arrayBuffer();
    const buf = Buffer.from(ab);
    if (!buf.length) throw Object.assign(new Error("远程文件为空"), { status: 502 });
    if (buf.length > maxBytes) throw Object.assign(new Error("远程文件过大"), { status: 413 });

    const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const sniffed = sniffMime(buf) || contentType;
    const allowed = type === "image" ? ["image/jpeg", "image/png", "image/webp"] : ["video/mp4", "video/webm"];
    // CDN 常返回 application/octet-stream；扩展名 .mp4 时按视频接受
    let mime = allowed.includes(sniffed) ? sniffed : sniffMime(buf);
    if (!allowed.includes(mime) && type === "video") {
        if (contentType === "application/octet-stream" || contentType === "binary/octet-stream" || !contentType) {
            if (/\.(mp4|m4v|webm)(?:$|\?)/i.test(parsed.pathname) || /\.mp4(?:$|\?)/i.test(remoteUrl)) {
                mime = parsed.pathname.toLowerCase().includes(".webm") ? "video/webm" : "video/mp4";
            }
        }
    }
    if (!allowed.includes(mime) && type === "image" && (contentType === "application/octet-stream" || !contentType)) {
        const magic = sniffMime(buf);
        if (allowed.includes(magic)) mime = magic;
    }
    if (!allowed.includes(mime)) throw Object.assign(new Error(`远程文件类型不受支持: ${sniffed || contentType || "unknown"}`), { status: 400 });

    return { bytes: buf, mime, filename: path.basename(parsed.pathname) || (type === "image" ? "remote.jpg" : "remote.mp4") };
}

function handleGetFile(req, res, fileId) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const id = fileId.split(/[/?#]/)[0];
    const file = filesRepo.findForUser(id, auth.user.id);
    if (!file) return fail(res, 404, "文件不存在");

    const abs = safeJoin(uploadsDir, ...String(file.storage_key).split("/"));
    if (!fs.existsSync(abs)) return fail(res, 404, "文件已丢失");

    const stat = fs.statSync(abs);
    const size = stat.size;
    const range = req.headers.range;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", file.mime || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=3600");

    if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
        if (!m) return fail(res, 416, "Range 无效");
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return fail(res, 416, "Range 无效");
        end = Math.min(end, size - 1);
        res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": end - start + 1,
            "Content-Type": file.mime || "application/octet-stream",
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=3600",
        });
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
    }

    res.writeHead(200, {
        "Content-Length": size,
        "Content-Type": file.mime || "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
    });
    fs.createReadStream(abs).pipe(res);
}
