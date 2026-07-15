import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

import { createDb, publicJob, publicUser } from "./db.js";
import {
    clearCookie,
    clientIp,
    ensureDir,
    extForMime,
    fail,
    hashPassword,
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
const allowedOrigins = String(process.env.API_ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const SESSION_COOKIE = "ic_session";
const loginHits = new Map();
const registerHits = new Map();
const uploadHits = new Map();

ensureDir(uploadsDir);
const db = createDb(dataDir);

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || "";
    setCors(res, origin);

    if (req.method === "OPTIONS") {
        res.writeHead(isOriginAllowed(origin) ? 204 : 403);
        res.end();
        return;
    }

    try {
        if (origin && !isOriginAllowed(origin)) {
            fail(res, 403, "来源不被允许");
            return;
        }

        const url = new URL(req.url || "/", "http://api.local");
        const pathname = url.pathname.replace(/\/+$/, "") || "/";

        if (req.method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
            json(res, 200, { ok: true, auth: true, inviteRequired: Boolean(inviteCode) });
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
    } catch (error) {
        if (!res.headersSent) {
            const status = error.status || 500;
            fail(res, status, error.status ? error.message : "服务器错误");
        }
        if (!error.status) console.error(error);
    }
});

server.listen(port, "0.0.0.0", () => {
    console.log(`API listening on 0.0.0.0:${port}`);
    console.log(`data dir: ${dataDir}; invite required: ${Boolean(inviteCode)}`);
});

function setCors(res, origin) {
    if (origin && isOriginAllowed(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
}

function isOriginAllowed(origin) {
    if (!origin) return true;
    if (allowedOrigins.includes("*")) return true;
    return allowedOrigins.includes(origin);
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
    const session = db.findSessionByToken(token);
    if (!session) return { user: null, token };
    const user = db.findUserById(session.user_id);
    if (!user || user.status !== "active") return { user: null, token };
    return { user, token };
}

function requireUser(req, res) {
    const { user, token } = getSessionUser(req);
    if (!user) {
        fail(res, 401, "请先登录");
        return null;
    }
    return { user, token };
}

async function handleRegister(req, res) {
    const ip = clientIp(req);
    if (!rateLimit(registerHits, ip, 5, 60 * 60 * 1000)) return fail(res, 429, "注册过于频繁，请稍后再试");

    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const displayName = String(body.display_name || body.displayName || "").trim();
    const code = String(body.invite_code || body.inviteCode || "").trim();

    if (!isValidEmail(email)) return fail(res, 400, "邮箱格式不正确");
    if (password.length < 8) return fail(res, 400, "密码至少 8 位");
    if (inviteCode && code !== inviteCode) return fail(res, 403, "邀请码无效");
    if (db.findUserByEmail(email)) return fail(res, 409, "该邮箱已注册");

    const passwordHash = await hashPassword(password);
    const user = db.createUser({ email, passwordHash, displayName });
    const token = issueSession(req, res, user.id);
    json(res, 200, { user: publicUser(user), session: Boolean(token) }, "注册成功");
}

async function handleLogin(req, res) {
    const ip = clientIp(req);
    if (!rateLimit(loginHits, ip, 10, 60 * 1000)) return fail(res, 429, "登录过于频繁，请稍后再试");

    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = db.findUserByEmail(email);
    if (!user) return fail(res, 401, "邮箱或密码错误");
    if (user.status !== "active") return fail(res, 403, "账号不可用");
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) return fail(res, 429, "账号暂时锁定，请稍后再试");

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
        user.failed_login_count = (user.failed_login_count || 0) + 1;
        if (user.failed_login_count >= 8) {
            user.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
            user.failed_login_count = 0;
        }
        db.updateUser(user);
        return fail(res, 401, "邮箱或密码错误");
    }

    user.failed_login_count = 0;
    user.locked_until = null;
    db.updateUser(user);
    issueSession(req, res, user.id);
    json(res, 200, { user: publicUser(user) }, "登录成功");
}

function handleLogout(req, res) {
    const { token } = getSessionUser(req);
    if (token) db.revokeSessionByToken(token);
    clearCookie(res, SESSION_COOKIE, { secure: cookieSecure });
    json(res, 200, { ok: true }, "已退出");
}

function handleMe(req, res) {
    const { user } = getSessionUser(req);
    json(res, 200, { user: publicUser(user) });
}

function issueSession(req, res, userId) {
    const token = randomToken(32);
    db.createSession({
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
    const result = db.listJobsForUser(auth.user.id, { type: type || undefined, page, pageSize });
    const items = result.items.map((job) => {
        const file = job.result_file_id ? db.findFileForUser(job.result_file_id, auth.user.id) : null;
        return publicJob(job, file);
    });
    json(res, 200, { ...result, items });
}

function handleGetJob(req, res, jobId) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const job = db.findJobForUser(jobId, auth.user.id);
    if (!job) return fail(res, 404, "任务不存在");
    const file = job.result_file_id ? db.findFileForUser(job.result_file_id, auth.user.id) : null;
    json(res, 200, publicJob(job, file));
}

function handleDeleteJob(req, res, jobId) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const job = db.findJobForUser(jobId, auth.user.id);
    if (!job) return fail(res, 404, "任务不存在");
    const fileIds = [job.result_file_id, job.cover_file_id].filter(Boolean);
    const storageKeys = fileIds.map((id) => db.findFileForUser(id, auth.user.id)?.storage_key).filter(Boolean);
    db.deleteJobForUser(jobId, auth.user.id);
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
    if (!rateLimit(uploadHits, `${auth.user.id}:${ip}`, 60, 60 * 60 * 1000)) return fail(res, 429, "上传过于频繁");

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
        const existing = db.findJobByClientLocalId(auth.user.id, type, clientLocalId);
        if (existing) {
            const existingFile = existing.result_file_id ? db.findFileForUser(existing.result_file_id, auth.user.id) : null;
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
            if (db.countUserBytes(auth.user.id) + file.data.length > maxUserBytes) return fail(res, 413, "云端存储空间不足");
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
            db.updateJobResultFile(existing.id, auth.user.id, repaired.id);
            if (existingFile) db.softDeleteFile(existingFile.id, auth.user.id);
            db.flush();
            const job = db.findJobForUser(existing.id, auth.user.id);
            return json(res, 200, publicJob(job, repaired, { deduped: true, repaired: true }), "已修复云端文件");
        }
    }

    if (db.countUserBytes(auth.user.id) + file.data.length > maxUserBytes) return fail(res, 413, "云端存储空间不足");

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

    const job = db.createJob({
        userId: auth.user.id,
        type,
        status: "success",
        prompt: String(fields.prompt || ""),
        model: String(fields.model || ""),
        params,
        resultFileId: fileRow.id,
        clientLocalId,
        source: "client_upload",
        provider: String(fields.provider || ""),
        saveStatus: "stored",
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
    return db.createFile({
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
    if (!rateLimit(uploadHits, `${auth.user.id}:${ip}`, 60, 60 * 60 * 1000)) return fail(res, 429, "上传过于频繁");

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
        const existing = db.findJobByClientLocalId(auth.user.id, type, clientLocalId);
        if (existing) {
            const existingFile = existing.result_file_id ? db.findFileForUser(existing.result_file_id, auth.user.id) : null;
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
    if (db.countUserBytes(auth.user.id) + fetched.bytes.length > maxUserBytes) return fail(res, 413, "云端存储空间不足");

    // re-check dedupe after fetch in case concurrent upload finished
    if (clientLocalId) {
        const existing = db.findJobByClientLocalId(auth.user.id, type, clientLocalId);
        if (existing) {
            const existingFile = existing.result_file_id ? db.findFileForUser(existing.result_file_id, auth.user.id) : null;
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
            db.updateJobResultFile(existing.id, auth.user.id, repaired.id);
            if (existingFile) db.softDeleteFile(existingFile.id, auth.user.id);
            db.flush();
            const job = db.findJobForUser(existing.id, auth.user.id);
            return json(res, 200, publicJob(job, repaired, { deduped: true, repaired: true, source: "server_fetch" }), "已修复云端文件");
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
    const job = db.createJob({
        userId: auth.user.id,
        type,
        status: "success",
        prompt,
        model,
        params: { ...params, remote_url: remoteUrl },
        resultFileId: fileRow.id,
        clientLocalId,
        source: "server_fetch",
        provider,
        saveStatus: "stored",
    });
    fileRow.job_id = job.id;
    db.flush();
    json(res, 200, publicJob(job, fileRow, { deduped: false, source: "server_fetch" }), "已从远程拉取并保存到云端历史");
}

function isPrivateIp(hostname) {
    // hostname may be IP literal
    if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
}

function isAllowedMediaHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    if (!host || isPrivateIp(host)) return false;
    const exact = new Set(["imgen.x.ai", "vidgen.x.ai", "cdn.x.ai", "x.ai"]);
    if (exact.has(host)) return true;
    const suffixes = [".imgen.x.ai", ".vidgen.x.ai", ".cdn.x.ai", ".x.ai", ".amazonaws.com", ".cloudfront.net", ".r2.dev"];
    return suffixes.some((s) => host.endsWith(s));
}

async function fetchAllowlistedMedia(remoteUrl, type) {
    let parsed;
    try {
        parsed = new URL(remoteUrl);
    } catch {
        throw Object.assign(new Error("远程地址无效"), { status: 400 });
    }
    if (parsed.protocol !== "https:") throw Object.assign(new Error("仅允许 https 远程媒体"), { status: 400 });
    if (!isAllowedMediaHost(parsed.hostname)) throw Object.assign(new Error("远程媒体域名不在白名单"), { status: 403 });

    // Keep timeout short: local Docker often cannot reach imgen/vidgen at all; fail fast instead of hanging UI.
    const fetchTimeoutMs = Number(process.env.API_REMOTE_FETCH_TIMEOUT_MS || 8000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    let response;
    try {
        response = await fetch(remoteUrl, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: { Accept: type === "image" ? "image/*,*/*" : "video/*,*/*" },
        });
    } catch (error) {
        const cause = error && typeof error === "object" ? error.cause || error : error;
        const code = String(cause?.code || error?.code || "");
        const name = String(error?.name || "");
        let msg = "拉取远程媒体失败";
        if (name === "AbortError" || code.includes("TIMEOUT")) {
            msg = `拉取远程媒体超时（${Math.round(fetchTimeoutMs / 1000)}s）。当前服务器访问不了 imgen/vidgen 时会失败，请改用本机已落盘结果，或下载后导入`;
        } else if (code.includes("ECONNREFUSED") || code.includes("ENOTFOUND") || code.includes("ECONNRESET") || code.includes("UND_ERR")) {
            msg = "服务器无法连接远程媒体（容器出网被拒/DNS失败）。请改用本机已落盘文件，或下载后导入素材";
        }
        throw Object.assign(new Error(msg), { status: 502 });
    } finally {
        clearTimeout(timer);
    }

    // Do not follow redirects to non-allowlisted hosts.
    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") || "";
        if (!location) throw Object.assign(new Error("远程媒体重定向无效"), { status: 502 });
        let next;
        try {
            next = new URL(location, remoteUrl);
        } catch {
            throw Object.assign(new Error("远程媒体重定向无效"), { status: 502 });
        }
        if (next.protocol !== "https:" || !isAllowedMediaHost(next.hostname)) {
            throw Object.assign(new Error("远程媒体重定向目标不被允许"), { status: 403 });
        }
        return fetchAllowlistedMedia(next.toString(), type);
    }

    if (!response.ok) throw Object.assign(new Error(`远程媒体返回 ${response.status}`), { status: 502 });

    const maxBytes = type === "image" ? maxImageBytes : maxVideoBytes;
    const len = Number(response.headers.get("content-length") || 0);
    if (len && len > maxBytes) throw Object.assign(new Error("远程文件过大"), { status: 413 });

    const ab = await response.arrayBuffer();
    const buf = Buffer.from(ab);
    if (!buf.length) throw Object.assign(new Error("远程文件为空"), { status: 502 });
    if (buf.length > maxBytes) throw Object.assign(new Error("远程文件过大"), { status: 413 });

    const sniffed = sniffMime(buf) || String(response.headers.get("content-type") || "").split(";")[0].trim();
    const allowed = type === "image" ? ["image/jpeg", "image/png", "image/webp"] : ["video/mp4", "video/webm"];
    // Some CDNs return octet-stream; accept if magic matched earlier or content-type vague but magic ok.
    const mime = allowed.includes(sniffed) ? sniffed : sniffMime(buf);
    if (!allowed.includes(mime)) throw Object.assign(new Error(`远程文件类型不受支持: ${sniffed || "unknown"}`), { status: 400 });

    return { bytes: buf, mime, filename: path.basename(parsed.pathname) || (type === "image" ? "remote.jpg" : "remote.mp4") };
}

function handleGetFile(req, res, fileId) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const id = fileId.split(/[/?#]/)[0];
    const file = db.findFileForUser(id, auth.user.id);
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
