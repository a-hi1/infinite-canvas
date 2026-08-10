import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CLOUD_ERROR_REASON } from "./model/cloud-domain.js";

export function json(res, status, data, msg = "ok", meta = undefined) {
    const body = JSON.stringify({ code: status >= 400 ? status : 0, data, msg, ...(meta && typeof meta === "object" ? meta : {}) });
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}

export function fail(res, status, msg, reason = undefined) {
    json(res, status, null, msg, reason ? { reason } : undefined);
}

/** Throw-shaped HTTP error; route catch reads `status` / `reason` into JSON envelope. */
export function httpError(message, status = 500, reason = undefined) {
    return Object.assign(new Error(message), { status, reason });
}

export function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(Object.assign(new Error("请求体过大"), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

export function parseCookies(header = "") {
    const out = {};
    for (const part of String(header).split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0) continue;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (key) out[key] = decodeURIComponent(value);
    }
    return out;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true, secure = false, sameSite = "Lax", path: cookiePath = "/" } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${cookiePath}`, `SameSite=${sameSite}`];
    if (httpOnly) parts.push("HttpOnly");
    if (secure) parts.push("Secure");
    if (maxAge != null) {
        const seconds = Math.floor(maxAge);
        parts.push(`Max-Age=${seconds}`);
        // Expires improves persistence across some browsers/proxies when only Max-Age is ignored.
        parts.push(`Expires=${new Date(Date.now() + seconds * 1000).toUTCString()}`);
    }
    const prev = res.getHeader("Set-Cookie");
    const next = Array.isArray(prev) ? prev.concat(parts.join("; ")) : prev ? [prev, parts.join("; ")] : parts.join("; ");
    res.setHeader("Set-Cookie", next);
}

export function clearCookie(res, name, { secure = false, sameSite = "Lax", path: cookiePath = "/" } = {}) {
    setCookie(res, name, "", { maxAge: 0, secure, sameSite, path: cookiePath });
}

export function randomId() {
    return crypto.randomUUID();
}

export function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = await scryptAsync(password, salt, 64);
    return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password, stored) {
    const [algo, saltB64, hashB64] = String(stored || "").split("$");
    if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    const actual = await scryptAsync(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

function scryptAsync(password, salt, keylen) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keylen, { N: 16384, r: 8, p: 1 }, (err, key) => {
            if (err) reject(err);
            else resolve(key);
        });
    });
}

export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

export function safeJoin(root, ...parts) {
    const resolved = path.resolve(root, ...parts);
    const rootResolved = path.resolve(root);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
        throw httpError("非法路径", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    return resolved;
}

export function clientIp(req) {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim();
    return forwarded || req.socket.remoteAddress || "";
}

/** IPv4 / IPv6 literals that must never be fetched server-side (SSRF). */
export function isPrivateOrLocalHost(hostname) {
    const host = String(hostname || "")
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "");
    if (!host) return true;
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return true;
    // IPv4 literal
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
    if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (a === 10 || a === 127 || a === 0) return true;
        if (a === 192 && b === 168) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 169 && b === 254) return true;
        if (a >= 224) return true; // multicast / reserved
        return false;
    }
    // Only treat colon-containing values as IPv6 (avoid false positives like hostnames starting with "fc")
    if (host.includes(":")) {
        if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
        if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique local fc00::/7
        if (host.startsWith("fe80")) return true; // link-local
        if (host.startsWith("::ffff:")) return isPrivateOrLocalHost(host.slice("::ffff:".length));
        if (host === "::" || host.startsWith("::")) return true;
    }
    return false;
}

/**
 * Canonical email for auth lookup / uniqueness.
 * - trim + lower-case
 * - NFKC so fullwidth/compat forms collapse
 * Does not rewrite Gmail dots/+tags (would change real addresses).
 */
export function normalizeEmail(email) {
    return String(email || "")
        .normalize("NFKC")
        .trim()
        .toLowerCase();
}

export function isValidEmail(email) {
    const value = normalizeEmail(email);
    // Reject control / whitespace already stripped; still block empty labels.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !value.includes("..") && !value.startsWith(".") && !value.endsWith(".");
}

export function extForMime(mime) {
    if (mime === "image/jpeg") return ".jpg";
    if (mime === "image/png") return ".png";
    if (mime === "image/webp") return ".webp";
    if (mime === "video/mp4") return ".mp4";
    if (mime === "video/webm") return ".webm";
    if (mime === "text/markdown" || mime === "text/x-markdown") return ".md";
    if (mime === "text/plain") return ".txt";
    if (mime === "text/csv" || mime === "application/csv") return ".csv";
    return "";
}

/** Resolve workspace document mime from filename / declared type (text files have no magic). */
export function resolveDocumentMime(filename = "", declaredMime = "") {
    const ext = String(path.extname(filename) || "").toLowerCase();
    if (ext === ".md" || ext === ".markdown") return "text/markdown";
    if (ext === ".txt") return "text/plain";
    if (ext === ".csv") return "text/csv";
    const mime = String(declaredMime || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
    if (mime === "text/markdown" || mime === "text/x-markdown") return "text/markdown";
    if (mime === "text/plain") return "text/plain";
    if (mime === "text/csv" || mime === "application/csv" || mime === "application/vnd.ms-excel") return "text/csv";
    return "";
}

export function sniffMime(buf) {
    if (!buf || buf.length < 12) return "";
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    if (buf.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
    if (buf.toString("ascii", 0, 4) === "\x1aE\xdf\xa3") return "video/webm";
    return "";
}

/** Minimal multipart parser for single-file uploads with fields. */
export function parseMultipart(buffer, contentType) {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
    if (!match) throw httpError("缺少 multipart boundary", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    const boundary = match[1] || match[2];
    const sep = Buffer.from(`--${boundary}`);
    const fields = {};
    let file = null;
    let start = buffer.indexOf(sep) + sep.length;
    while (start < buffer.length) {
        if (buffer[start] === 45 && buffer[start + 1] === 45) break; // --
        if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
        const headerEnd = buffer.indexOf("\r\n\r\n", start);
        if (headerEnd < 0) break;
        const headers = buffer.slice(start, headerEnd).toString("utf8");
        const next = buffer.indexOf(sep, headerEnd + 4);
        const end = next < 0 ? buffer.length : next - 2; // trim trailing CRLF
        const body = buffer.slice(headerEnd + 4, end);
        const nameMatch = /name="([^"]+)"/i.exec(headers);
        const filenameMatch = /filename="([^"]*)"/i.exec(headers);
        const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
        const name = nameMatch?.[1] || "";
        if (filenameMatch) {
            file = {
                field: name,
                filename: filenameMatch[1] || "file",
                mime: (typeMatch?.[1] || "").trim(),
                data: body,
            };
        } else if (name) {
            fields[name] = body.toString("utf8");
        }
        start = next < 0 ? buffer.length : next + sep.length;
    }
    return { fields, file };
}
