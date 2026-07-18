import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { URL } from "node:url";

import { createDb, publicCreditLedgerEntry, publicJob, publicProjectMeta, publicUser } from "./db.js";
import { CLOUD_ERROR_REASON, CREDIT_LEDGER_TYPE, JOB_SOURCE, JOB_STATUS, JOB_TYPE, SAVE_STATUS, USER_STATUS } from "./model/cloud-domain.js";
import { createUsersRepo } from "./repositories/users-repo.js";
import { createSessionsRepo } from "./repositories/sessions-repo.js";
import { createJobsRepo } from "./repositories/jobs-repo.js";
import { createFilesRepo } from "./repositories/files-repo.js";
import { createCreditsRepo } from "./repositories/credits-repo.js";
import { createProjectsRepo } from "./repositories/projects-repo.js";
import { createAssetsRepo } from "./repositories/assets-repo.js";
import { decodePlatformReferenceDataUrl, generateOnePlatformImage, PLATFORM_IMAGE_REF_LIMIT } from "./platform-image.js";
import { generateOnePlatformVideo } from "./platform-video.js";
import { findExistingPlatformJob, persistPlatformResultAndCharge } from "./platform-billing.js";
import {
    clearCookie,
    clientIp,
    ensureDir,
    extForMime,
    fail,
    hashPassword,
    httpError,
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
// Optional admin token for manual credit grant only. Empty = admin routes disabled (404/not configured).
const adminToken = String(process.env.API_ADMIN_TOKEN || "").trim();
// Platform image gateway (opt-in). Default off: users keep BYOK local generation.
const platformImageEnabled = String(process.env.API_PLATFORM_IMAGE_ENABLED || "").toLowerCase() === "true";
const platformImageBaseUrl = String(process.env.API_PLATFORM_IMAGE_BASE_URL || "").trim();
const platformImageApiKey = String(process.env.API_PLATFORM_IMAGE_API_KEY || "").trim();
const platformImageModel = String(process.env.API_PLATFORM_IMAGE_MODEL || "gpt-image-2").trim() || "gpt-image-2";
// Price per successful image in cents (integer). Default 10 cents = ¥0.10.
const platformImagePriceCents = Math.max(0, Math.trunc(Number(process.env.API_PLATFORM_IMAGE_PRICE_CENTS || 10) || 10));
const platformImageTimeoutMs = Math.max(15000, Math.trunc(Number(process.env.API_PLATFORM_IMAGE_TIMEOUT_MS || 120000) || 120000));
// Platform video gateway (opt-in, text-to-video OpenAI-compatible only). Default off.
const platformVideoEnabled = String(process.env.API_PLATFORM_VIDEO_ENABLED || "").toLowerCase() === "true";
const platformVideoBaseUrl = String(process.env.API_PLATFORM_VIDEO_BASE_URL || process.env.API_PLATFORM_IMAGE_BASE_URL || "").trim();
const platformVideoApiKey = String(process.env.API_PLATFORM_VIDEO_API_KEY || process.env.API_PLATFORM_IMAGE_API_KEY || "").trim();
const platformVideoModel = String(process.env.API_PLATFORM_VIDEO_MODEL || "sora-2").trim() || "sora-2";
const platformVideoPriceCents = Math.max(0, Math.trunc(Number(process.env.API_PLATFORM_VIDEO_PRICE_CENTS || 50) || 50));
const platformVideoTimeoutMs = Math.max(30000, Math.trunc(Number(process.env.API_PLATFORM_VIDEO_TIMEOUT_MS || 300000) || 300000));
const sessionTtlSec = Number(process.env.API_SESSION_TTL_SEC || 7 * 24 * 3600);
const cookieSecure = String(process.env.API_COOKIE_SECURE || "").toLowerCase() === "true";
const maxBodyBytes = Number(process.env.API_MAX_BODY_BYTES || 220 * 1024 * 1024);
const maxImageBytes = Number(process.env.API_MAX_IMAGE_BYTES || 20 * 1024 * 1024);
const maxVideoBytes = Number(process.env.API_MAX_VIDEO_BYTES || 200 * 1024 * 1024);
const maxUserBytes = Number(process.env.API_MAX_USER_BYTES || 5 * 1024 * 1024 * 1024);
const maxRemoteRedirects = Math.min(5, Math.max(0, Number(process.env.API_REMOTE_FETCH_MAX_REDIRECTS || 3)));
const generateHits = new Map();
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
const creditsRepo = createCreditsRepo(db);
const projectsRepo = createProjectsRepo(db);
const assetsRepo = createAssetsRepo(db);
const maxProjectJsonBytes = Math.min(maxBodyBytes, Math.max(1024 * 1024, Number(process.env.API_MAX_PROJECT_JSON_BYTES || 8 * 1024 * 1024) || 8 * 1024 * 1024));
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
            // Platform readiness only (no secrets / base URLs).
            json(res, 200, {
                ok: true,
                auth: true,
                inviteRequired: Boolean(inviteCode),
                dataDir,
                uploadsDir,
                allowedOriginCount: allowedOrigins.length,
                trustProxySameOrigin,
                envProxy: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy),
                platform: {
                    image_enabled: isPlatformImageReady(),
                    video_enabled: isPlatformVideoReady(),
                    image_model: isPlatformImageReady() ? platformImageModel : "",
                    video_model: isPlatformVideoReady() ? platformVideoModel : "",
                    image_price_cents: platformImagePriceCents,
                    video_price_cents: platformVideoPriceCents,
                    admin_configured: Boolean(adminToken),
                },
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
        if (req.method === "POST" && route === "/jobs/image") return await handleUploadJob(req, res, JOB_TYPE.IMAGE);
        if (req.method === "POST" && route === "/jobs/video") return await handleUploadJob(req, res, JOB_TYPE.VIDEO);
        // Browser cannot fetch imgen/vidgen due to CORS; server pulls allowlisted URL then stores.
        if (req.method === "POST" && route === "/jobs/image/from-url") return await handleUploadJobFromUrl(req, res, JOB_TYPE.IMAGE);
        if (req.method === "POST" && route === "/jobs/video/from-url") return await handleUploadJobFromUrl(req, res, JOB_TYPE.VIDEO);

        if (req.method === "GET" && route.startsWith("/files/")) return await handleGetFile(req, res, route.slice("/files/".length));

        // Credits: user can list own ledger; admin token can grant/adjust (no payment gateway yet).
        if (req.method === "GET" && route === "/credits/ledger") return await handleListOwnCredits(req, res, url);
        if (req.method === "POST" && route === "/admin/credits/grant") return await handleAdminCreditGrant(req, res);

        // Canvas projects (P2 MVP): JSON document sync; local-first, cloud optional.
        if (req.method === "GET" && route === "/projects") return await handleListProjects(req, res);
        if (req.method === "GET" && route.startsWith("/projects/")) return await handleGetProject(req, res, route.slice("/projects/".length));
        if (req.method === "PUT" && route.startsWith("/projects/")) return await handlePutProject(req, res, route.slice("/projects/".length), url);
        if (req.method === "DELETE" && route.startsWith("/projects/")) return await handleDeleteProject(req, res, route.slice("/projects/".length));

        // Canvas/asset media blobs keyed by client storageKey (image:/video:/audio:...).
        if (req.method === "POST" && route === "/blobs") return await handleUploadCanvasBlob(req, res);
        if (req.method === "GET" && route.startsWith("/blobs/by-key/")) return await handleGetCanvasBlobByKey(req, res, decodeURIComponent(route.slice("/blobs/by-key/".length)));

        // Asset library manifest (P2): one user-level document + tombstones; media uses /blobs.
        if (req.method === "GET" && route === "/assets") return await handleGetAssetManifest(req, res);
        if (req.method === "PUT" && route === "/assets") return await handlePutAssetManifest(req, res, url);

        // Platform generation (opt-in server-side; charges credits only on success).
        if (req.method === "POST" && route === "/generate/image") return await handlePlatformGenerateImage(req, res);
        if (req.method === "POST" && route === "/generate/video") return await handlePlatformGenerateVideo(req, res);

        fail(res, 404, "接口不存在", CLOUD_ERROR_REASON.NOT_FOUND);
        logWarn(requestId, "route not found", { method: req.method, url: req.url, ms: Date.now() - startedAt });
    } catch (error) {
        const status = error.status || 500;
        const reason = error.reason || (error.status ? undefined : CLOUD_ERROR_REASON.INTERNAL_ERROR);
        if (!res.headersSent) fail(res, status, error.status ? error.message : "服务器错误", reason);
        if (error.status) {
            logWarn(requestId, "request failed", { status, method: req.method, url: req.url, ms: Date.now() - startedAt, message: error.message, reason });
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
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
}

function handleListProjects(req, res) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const items = projectsRepo.listForUser(auth.user.id).map(publicProjectMeta);
    json(res, 200, { items, total: items.length });
}

function handleGetProject(req, res, projectIdRaw) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const projectId = String(projectIdRaw || "").split(/[/?#]/)[0];
    if (!projectId) return fail(res, 400, "缺少项目 id", CLOUD_ERROR_REASON.BAD_REQUEST);
    const meta = projectsRepo.findForUser(projectId, auth.user.id);
    if (!meta) return fail(res, 404, "项目不存在", CLOUD_ERROR_REASON.NOT_FOUND);
    const document = projectsRepo.readDocument(projectId, auth.user.id);
    if (!document) return fail(res, 404, "项目内容丢失", CLOUD_ERROR_REASON.NOT_FOUND);
    json(res, 200, { meta: publicProjectMeta(meta), project: document });
}

async function handlePutProject(req, res, projectIdRaw, url) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const projectId = String(projectIdRaw || "").split(/[/?#]/)[0];
    if (!projectId) return fail(res, 400, "缺少项目 id", CLOUD_ERROR_REASON.BAD_REQUEST);
    const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
    const body = await readJson(req, maxProjectJsonBytes);
    const project = body?.project && typeof body.project === "object" ? body.project : body;
    if (!project || typeof project !== "object") return fail(res, 400, "缺少项目内容", CLOUD_ERROR_REASON.BAD_REQUEST);
    // Path id wins so clients cannot rewrite another id in body.
    project.id = projectId;
    try {
        const result = projectsRepo.upsert(auth.user.id, project, { force });
        db.flush();
        json(res, 200, { meta: publicProjectMeta(result.meta), project: result.document, created: result.created }, result.created ? "已创建云端画布" : "已保存到云端");
    } catch (error) {
        if (error?.status === 409 && error.cloudProject) {
            const cloudDoc = projectsRepo.readDocument(projectId, auth.user.id);
            return json(
                res,
                409,
                {
                    conflict: true,
                    meta: publicProjectMeta(error.cloudProject),
                    project: cloudDoc,
                },
                error.message || "云端版本更新",
            );
        }
        throw error;
    }
}

function handleDeleteProject(req, res, projectIdRaw) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const projectId = String(projectIdRaw || "").split(/[/?#]/)[0];
    if (!projectId) return fail(res, 400, "缺少项目 id", CLOUD_ERROR_REASON.BAD_REQUEST);
    const deleted = projectsRepo.deleteForUser(projectId, auth.user.id);
    if (!deleted) return fail(res, 404, "项目不存在", CLOUD_ERROR_REASON.NOT_FOUND);
    db.flush();
    json(res, 200, { ok: true, id: projectId }, "已删除云端画布");
}

const CLIENT_STORAGE_KEY_RE = /^(image|video|video-asset|audio|file|video-reference|audio-reference):[A-Za-z0-9_-]+$/;
const ASSET_MANIFEST_JSON_LIMIT = Math.min(maxBodyBytes, 12 * 1024 * 1024);
const ASSET_MAX_ITEMS = 10000;
const ASSET_MAX_TOMBSTONES = 20000;

function normalizeAssetManifestInput(body) {
    const source = body?.manifest && typeof body.manifest === "object" ? body.manifest : body;
    const updatedAt = String(source?.updatedAt || source?.updated_at || "").trim();
    if (!Number.isFinite(Date.parse(updatedAt))) throw httpError("素材清单 updatedAt 无效", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    if (!Array.isArray(source?.assets) || source.assets.length > ASSET_MAX_ITEMS) {
        throw httpError(`assets 必须是数组且最多 ${ASSET_MAX_ITEMS} 条`, 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    if (!Array.isArray(source?.tombstones) || source.tombstones.length > ASSET_MAX_TOMBSTONES) {
        throw httpError(`tombstones 必须是数组且最多 ${ASSET_MAX_TOMBSTONES} 条`, 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    // Keep document extensible but reject invalid top-level rows / huge IDs.
    for (const asset of source.assets) {
        if (!asset || typeof asset !== "object") throw httpError("素材记录无效", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
        const id = String(asset.id || "").trim();
        if (!id || id.length > 160) throw httpError("素材 id 无效", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
        if (!["text", "image", "video"].includes(String(asset.kind || ""))) throw httpError("素材 kind 无效", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    const tombstones = source.tombstones.map((row) => {
        const id = String(row?.id || "").trim();
        const deletedAt = String(row?.deletedAt || row?.deleted_at || "").trim();
        if (!id || id.length > 160 || !Number.isFinite(Date.parse(deletedAt))) throw httpError("素材墓碑无效", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
        return { id, deletedAt };
    });
    return { version: 1, updatedAt, assets: source.assets, tombstones };
}

function handleGetAssetManifest(req, res) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const result = assetsRepo.getForUser(auth.user.id);
    json(res, 200, {
        meta: result.meta
            ? { updated_at: result.meta.updated_at, bytes: result.meta.bytes || 0, asset_count: result.meta.asset_count || 0, tombstone_count: result.meta.tombstone_count || 0 }
            : null,
        manifest: result.manifest,
    });
}

async function handlePutAssetManifest(req, res, url) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
    const body = await readJson(req, ASSET_MANIFEST_JSON_LIMIT);
    const manifest = normalizeAssetManifestInput(body);
    try {
        const result = assetsRepo.putForUser(auth.user.id, manifest, { force });
        db.flush();
        json(res, 200, {
            meta: { updated_at: result.meta.updated_at, bytes: result.meta.bytes, asset_count: result.meta.asset_count, tombstone_count: result.meta.tombstone_count },
            manifest: result.manifest,
            created: result.created,
        }, result.created ? "已创建云端素材清单" : "已保存云端素材清单");
    } catch (error) {
        if (error?.status === 409 && error.cloudAssetManifest) {
            return json(res, 409, { conflict: true, manifest: error.cloudAssetManifest }, error.message || "云端素材清单更新", { reason: CLOUD_ERROR_REASON.SYNC_CONFLICT });
        }
        throw error;
    }
}

/**
 * POST /api/blobs  multipart: client_key + file
 * Idempotent by user + client_key (local storageKey). Used by canvas media sync.
 */
async function handleUploadCanvasBlob(req, res) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const ip = clientIp(req);
    if (!rateLimit(uploadHits, `${auth.user.id}:blob:${ip}`, 120, 60 * 60 * 1000)) {
        return fail(res, 429, "上传过于频繁", CLOUD_ERROR_REASON.UPLOAD_RATE_LIMITED);
    }
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("multipart/form-data")) return fail(res, 400, "请使用 multipart 上传", CLOUD_ERROR_REASON.BAD_REQUEST);

    const raw = await readBody(req, maxBodyBytes);
    const { fields, file } = parseMultipart(raw, contentType);
    if (!file?.data?.length) return fail(res, 400, "缺少文件", CLOUD_ERROR_REASON.BAD_REQUEST);

    const clientKey = String(fields.client_key || fields.clientKey || fields.storage_key || "").trim();
    if (!CLIENT_STORAGE_KEY_RE.test(clientKey)) {
        return fail(res, 400, "client_key 无效（期望 image:/video:/audio: 等本地 storageKey）", CLOUD_ERROR_REASON.BAD_REQUEST);
    }

    const existing = filesRepo.findByClientKey(auth.user.id, clientKey);
    if (existing) {
        try {
            const absExisting = safeJoin(uploadsDir, ...String(existing.storage_key).split("/"));
            if (fs.existsSync(absExisting)) {
                return json(res, 200, publicBlobFile(existing, { deduped: true }), "已存在相同媒体，未重复上传");
            }
        } catch {
            // rewrite below
        }
    }

    const sniffed = sniffMime(file.data) || file.mime || "application/octet-stream";
    const isImage = sniffed.startsWith("image/") || clientKey.startsWith("image:");
    const isVideo = sniffed.startsWith("video/") || clientKey.startsWith("video");
    const maxBytes = isImage ? maxImageBytes : isVideo ? maxVideoBytes : maxBodyBytes;
    if (file.data.length > maxBytes) return fail(res, 413, "文件过大", CLOUD_ERROR_REASON.PAYLOAD_TOO_LARGE);
    if (filesRepo.countUserBytes(auth.user.id) + file.data.length > maxUserBytes) {
        return fail(res, 413, "云端存储空间不足", CLOUD_ERROR_REASON.STORAGE_QUOTA_EXCEEDED);
    }

    const kind = isImage ? "image" : isVideo ? "video" : "file";
    const fileRow = writeUserBlobFile({
        userId: auth.user.id,
        clientKey,
        kind,
        sniffed,
        bytes: file.data,
        filename: file.filename,
    });
    if (existing && existing.id !== fileRow.id) {
        filesRepo.softDeleteForUser(existing.id, auth.user.id);
    }
    db.flush();
    json(res, 200, publicBlobFile(fileRow, { deduped: false }), "已上传画布媒体");
}

function writeUserBlobFile({ userId, clientKey, kind, sniffed, bytes, filename }) {
    const fileId = randomId();
    const ext = extForMime(sniffed) || path.extname(filename || "") || (kind === "image" ? ".png" : kind === "video" ? ".mp4" : ".bin");
    const relKey = path.posix.join(userId, "blobs", `${fileId}${ext}`);
    const abs = safeJoin(uploadsDir, ...relKey.split("/"));
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, bytes);
    return filesRepo.create({
        userId,
        kind,
        storageKey: relKey,
        clientKey,
        mime: sniffed,
        bytes: bytes.length,
        width: 0,
        height: 0,
        durationMs: 0,
    });
}

function publicBlobFile(file, extra = {}) {
    if (!file) return null;
    return {
        id: file.id,
        client_key: file.client_key || "",
        kind: file.kind,
        mime: file.mime,
        bytes: file.bytes,
        url: `/api/files/${file.id}`,
        ...extra,
    };
}

async function handleGetCanvasBlobByKey(req, res, clientKeyRaw) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const clientKey = String(clientKeyRaw || "").split(/[/?#]/)[0];
    if (!CLIENT_STORAGE_KEY_RE.test(clientKey)) {
        return fail(res, 400, "client_key 无效", CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    const file = filesRepo.findByClientKey(auth.user.id, clientKey);
    if (!file) return fail(res, 404, "媒体不存在", CLOUD_ERROR_REASON.NOT_FOUND);
    // Reuse binary streaming path.
    return handleGetFile(req, res, file.id);
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

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {number} [limitBytes] default 1MB; platform image edits may pass larger base64 refs.
 */
async function readJson(req, limitBytes = Math.min(maxBodyBytes, 1024 * 1024)) {
    const raw = await readBody(req, Math.min(maxBodyBytes, Math.max(1024, limitBytes)));
    if (!raw.length) return {};
    try {
        return JSON.parse(raw.toString("utf8"));
    } catch {
        throw httpError("JSON 无效", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    }
}

// Platform image may include up to 4 base64 refs (~12MB each before encoding).
const PLATFORM_IMAGE_JSON_LIMIT = Math.min(maxBodyBytes, 56 * 1024 * 1024);
const PLATFORM_VIDEO_JSON_LIMIT = Math.min(maxBodyBytes, 256 * 1024);

function getSessionUser(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    const token = cookies[SESSION_COOKIE];
    if (!token) return { user: null, token: "" };
    const session = sessionsRepo.findByToken(token);
    if (!session) return { user: null, token };
    const user = usersRepo.findById(session.user_id);
    if (!user || user.status !== USER_STATUS.ACTIVE) return { user: null, token };
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
    if (user.status !== USER_STATUS.ACTIVE) return fail(res, 403, "账号不可用", CLOUD_ERROR_REASON.ACCOUNT_DISABLED);
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
        json(res, 200, { user: null, usage: null, limits: publicLimits(), credits: null });
        return;
    }
    // usage 供前端账号区展示；limits 方便以后计费/套餐扩展而不改契约形态
    // credits 仅展示余额；扣费尚未接入生成路径（默认仍 BYOK）
    const balance = creditsRepo.getBalanceCents(user.id);
    if (typeof user.credit_balance_cents !== "number") user.credit_balance_cents = balance;
    json(res, 200, {
        user: publicUser(user),
        usage: {
            used_bytes: filesRepo.countUserBytes(user.id),
            job_count: jobsRepo.countForUser(user.id),
            image_job_count: jobsRepo.countForUser(user.id, JOB_TYPE.IMAGE),
            video_job_count: jobsRepo.countForUser(user.id, JOB_TYPE.VIDEO),
        },
        limits: publicLimits(),
        credits: publicCredits(user.id),
    });
}

function publicLimits() {
    return {
        max_user_bytes: maxUserBytes,
        max_image_bytes: maxImageBytes,
        max_video_bytes: maxVideoBytes,
    };
}

function publicCredits(userId) {
    const imageReady = isPlatformImageReady();
    const videoReady = isPlatformVideoReady();
    return {
        balance_cents: creditsRepo.getBalanceCents(userId),
        currency: "cny_cents",
        // True if any platform generate path is ready (image and/or video).
        platform_billing_enabled: imageReady || videoReady,
        platform_image_enabled: imageReady,
        platform_video_enabled: videoReady,
        image_price_cents: platformImagePriceCents,
        image_model: imageReady ? platformImageModel : "",
        video_price_cents: platformVideoPriceCents,
        video_model: videoReady ? platformVideoModel : "",
    };
}

function isPlatformImageReady() {
    return platformImageEnabled && Boolean(platformImageBaseUrl) && Boolean(platformImageApiKey);
}

function isPlatformVideoReady() {
    return platformVideoEnabled && Boolean(platformVideoBaseUrl) && Boolean(platformVideoApiKey);
}

/**
 * POST /api/generate/image
 * Server-side text-to-image / image-edit using platform upstream Key (never browser Key).
 * Charge credits only after upstream success; idempotent via client_local_id (same as job upload).
 * Default path remains BYOK in the browser — this route is opt-in.
 *
 * Body JSON:
 * - prompt, size?, quality?, client_local_id?, model?
 * - images?: [{ data_url: "data:image/png;base64,..." }]  // optional refs → /images/edits
 */
async function handlePlatformGenerateImage(req, res) {
    if (!platformImageEnabled) {
        return fail(res, 503, "平台代生成未开启（API_PLATFORM_IMAGE_ENABLED）", CLOUD_ERROR_REASON.PLATFORM_GENERATE_DISABLED);
    }
    if (!platformImageBaseUrl || !platformImageApiKey) {
        return fail(res, 503, "平台生图上游未配置（API_PLATFORM_IMAGE_BASE_URL / API_PLATFORM_IMAGE_API_KEY）", CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_NOT_CONFIGURED);
    }

    const auth = requireUser(req, res);
    if (!auth) return;
    const ip = clientIp(req);
    if (!rateLimit(generateHits, `${auth.user.id}:${ip}`, 30, 60 * 60 * 1000)) {
        return fail(res, 429, "平台生图过于频繁，请稍后再试", CLOUD_ERROR_REASON.UPLOAD_RATE_LIMITED);
    }

    // Larger limit: optional base64 reference images for edits.
    const body = await readJson(req, PLATFORM_IMAGE_JSON_LIMIT);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return fail(res, 400, "请输入提示词", CLOUD_ERROR_REASON.BAD_REQUEST);
    if (prompt.length > 4000) return fail(res, 400, "提示词过长", CLOUD_ERROR_REASON.BAD_REQUEST);

    const clientLocalId = String(body.client_local_id || body.clientLocalId || "").trim();
    const size = String(body.size || "").trim();
    const quality = String(body.quality || "").trim();
    const model = String(body.model || platformImageModel).trim() || platformImageModel;
    // Only allow the configured platform model for now (prevents arbitrary model billing surprises).
    if (model !== platformImageModel) {
        return fail(res, 400, `当前平台仅支持模型 ${platformImageModel}`, CLOUD_ERROR_REASON.BAD_REQUEST);
    }

    let references = [];
    try {
        references = normalizePlatformReferenceInputs(body.images || body.references || []);
    } catch (error) {
        if (error?.status) throw error;
        return fail(res, 400, error?.message || "参考图无效", CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    const mode = references.length ? "edit" : "generation";

    const existing = findExistingPlatformJob({
        jobsRepo,
        filesRepo,
        safeJoin,
        uploadsDir,
        userId: auth.user.id,
        type: JOB_TYPE.IMAGE,
        clientLocalId,
    });
    if (existing) {
        return json(
            res,
            200,
            {
                ...publicJob(existing.job, existing.file, { deduped: true }),
                credits: publicCredits(auth.user.id),
                charged_cents: 0,
            },
            "已存在相同本机请求结果，未重复生成/扣费",
        );
    }

    const price = platformImagePriceCents;
    if (price > 0) {
        const balance = creditsRepo.getBalanceCents(auth.user.id);
        if (balance < price) {
            return fail(res, 402, `积分不足（需要 ${price} 分，当前 ${balance} 分）`, CLOUD_ERROR_REASON.CREDITS_INSUFFICIENT);
        }
    }

    let generated;
    try {
        generated = await generateOnePlatformImage({
            baseUrl: platformImageBaseUrl,
            apiKey: platformImageApiKey,
            model,
            prompt,
            size,
            quality,
            timeoutMs: platformImageTimeoutMs,
            references,
        });
    } catch (error) {
        if (error?.status) throw error;
        throw httpError(error?.message || "平台生图失败", 502, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
    }

    const sniffed = sniffMime(generated.bytes) || generated.mime || "image/png";
    if (!["image/jpeg", "image/png", "image/webp"].includes(sniffed)) {
        return fail(res, 502, `上游返回了不支持的图片类型: ${sniffed}`, CLOUD_ERROR_REASON.PLATFORM_NO_IMAGE);
    }
    if (generated.bytes.length > maxImageBytes) {
        return fail(res, 413, "生成图片过大", CLOUD_ERROR_REASON.PAYLOAD_TOO_LARGE);
    }
    if (filesRepo.countUserBytes(auth.user.id) + generated.bytes.length > maxUserBytes) {
        return fail(res, 413, "云端存储空间不足", CLOUD_ERROR_REASON.STORAGE_QUOTA_EXCEEDED);
    }

    let chargedCents = 0;
    let job;
    let fileRow;
    try {
        const saved = persistPlatformResultAndCharge({
            db,
            jobsRepo,
            filesRepo,
            creditsRepo,
            writeUserFile,
            safeJoin,
            uploadsDir,
            userId: auth.user.id,
            type: JOB_TYPE.IMAGE,
            prompt,
            model,
            params: {
                size,
                quality,
                platform: true,
                price_cents: price,
                mode: generated.mode || mode,
                reference_count: references.length,
            },
            clientLocalId,
            sniffed,
            bytes: generated.bytes,
            width: Number(body.width || 0) || 0,
            height: Number(body.height || 0) || 0,
            durationMs: 0,
            filename: "platform.png",
            priceCents: price,
            chargeNote: references.length ? `平台图生图 ${model}` : `平台文生图 ${model}`,
        });
        job = saved.job;
        fileRow = saved.file;
        chargedCents = saved.chargedCents;
    } catch (error) {
        if (error?.status) throw error;
        throw error;
    }

    json(
        res,
        200,
        {
            ...publicJob(job, fileRow, { deduped: false }),
            credits: publicCredits(auth.user.id),
            charged_cents: chargedCents,
        },
        chargedCents > 0 ? `已生成并扣费 ${chargedCents} 分` : "已生成",
    );
}

/**
 * POST /api/generate/video
 * Server-side OpenAI-compatible text-to-video only (no references).
 * Opt-in via API_PLATFORM_VIDEO_*; default BYOK video path unchanged.
 */
async function handlePlatformGenerateVideo(req, res) {
    if (!platformVideoEnabled) {
        return fail(res, 503, "平台视频代生成未开启（API_PLATFORM_VIDEO_ENABLED）", CLOUD_ERROR_REASON.PLATFORM_GENERATE_DISABLED);
    }
    if (!platformVideoBaseUrl || !platformVideoApiKey) {
        return fail(res, 503, "平台视频上游未配置（API_PLATFORM_VIDEO_BASE_URL / API_PLATFORM_VIDEO_API_KEY）", CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_NOT_CONFIGURED);
    }

    const auth = requireUser(req, res);
    if (!auth) return;
    const ip = clientIp(req);
    if (!rateLimit(generateHits, `${auth.user.id}:video:${ip}`, 10, 60 * 60 * 1000)) {
        return fail(res, 429, "平台生视频过于频繁，请稍后再试", CLOUD_ERROR_REASON.UPLOAD_RATE_LIMITED);
    }

    const body = await readJson(req, PLATFORM_VIDEO_JSON_LIMIT);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return fail(res, 400, "请输入提示词", CLOUD_ERROR_REASON.BAD_REQUEST);
    if (prompt.length > 4000) return fail(res, 400, "提示词过长", CLOUD_ERROR_REASON.BAD_REQUEST);

    // Keep MVP small: no reference media on platform video path.
    if ((Array.isArray(body.images) && body.images.length) || (Array.isArray(body.references) && body.references.length)) {
        return fail(res, 400, "平台视频当前仅支持文生视频，请去掉参考素材或改用自有渠道", CLOUD_ERROR_REASON.BAD_REQUEST);
    }

    const clientLocalId = String(body.client_local_id || body.clientLocalId || "").trim();
    const seconds = String(body.seconds || body.videoSeconds || "4").trim() || "4";
    const size = String(body.size || "").trim();
    const model = String(body.model || platformVideoModel).trim() || platformVideoModel;
    if (model !== platformVideoModel) {
        return fail(res, 400, `当前平台仅支持视频模型 ${platformVideoModel}`, CLOUD_ERROR_REASON.BAD_REQUEST);
    }

    const existing = findExistingPlatformJob({
        jobsRepo,
        filesRepo,
        safeJoin,
        uploadsDir,
        userId: auth.user.id,
        type: JOB_TYPE.VIDEO,
        clientLocalId,
    });
    if (existing) {
        return json(
            res,
            200,
            {
                ...publicJob(existing.job, existing.file, { deduped: true }),
                credits: publicCredits(auth.user.id),
                charged_cents: 0,
            },
            "已存在相同本机请求结果，未重复生成/扣费",
        );
    }

    const price = platformVideoPriceCents;
    if (price > 0) {
        const balance = creditsRepo.getBalanceCents(auth.user.id);
        if (balance < price) {
            return fail(res, 402, `积分不足（需要 ${price} 分，当前 ${balance} 分）`, CLOUD_ERROR_REASON.CREDITS_INSUFFICIENT);
        }
    }

    let generated;
    try {
        generated = await generateOnePlatformVideo({
            baseUrl: platformVideoBaseUrl,
            apiKey: platformVideoApiKey,
            model,
            prompt,
            seconds,
            size,
            timeoutMs: platformVideoTimeoutMs,
        });
    } catch (error) {
        if (error?.status) throw error;
        throw httpError(error?.message || "平台生视频失败", 502, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
    }

    const sniffed = sniffMime(generated.bytes) || generated.mime || "video/mp4";
    if (!["video/mp4", "video/webm"].includes(sniffed) && sniffed !== "video/mp4") {
        // Some upstreams return octet-stream; accept if magic is missing but length is ok.
        if (!sniffed.startsWith("video/") && sniffMime(generated.bytes) !== "video/mp4") {
            // still allow if size looks like a video blob
            if (generated.bytes.length < 1024) {
                return fail(res, 502, `上游返回了不支持的视频类型: ${sniffed || "unknown"}`, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
            }
        }
    }
    if (generated.bytes.length > maxVideoBytes) {
        return fail(res, 413, "生成视频过大", CLOUD_ERROR_REASON.PAYLOAD_TOO_LARGE);
    }
    if (filesRepo.countUserBytes(auth.user.id) + generated.bytes.length > maxUserBytes) {
        return fail(res, 413, "云端存储空间不足", CLOUD_ERROR_REASON.STORAGE_QUOTA_EXCEEDED);
    }

    const finalMime = sniffed.startsWith("video/") ? sniffed : "video/mp4";
    let chargedCents = 0;
    let job;
    let fileRow;
    try {
        const saved = persistPlatformResultAndCharge({
            db,
            jobsRepo,
            filesRepo,
            creditsRepo,
            writeUserFile,
            safeJoin,
            uploadsDir,
            userId: auth.user.id,
            type: JOB_TYPE.VIDEO,
            prompt,
            model,
            params: {
                seconds,
                size,
                platform: true,
                price_cents: price,
                mode: "generation",
                upstream_task_id: generated.upstreamTaskId || "",
            },
            clientLocalId,
            sniffed: finalMime,
            bytes: generated.bytes,
            width: Number(body.width || 0) || 0,
            height: Number(body.height || 0) || 0,
            durationMs: generated.durationMs || 0,
            filename: "platform.mp4",
            priceCents: price,
            chargeNote: `平台文生视频 ${model}`,
        });
        job = saved.job;
        fileRow = saved.file;
        chargedCents = saved.chargedCents;
    } catch (error) {
        if (error?.status) throw error;
        throw error;
    }

    json(
        res,
        200,
        {
            ...publicJob(job, fileRow, { deduped: false }),
            credits: publicCredits(auth.user.id),
            charged_cents: chargedCents,
        },
        chargedCents > 0 ? `已生成并扣费 ${chargedCents} 分` : "已生成",
    );
}

function normalizePlatformReferenceInputs(raw) {
    if (raw == null || raw === "") return [];
    if (!Array.isArray(raw)) {
        throw httpError("images 必须是数组", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    if (raw.length > PLATFORM_IMAGE_REF_LIMIT) {
        throw httpError(`参考图最多 ${PLATFORM_IMAGE_REF_LIMIT} 张`, 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    return raw.map((item, index) => {
        if (typeof item === "string") return decodePlatformReferenceDataUrl(item, index);
        if (item && typeof item === "object") {
            const dataUrl = item.data_url || item.dataUrl || item.url || "";
            return decodePlatformReferenceDataUrl(dataUrl, index);
        }
        throw httpError("参考图格式无效", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    });
}

function handleListOwnCredits(req, res, url) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("page_size") || url.searchParams.get("pageSize") || 20) || 20));
    const result = creditsRepo.listForUser(auth.user.id, { page, pageSize });
    json(res, 200, {
        items: result.items.map(publicCreditLedgerEntry),
        total: result.total,
        page: result.page,
        page_size: result.page_size,
        credits: publicCredits(auth.user.id),
    });
}

/**
 * Admin-only manual credit grant/adjust.
 * Auth: Authorization: Bearer <API_ADMIN_TOKEN> or X-Admin-Token header.
 * Does not use user session cookie — avoids elevating any browser session.
 */
async function handleAdminCreditGrant(req, res) {
    if (!adminToken) {
        return fail(res, 503, "未配置 API_ADMIN_TOKEN，手工加额不可用", CLOUD_ERROR_REASON.ADMIN_NOT_CONFIGURED);
    }
    const headerToken =
        String(req.headers["x-admin-token"] || "").trim() ||
        String(req.headers.authorization || "")
            .replace(/^Bearer\s+/i, "")
            .trim();
    if (!headerToken || headerToken !== adminToken) {
        return fail(res, 401, "管理员令牌无效", CLOUD_ERROR_REASON.ADMIN_UNAUTHORIZED);
    }

    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const userId = String(body.user_id || body.userId || "").trim();
    let user = null;
    if (userId) user = usersRepo.findById(userId);
    else if (email) user = usersRepo.findByEmail(email);
    if (!user) return fail(res, 404, "用户不存在", CLOUD_ERROR_REASON.USER_NOT_FOUND);

    // Prefer amount_cents; accept amount_yuan for operator convenience (converted to integer cents).
    let amountCents = body.amount_cents ?? body.amountCents;
    if (amountCents === undefined || amountCents === null || amountCents === "") {
        const yuan = body.amount_yuan ?? body.amountYuan;
        if (yuan !== undefined && yuan !== null && yuan !== "") {
            amountCents = Math.round(Number(yuan) * 100);
        }
    }
    amountCents = Math.trunc(Number(amountCents));
    if (!Number.isFinite(amountCents) || amountCents === 0) {
        return fail(res, 400, "请提供非 0 的 amount_cents 或 amount_yuan", CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    // Hard cap single grant to reduce fat-finger disasters (100000 yuan).
    if (Math.abs(amountCents) > 10_000_000) {
        return fail(res, 400, "单次加额/调账超过上限（±100000 元）", CLOUD_ERROR_REASON.BAD_REQUEST);
    }

    const typeRaw = String(body.type || CREDIT_LEDGER_TYPE.GRANT).trim().toLowerCase();
    const type = typeRaw === CREDIT_LEDGER_TYPE.ADJUST ? CREDIT_LEDGER_TYPE.ADJUST : CREDIT_LEDGER_TYPE.GRANT;
    const note = String(body.note || body.reason || "").trim();
    const operator = String(body.operator || "admin").trim() || "admin";
    const idempotencyKey = String(body.idempotency_key || body.idempotencyKey || "").trim();

    const result = creditsRepo.append({
        userId: user.id,
        amountCents,
        type,
        note,
        operator,
        idempotencyKey,
        refType: "admin_grant",
        refId: idempotencyKey || "",
    });
    db.flush();
    json(
        res,
        200,
        {
            user: publicUser(result.user),
            entry: publicCreditLedgerEntry(result.entry),
            credits: publicCredits(user.id),
            deduped: Boolean(result.deduped),
        },
        result.deduped ? "已存在相同幂等加额，未重复记账" : "已记账",
    );
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
    if (!job) return fail(res, 404, "任务不存在", CLOUD_ERROR_REASON.NOT_FOUND);
    const file = job.result_file_id ? filesRepo.findForUser(job.result_file_id, auth.user.id) : null;
    json(res, 200, publicJob(job, file));
}

function handleDeleteJob(req, res, jobId) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const job = jobsRepo.findForUser(jobId, auth.user.id);
    if (!job) return fail(res, 404, "任务不存在", CLOUD_ERROR_REASON.NOT_FOUND);
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
    if (!contentType.includes("multipart/form-data")) return fail(res, 400, "请使用 multipart 上传", CLOUD_ERROR_REASON.BAD_REQUEST);

    const raw = await readBody(req, maxBodyBytes);
    const { fields, file } = parseMultipart(raw, contentType);
    if (!file?.data?.length) return fail(res, 400, "缺少文件", CLOUD_ERROR_REASON.BAD_REQUEST);

    const sniffed = sniffMime(file.data) || file.mime || "";
    const allowed = type === JOB_TYPE.IMAGE ? ["image/jpeg", "image/png", "image/webp"] : ["video/mp4", "video/webm"];
    if (!allowed.includes(sniffed)) return fail(res, 400, `不支持的文件类型: ${sniffed || "unknown"}`, CLOUD_ERROR_REASON.UNSUPPORTED_MEDIA_TYPE);

    const maxBytes = type === JOB_TYPE.IMAGE ? maxImageBytes : maxVideoBytes;
    if (file.data.length > maxBytes) return fail(res, 413, "文件过大", CLOUD_ERROR_REASON.PAYLOAD_TOO_LARGE);

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
    const ext = extForMime(sniffed) || path.extname(filename || "") || (type === JOB_TYPE.IMAGE ? ".png" : ".mp4");
    const relKey = path.posix.join(userId, type === JOB_TYPE.IMAGE ? "images" : "videos", `${fileId}${ext}`);
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

    if (!remoteUrl) return fail(res, 400, "缺少 url", CLOUD_ERROR_REASON.BAD_REQUEST);

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
        throw httpError("远程地址无效", 400, CLOUD_ERROR_REASON.REMOTE_FETCH_INVALID_URL);
    }
    if (parsed.protocol !== "https:") throw httpError("仅允许 https 远程媒体", 400, CLOUD_ERROR_REASON.REMOTE_FETCH_INVALID_URL);
    if (parsed.username || parsed.password) throw httpError("远程地址不允许携带账号信息", 400, CLOUD_ERROR_REASON.REMOTE_FETCH_INVALID_URL);
    if (!isAllowedMediaHost(parsed.hostname)) throw httpError("远程媒体域名不在白名单", 403, CLOUD_ERROR_REASON.REMOTE_FETCH_FORBIDDEN_HOST);
    await assertPublicResolvedHost(parsed.hostname);
    return parsed;
}

async function assertPublicResolvedHost(hostname) {
    if (isPrivateOrLocalHost(hostname)) {
        throw httpError("远程媒体域名不在白名单", 403, CLOUD_ERROR_REASON.REMOTE_FETCH_FORBIDDEN_HOST);
    }
    let records;
    try {
        records = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
        throw httpError("远程媒体域名无法解析", 502, CLOUD_ERROR_REASON.REMOTE_FETCH_DNS_FAILED);
    }
    if (!records?.length) throw httpError("远程媒体域名无法解析", 502, CLOUD_ERROR_REASON.REMOTE_FETCH_DNS_FAILED);
    for (const record of records) {
        if (isPrivateOrLocalHost(record.address)) {
            throw httpError("远程媒体解析到内网地址，已拒绝", 403, CLOUD_ERROR_REASON.REMOTE_FETCH_PRIVATE_TARGET);
        }
    }
}

async function fetchAllowlistedMedia(remoteUrl, type, redirectLeft = maxRemoteRedirects) {
    const parsed = await assertSafeRemoteMediaUrl(remoteUrl);

    // 视频默认更长：能出网时尽量下完；出网不通则到点失败并给出可操作提示。
    // 可用环境变量覆盖：API_REMOTE_FETCH_TIMEOUT_MS
    const defaultTimeout = type === JOB_TYPE.VIDEO ? 90000 : 15000;
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
                Accept: type === JOB_TYPE.IMAGE ? "image/*,*/*" : "video/*,*/*",
                // 部分 CDN 对无 UA 请求不友好
                "User-Agent": "infinite-canvas-api/0.1",
            },
        });
    } catch (error) {
        const cause = error && typeof error === "object" ? error.cause || error : error;
        const code = String(cause?.code || error?.code || "");
        const name = String(error?.name || "");
        let msg = "拉取远程媒体失败";
        let reason = CLOUD_ERROR_REASON.REMOTE_FETCH_FAILED;
        if (name === "AbortError" || code.includes("TIMEOUT") || code.includes("ABORT")) {
            msg = `拉取远程媒体超时（${Math.round(fetchTimeoutMs / 1000)}s）。本机/容器访问不了 imgen/vidgen 时会失败：可配置 ai-proxy 出网后重试生成以落盘，或浏览器打开视频链接下载后导入`;
            reason = CLOUD_ERROR_REASON.REMOTE_FETCH_TIMEOUT;
        } else if (code.includes("ECONNREFUSED") || code.includes("ENOTFOUND") || code.includes("ECONNRESET") || code.includes("UND_ERR") || code.includes("EAI_AGAIN")) {
            msg = "服务器无法连接远程媒体（DNS/出网失败）。中转站视频链在浏览器也因 CORS 无法直读；请启动可访问外网的 ai-proxy 后重试，或手动下载导入";
            reason = CLOUD_ERROR_REASON.REMOTE_FETCH_BAD_GATEWAY;
        }
        throw httpError(msg, 502, reason);
    } finally {
        clearTimeout(timer);
    }

    // Do not follow redirects to non-allowlisted / private hosts; hop-limited for safety.
    if (response.status >= 300 && response.status < 400) {
        if (redirectLeft <= 0) throw httpError("远程媒体重定向次数过多", 502, CLOUD_ERROR_REASON.REMOTE_FETCH_TOO_MANY_REDIRECTS);
        const location = response.headers.get("location") || "";
        if (!location) throw httpError("远程媒体重定向无效", 502, CLOUD_ERROR_REASON.REMOTE_FETCH_BAD_GATEWAY);
        let next;
        try {
            next = new URL(location, parsed);
        } catch {
            throw httpError("远程媒体重定向无效", 502, CLOUD_ERROR_REASON.REMOTE_FETCH_BAD_GATEWAY);
        }
        // Re-run full safety checks on every hop (host allowlist + DNS private reject).
        return fetchAllowlistedMedia(next.toString(), type, redirectLeft - 1);
    }

    if (!response.ok) throw httpError(`远程媒体返回 ${response.status}`, 502, CLOUD_ERROR_REASON.REMOTE_FETCH_BAD_GATEWAY);

    const maxBytes = type === JOB_TYPE.IMAGE ? maxImageBytes : maxVideoBytes;
    const len = Number(response.headers.get("content-length") || 0);
    if (len && len > maxBytes) throw httpError("远程文件过大", 413, CLOUD_ERROR_REASON.REMOTE_FETCH_TOO_LARGE);

    const ab = await response.arrayBuffer();
    const buf = Buffer.from(ab);
    if (!buf.length) throw httpError("远程文件为空", 502, CLOUD_ERROR_REASON.REMOTE_FETCH_EMPTY);
    if (buf.length > maxBytes) throw httpError("远程文件过大", 413, CLOUD_ERROR_REASON.REMOTE_FETCH_TOO_LARGE);

    const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const sniffed = sniffMime(buf) || contentType;
    const allowed = type === JOB_TYPE.IMAGE ? ["image/jpeg", "image/png", "image/webp"] : ["video/mp4", "video/webm"];
    // CDN 常返回 application/octet-stream；扩展名 .mp4 时按视频接受
    let mime = allowed.includes(sniffed) ? sniffed : sniffMime(buf);
    if (!allowed.includes(mime) && type === JOB_TYPE.VIDEO) {
        if (contentType === "application/octet-stream" || contentType === "binary/octet-stream" || !contentType) {
            if (/\.(mp4|m4v|webm)(?:$|\?)/i.test(parsed.pathname) || /\.mp4(?:$|\?)/i.test(remoteUrl)) {
                mime = parsed.pathname.toLowerCase().includes(".webm") ? "video/webm" : "video/mp4";
            }
        }
    }
    if (!allowed.includes(mime) && type === JOB_TYPE.IMAGE && (contentType === "application/octet-stream" || !contentType)) {
        const magic = sniffMime(buf);
        if (allowed.includes(magic)) mime = magic;
    }
    if (!allowed.includes(mime)) throw httpError(`远程文件类型不受支持: ${sniffed || contentType || "unknown"}`, 400, CLOUD_ERROR_REASON.REMOTE_FETCH_UNSUPPORTED_TYPE);

    return { bytes: buf, mime, filename: path.basename(parsed.pathname) || (type === JOB_TYPE.IMAGE ? "remote.jpg" : "remote.mp4") };
}

function handleGetFile(req, res, fileId) {
    const auth = requireUser(req, res);
    if (!auth) return;
    const id = fileId.split(/[/?#]/)[0];
    const file = filesRepo.findForUser(id, auth.user.id);
    if (!file) return fail(res, 404, "文件不存在", CLOUD_ERROR_REASON.NOT_FOUND);

    const abs = safeJoin(uploadsDir, ...String(file.storage_key).split("/"));
    if (!fs.existsSync(abs)) return fail(res, 404, "文件已丢失", CLOUD_ERROR_REASON.NOT_FOUND);

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
