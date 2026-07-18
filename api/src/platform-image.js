/**
 * Server-side OpenAI-compatible image generation / edit for platform billing path.
 * Only used when API_PLATFORM_IMAGE_ENABLED=true; never reads browser API keys.
 */

import { CLOUD_ERROR_REASON } from "./model/cloud-domain.js";

export const PLATFORM_IMAGE_REF_LIMIT = 4;
export const PLATFORM_IMAGE_REF_MAX_BYTES = 12 * 1024 * 1024;

function normalizeBaseUrl(value) {
    return String(value || "")
        .trim()
        .replace(/\/+$/, "");
}

function buildUrl(baseUrl, path) {
    const base = normalizeBaseUrl(baseUrl);
    const suffix = path.startsWith("/") ? path : `/${path}`;
    if (/\/v1$/i.test(base) || /\/api\/v3$/i.test(base)) return `${base}${suffix.replace(/^\/v1/, "")}`;
    if (suffix.startsWith("/v1/")) return `${base}${suffix}`;
    return `${base}/v1${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

function readErrorMessage(payload, fallback) {
    if (!payload || typeof payload !== "object") return fallback;
    return payload.error?.message || payload.message || payload.msg || fallback;
}

function platformError(message, status, reason) {
    const err = new Error(message);
    err.status = status;
    err.reason = reason;
    return err;
}

async function parseUpstreamImageResponse(response, controller) {
    const text = await response.text();
    let payload = null;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        payload = null;
    }
    if (!response.ok) {
        throw platformError(
            readErrorMessage(payload, `上游生图失败（${response.status}）`),
            response.status >= 400 && response.status < 600 ? response.status : 502,
            CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED,
        );
    }
    const item = payload?.data?.[0];
    const b64 = item?.b64_json || item?.b64Json;
    if (b64) {
        const bytes = Buffer.from(b64, "base64");
        if (!bytes.length) {
            throw platformError("上游未返回图片数据", 502, CLOUD_ERROR_REASON.PLATFORM_NO_IMAGE);
        }
        return { mime: "image/png", bytes };
    }
    const url = item?.url;
    if (url && /^https?:\/\//i.test(url)) {
        const imgRes = await fetch(url, { signal: controller.signal });
        if (!imgRes.ok) {
            throw platformError(`上游图片 URL 下载失败（${imgRes.status}）`, 502, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
        }
        const ab = await imgRes.arrayBuffer();
        const bytes = Buffer.from(ab);
        if (!bytes.length) {
            throw platformError("上游图片为空", 502, CLOUD_ERROR_REASON.PLATFORM_NO_IMAGE);
        }
        const contentType = String(imgRes.headers.get("content-type") || "")
            .split(";")[0]
            .trim()
            .toLowerCase();
        const mime = contentType.startsWith("image/") ? contentType : "image/png";
        return { mime, bytes };
    }
    throw platformError("上游没有返回 b64_json 或 url", 502, CLOUD_ERROR_REASON.PLATFORM_NO_IMAGE);
}

function wrapUpstreamCatch(error) {
    if (error?.reason) throw error;
    const name = String(error?.name || "");
    if (name === "AbortError") {
        throw platformError("上游生图超时", 504, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
    }
    throw platformError(error?.message || "上游生图失败", 502, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
}

/**
 * Decode browser data URL images for platform edit path.
 * @returns {{ mime: string, bytes: Buffer, filename: string }}
 */
export function decodePlatformReferenceDataUrl(dataUrl, index = 0) {
    const raw = String(dataUrl || "").trim();
    const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(raw);
    if (!match) {
        throw platformError("参考图必须是 png/jpeg/webp 的 data URL", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    let mime = match[1].toLowerCase();
    if (mime === "image/jpg") mime = "image/jpeg";
    const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (!bytes.length) {
        throw platformError("参考图为空", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    if (bytes.length > PLATFORM_IMAGE_REF_MAX_BYTES) {
        throw platformError(`参考图过大（单张上限 ${Math.floor(PLATFORM_IMAGE_REF_MAX_BYTES / 1024 / 1024)}MB）`, 413, CLOUD_ERROR_REASON.PAYLOAD_TOO_LARGE);
    }
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    return { mime, bytes, filename: `ref-${index + 1}.${ext}` };
}

/**
 * @returns {Promise<{ mime: string, bytes: Buffer, model: string, mode: "generation" | "edit" }>}
 */
export async function generateOnePlatformImage({
    baseUrl,
    apiKey,
    model,
    prompt,
    size = "",
    quality = "",
    timeoutMs = 120000,
    references = [],
}) {
    const refs = Array.isArray(references) ? references.slice(0, PLATFORM_IMAGE_REF_LIMIT) : [];
    if (refs.length) {
        return editOnePlatformImage({ baseUrl, apiKey, model, prompt, size, quality, timeoutMs, references: refs });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const body = {
            model,
            prompt,
            n: 1,
            response_format: "b64_json",
        };
        if (quality) body.quality = quality;
        if (size) body.size = size;

        const response = await fetch(buildUrl(baseUrl, "/images/generations"), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const parsed = await parseUpstreamImageResponse(response, controller);
        return { ...parsed, model, mode: "generation" };
    } catch (error) {
        wrapUpstreamCatch(error);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * OpenAI-compatible /images/edits with one or more reference images.
 * @param {{ mime: string, bytes: Buffer, filename?: string }[]} references
 */
export async function editOnePlatformImage({
    baseUrl,
    apiKey,
    model,
    prompt,
    size = "",
    quality = "",
    timeoutMs = 120000,
    references = [],
}) {
    if (!references.length) {
        throw platformError("图生图至少需要一张参考图", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    }
    if (references.length > PLATFORM_IMAGE_REF_LIMIT) {
        throw platformError(`参考图最多 ${PLATFORM_IMAGE_REF_LIMIT} 张`, 400, CLOUD_ERROR_REASON.BAD_REQUEST);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const form = new FormData();
        form.set("model", model);
        form.set("prompt", prompt);
        form.set("n", "1");
        form.set("response_format", "b64_json");
        if (quality) form.set("quality", quality);
        if (size) form.set("size", size);
        for (const ref of references) {
            const mime = ref.mime || "image/png";
            const filename = ref.filename || "image.png";
            const bytes = Buffer.isBuffer(ref.bytes) ? ref.bytes : Buffer.from(ref.bytes || []);
            if (!bytes.length) {
                throw platformError("参考图为空", 400, CLOUD_ERROR_REASON.BAD_REQUEST);
            }
            if (bytes.length > PLATFORM_IMAGE_REF_MAX_BYTES) {
                throw platformError(`参考图过大（单张上限 ${Math.floor(PLATFORM_IMAGE_REF_MAX_BYTES / 1024 / 1024)}MB）`, 413, CLOUD_ERROR_REASON.PAYLOAD_TOO_LARGE);
            }
            form.append("image", new Blob([bytes], { type: mime }), filename);
        }

        const response = await fetch(buildUrl(baseUrl, "/images/edits"), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            body: form,
            signal: controller.signal,
        });
        const parsed = await parseUpstreamImageResponse(response, controller);
        return { ...parsed, model, mode: "edit" };
    } catch (error) {
        wrapUpstreamCatch(error);
    } finally {
        clearTimeout(timer);
    }
}
