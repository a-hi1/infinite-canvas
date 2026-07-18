/**
 * Server-side OpenAI-compatible video generation for platform billing path.
 * Text-to-video only (no references) — keeps surface small; BYOK still handles Grok/Seedance/etc.
 * Only used when API_PLATFORM_VIDEO_ENABLED=true.
 */

import { CLOUD_ERROR_REASON } from "./model/cloud-domain.js";

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

function platformError(message, status, reason) {
    const err = new Error(message);
    err.status = status;
    err.reason = reason;
    return err;
}

function readErrorMessage(payload, fallback) {
    if (!payload || typeof payload !== "object") return fallback;
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.message || payload.message || payload.msg || fallback;
}

function unwrapVideo(payload) {
    if (!payload || typeof payload !== "object") return {};
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) return payload.data;
    return payload;
}

function extractVideoUrl(video) {
    if (!video || typeof video !== "object") return "";
    const candidates = [video.url, video.video_url, video.result_url, video.output_url, video.download_url, video.content?.video_url, video.content?.url];
    for (const value of candidates) {
        if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
    }
    return "";
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create OpenAI-compatible video task, poll until done, return bytes.
 * @returns {Promise<{ mime: string, bytes: Buffer, model: string, upstreamTaskId: string, durationMs: number }>}
 */
export async function generateOnePlatformVideo({
    baseUrl,
    apiKey,
    model,
    prompt,
    seconds = "4",
    size = "",
    timeoutMs = 300000,
}) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const form = new FormData();
        form.set("model", model);
        form.set("prompt", prompt);
        form.set("seconds", String(seconds || "4"));
        if (size) form.set("size", size);

        const createRes = await fetch(buildUrl(baseUrl, "/videos"), {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
            signal: controller.signal,
        });
        const createText = await createRes.text();
        let createPayload = null;
        try {
            createPayload = createText ? JSON.parse(createText) : null;
        } catch {
            createPayload = null;
        }
        if (!createRes.ok) {
            throw platformError(
                readErrorMessage(createPayload, `上游视频创建失败（${createRes.status}）`),
                createRes.status >= 400 && createRes.status < 600 ? createRes.status : 502,
                CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED,
            );
        }
        const created = unwrapVideo(createPayload);
        const taskId = String(created.id || "").trim();
        if (!taskId) {
            // Some relays return URL immediately without task id
            const directUrl = extractVideoUrl(created);
            if (directUrl) {
                const bytes = await downloadVideoBytes(directUrl, controller.signal);
                return { mime: "video/mp4", bytes, model, upstreamTaskId: "", durationMs: Date.now() - started };
            }
            throw platformError("上游视频接口没有返回任务 ID", 502, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
        }

        const pollDeadline = Date.now() + timeoutMs;
        while (Date.now() < pollDeadline) {
            if (controller.signal.aborted) {
                throw platformError("上游视频生成超时", 504, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
            }
            const pollRes = await fetch(buildUrl(baseUrl, `/videos/${taskId}`), {
                method: "GET",
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: controller.signal,
            });
            const pollText = await pollRes.text();
            let pollPayload = null;
            try {
                pollPayload = pollText ? JSON.parse(pollText) : null;
            } catch {
                pollPayload = null;
            }
            if (!pollRes.ok) {
                // transient 404 on some relays right after create
                if (pollRes.status === 404) {
                    await delay(3000);
                    continue;
                }
                throw platformError(
                    readErrorMessage(pollPayload, `上游视频查询失败（${pollRes.status}）`),
                    pollRes.status >= 400 && pollRes.status < 600 ? pollRes.status : 502,
                    CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED,
                );
            }
            const video = unwrapVideo(pollPayload);
            const status = String(video.status || "").toLowerCase();
            const directUrl = extractVideoUrl(video);
            if (directUrl && (status === "completed" || status === "succeeded" || !status)) {
                const bytes = await downloadVideoBytes(directUrl, controller.signal);
                return { mime: "video/mp4", bytes, model, upstreamTaskId: taskId, durationMs: Date.now() - started };
            }
            if (status === "completed" || status === "succeeded") {
                // try /content binary
                try {
                    const contentRes = await fetch(buildUrl(baseUrl, `/videos/${taskId}/content`), {
                        method: "GET",
                        headers: { Authorization: `Bearer ${apiKey}` },
                        signal: controller.signal,
                    });
                    if (contentRes.ok) {
                        const ab = await contentRes.arrayBuffer();
                        const bytes = Buffer.from(ab);
                        if (bytes.length) {
                            const contentType = String(contentRes.headers.get("content-type") || "")
                                .split(";")[0]
                                .trim()
                                .toLowerCase();
                            const mime = contentType.startsWith("video/") ? contentType : "video/mp4";
                            return { mime, bytes, model, upstreamTaskId: taskId, durationMs: Date.now() - started };
                        }
                    }
                } catch {
                    // fall through
                }
                if (directUrl) {
                    const bytes = await downloadVideoBytes(directUrl, controller.signal);
                    return { mime: "video/mp4", bytes, model, upstreamTaskId: taskId, durationMs: Date.now() - started };
                }
                throw platformError("上游视频完成但没有可下载内容", 502, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
            }
            if (status === "failed" || status === "cancelled" || status === "canceled") {
                throw platformError(readErrorMessage(video, "上游视频生成失败"), 502, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
            }
            await delay(3000);
        }
        throw platformError("上游视频生成超时", 504, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
    } catch (error) {
        if (error?.reason) throw error;
        const name = String(error?.name || "");
        if (name === "AbortError") {
            throw platformError("上游视频生成超时", 504, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
        }
        throw platformError(error?.message || "上游视频生成失败", 502, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
    } finally {
        clearTimeout(timer);
    }
}

async function downloadVideoBytes(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) {
        throw platformError(`上游视频下载失败（${res.status}）`, 502, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
    }
    const ab = await res.arrayBuffer();
    const bytes = Buffer.from(ab);
    if (!bytes.length) {
        throw platformError("上游视频为空", 502, CLOUD_ERROR_REASON.PLATFORM_UPSTREAM_FAILED);
    }
    return bytes;
}
