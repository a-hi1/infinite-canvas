import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { blobFromUrl, CloudApiError, isCloudApiError, uploadCloudJob, type CloudJob } from "@/services/cloud-api";
import { isAllowedRemoteMediaHost } from "@/lib/remote-media-host";
import { AI_PROXY_BASE_URL } from "@/stores/use-config-store";
import { useAuthStore } from "@/stores/use-auth-store";

function isRemoteHttpUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function isLocalObjectUrl(value: string) {
    return (value || "").startsWith("blob:") || (value || "").startsWith("data:");
}

/** 中转/上游临时链：浏览器 CORS 常读不到；白名单内优先走同源 /ai-proxy/media 取字节再 multipart 上云 */
async function tryFetchViaSameOriginMediaProxy(remoteUrl: string): Promise<Blob | null> {
    if (!isRemoteHttpUrl(remoteUrl) || !isAllowedRemoteMediaHost(remoteUrl)) return null;
    const proxyUrl = `${AI_PROXY_BASE_URL}/media?${new URLSearchParams({ url: remoteUrl }).toString()}`;
    try {
        const response = await fetch(proxyUrl, { credentials: "same-origin" });
        if (!response.ok) return null;
        const blob = await response.blob();
        return blob.size > 0 ? blob : null;
    } catch {
        return null;
    }
}

export type CloudSaveResult = {
    job: CloudJob | null;
    error?: string;
    /** Stable API reason when available (prefer over Chinese error text). */
    reason?: string;
};

async function uploadCloudJobFromUrl(input: {
    type: "image" | "video";
    url: string;
    prompt?: string;
    model?: string;
    provider?: string;
    clientLocalId?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    params?: Record<string, unknown>;
}) {
    const controller = new AbortController();
    // 视频文件较大，给服务端更长时间；图片可短一些
    const timeoutMs = input.type === "video" ? 120000 : 20000;
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`/api/jobs/${input.type}/from-url`, {
            method: "POST",
            credentials: "include",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: input.url,
                prompt: input.prompt || "",
                model: input.model || "",
                provider: input.provider || "",
                client_local_id: input.clientLocalId || "",
                width: input.width || 0,
                height: input.height || 0,
                duration_ms: input.durationMs || 0,
                params: input.params || {},
            }),
        });
        if (response.status === 401) {
            window.dispatchEvent(new CustomEvent("infinite-canvas:cloud-unauthorized"));
            throw new CloudApiError("请先登录", 401, "auth_required");
        }
        const payload = (await response.json().catch(() => null)) as { code?: number; data?: CloudJob; msg?: string; reason?: string } | null;
        if (!response.ok || !payload || payload.code !== 0 || !payload.data) {
            // 把后端 502 原文透出，方便区分「超时 / 出网失败 / 类型不支持」
            throw new CloudApiError(payload?.msg || `远程上云失败（${response.status}）`, response.status, payload?.reason);
        }
        return payload.data;
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new CloudApiError(
                input.type === "video"
                    ? "远程视频上云超时：本机服务器访问 vidgen 太慢或不通。可：① 配置并启动 ai-proxy 后重试生成以落盘 ② 浏览器另开视频链接下载后导入"
                    : "远程上云超时：服务器访问不了 imgen/vidgen。请用本机已落盘结果，或下载后导入",
                0,
                "remote_fetch_timeout",
            );
        }
        throw error;
    } finally {
        window.clearTimeout(timer);
    }
}

function toSaveError(error: unknown, fallback: string): { error: string; reason?: string } {
    if (isCloudApiError(error)) return { error: error.message || fallback, reason: error.reason };
    if (error instanceof Error && error.message) return { error: error.message };
    return { error: fallback };
}

/** Prefer local blob/storageKey; remote HTTP falls back to server-side allowlisted fetch. */
export async function saveImageToCloud(input: {
    dataUrl: string;
    storageKey?: string;
    prompt: string;
    model: string;
    width?: number;
    height?: number;
    clientLocalId?: string;
    params?: Record<string, unknown>;
}): Promise<CloudJob | null> {
    const result = await saveImageToCloudDetailed(input);
    return result.job;
}

export async function saveImageToCloudDetailed(input: {
    dataUrl: string;
    storageKey?: string;
    prompt: string;
    model: string;
    width?: number;
    height?: number;
    clientLocalId?: string;
    params?: Record<string, unknown>;
}): Promise<CloudSaveResult> {
    if (!useAuthStore.getState().user) return { job: null, error: "未登录" };
    try {
        let blob: Blob | null = null;
        if (input.storageKey) {
            blob = (await getImageBlob(input.storageKey)) || null;
        }
        if (!blob && isLocalObjectUrl(input.dataUrl)) {
            blob = await blobFromUrl(input.dataUrl);
        }
        if (blob && blob.size > 0) {
            const job = await uploadCloudJob({
                type: "image",
                file: blob,
                filename: "image.png",
                prompt: input.prompt,
                model: input.model,
                width: input.width,
                height: input.height,
                clientLocalId: input.clientLocalId,
                params: input.params,
            });
            return { job };
        }
        if (isRemoteHttpUrl(input.dataUrl)) {
            const viaProxy = await tryFetchViaSameOriginMediaProxy(input.dataUrl);
            if (viaProxy) {
                const job = await uploadCloudJob({
                    type: "image",
                    file: viaProxy,
                    filename: "image.png",
                    prompt: input.prompt,
                    model: input.model,
                    width: input.width,
                    height: input.height,
                    clientLocalId: input.clientLocalId,
                    params: { ...(input.params || {}), via: "ai-proxy-media" },
                });
                return { job };
            }
            try {
                const job = await uploadCloudJobFromUrl({
                    type: "image",
                    url: input.dataUrl,
                    prompt: input.prompt,
                    model: input.model,
                    width: input.width,
                    height: input.height,
                    clientLocalId: input.clientLocalId,
                    params: input.params,
                });
                return { job };
            } catch (fromUrlError) {
                return {
                    job: null,
                    ...toSaveError(fromUrlError, "远程图上云失败：浏览器 CORS 读不到，服务端也拉不到。可下载后本地导入"),
                };
            }
        }
        return { job: null, error: "没有可上传的本地文件或远程地址" };
    } catch (error) {
        console.warn("cloud image save failed", error);
        return { job: null, ...toSaveError(error, "上传失败") };
    }
}

export async function saveVideoToCloud(input: {
    url: string;
    storageKey?: string;
    prompt: string;
    model: string;
    width?: number;
    height?: number;
    durationMs?: number;
    clientLocalId?: string;
    provider?: string;
    params?: Record<string, unknown>;
}): Promise<CloudJob | null> {
    const result = await saveVideoToCloudDetailed(input);
    return result.job;
}

export async function saveVideoToCloudDetailed(input: {
    url: string;
    storageKey?: string;
    prompt: string;
    model: string;
    width?: number;
    height?: number;
    durationMs?: number;
    clientLocalId?: string;
    provider?: string;
    params?: Record<string, unknown>;
}): Promise<CloudSaveResult> {
    if (!useAuthStore.getState().user) return { job: null, error: "未登录" };
    try {
        let blob: Blob | null = null;
        if (input.storageKey) {
            blob = (await getMediaBlob(input.storageKey)) || null;
        }
        if (!blob && isLocalObjectUrl(input.url)) {
            blob = await blobFromUrl(input.url);
        }
        if (blob && blob.size > 0) {
            const job = await uploadCloudJob({
                type: "video",
                file: blob,
                filename: "video.mp4",
                prompt: input.prompt,
                model: input.model,
                width: input.width,
                height: input.height,
                durationMs: input.durationMs,
                clientLocalId: input.clientLocalId,
                provider: input.provider,
                params: input.params,
            });
            return { job };
        }
        if (isRemoteHttpUrl(input.url)) {
            // 远程 CDN（xAI / Seedance 火山等）：浏览器 CORS 常读不到；先试同源 ai-proxy 再 from-url
            const viaProxy = await tryFetchViaSameOriginMediaProxy(input.url);
            if (viaProxy) {
                const job = await uploadCloudJob({
                    type: "video",
                    file: viaProxy,
                    filename: "video.mp4",
                    prompt: input.prompt,
                    model: input.model,
                    width: input.width,
                    height: input.height,
                    durationMs: input.durationMs,
                    clientLocalId: input.clientLocalId,
                    provider: input.provider,
                    params: { ...(input.params || {}), via: "ai-proxy-media" },
                });
                return { job };
            }
            // 再让服务端直拉远程 CDN（域名须在 api 白名单；容器能出网时成功）
            try {
                const job = await uploadCloudJobFromUrl({
                    type: "video",
                    url: input.url,
                    prompt: input.prompt,
                    model: input.model,
                    width: input.width,
                    height: input.height,
                    durationMs: input.durationMs,
                    clientLocalId: input.clientLocalId,
                    provider: input.provider,
                    params: input.params,
                });
                return { job };
            } catch (fromUrlError) {
                const detail = isCloudApiError(fromUrlError) ? fromUrlError.message : "";
                const hostHint = (() => {
                    try {
                        return new URL(input.url).hostname;
                    } catch {
                        return "";
                    }
                })();
                const seedanceHint =
                    /volces|volcengine|byteimg|bytecdn|bytedance/i.test(hostHint || input.url)
                        ? "当前像 Seedance/火山 CDN；已扩白名单后仍失败多为容器出网或签名链过期。"
                        : "";
                return {
                    job: null,
                    ...toSaveError(
                        fromUrlError,
                        detail ||
                            `视频可播放但无法上云${hostHint ? `（${hostHint}）` : ""}。${seedanceHint}浏览器代理≠Docker 出网；ai-proxy/api 拉不到远程时会 502/403。可：① 给容器配 HTTP_PROXY 后重建 api/ai-proxy；② 浏览器下载后本地导入再上云；③ 生成时尽量先落盘 storageKey`,
                    ),
                };
            }
        }
        return { job: null, error: "没有可上传的本地文件或远程地址" };
    } catch (error) {
        console.warn("cloud video save failed", error);
        return { job: null, ...toSaveError(error, "上传失败") };
    }
}
