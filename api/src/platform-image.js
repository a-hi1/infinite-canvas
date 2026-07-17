/**
 * Server-side OpenAI-compatible image generation for platform billing path.
 * Only used when API_PLATFORM_IMAGE_ENABLED=true; never reads browser API keys.
 */

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

/**
 * @returns {Promise<{ mime: string, bytes: Buffer, model: string }>}
 */
export async function generateOnePlatformImage({
    baseUrl,
    apiKey,
    model,
    prompt,
    size = "",
    quality = "",
    timeoutMs = 120000,
}) {
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
        const text = await response.text();
        let payload = null;
        try {
            payload = text ? JSON.parse(text) : null;
        } catch {
            payload = null;
        }
        if (!response.ok) {
            const err = new Error(readErrorMessage(payload, `上游生图失败（${response.status}）`));
            err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
            err.reason = "platform_upstream_failed";
            throw err;
        }
        const item = payload?.data?.[0];
        const b64 = item?.b64_json || item?.b64Json;
        if (b64) {
            const bytes = Buffer.from(b64, "base64");
            if (!bytes.length) {
                const err = new Error("上游未返回图片数据");
                err.status = 502;
                err.reason = "platform_no_image";
                throw err;
            }
            return { mime: "image/png", bytes, model };
        }
        const url = item?.url;
        if (url && /^https?:\/\//i.test(url)) {
            const imgRes = await fetch(url, { signal: controller.signal });
            if (!imgRes.ok) {
                const err = new Error(`上游图片 URL 下载失败（${imgRes.status}）`);
                err.status = 502;
                err.reason = "platform_upstream_failed";
                throw err;
            }
            const ab = await imgRes.arrayBuffer();
            const bytes = Buffer.from(ab);
            if (!bytes.length) {
                const err = new Error("上游图片为空");
                err.status = 502;
                err.reason = "platform_no_image";
                throw err;
            }
            const contentType = String(imgRes.headers.get("content-type") || "")
                .split(";")[0]
                .trim()
                .toLowerCase();
            const mime = contentType.startsWith("image/") ? contentType : "image/png";
            return { mime, bytes, model };
        }
        const err = new Error("上游没有返回 b64_json 或 url");
        err.status = 502;
        err.reason = "platform_no_image";
        throw err;
    } catch (error) {
        if (error?.reason) throw error;
        const name = String(error?.name || "");
        if (name === "AbortError") {
            const err = new Error("上游生图超时");
            err.status = 504;
            err.reason = "platform_upstream_failed";
            throw err;
        }
        const err = new Error(error?.message || "上游生图失败");
        err.status = 502;
        err.reason = "platform_upstream_failed";
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
