import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { blobFromUrl, isCloudApiError, uploadCloudJob, type CloudJob } from "@/services/cloud-api";
import { AI_PROXY_BASE_URL } from "@/stores/use-config-store";
import { useAuthStore } from "@/stores/use-auth-store";

function isRemoteHttpUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function isLocalObjectUrl(value: string) {
    return (value || "").startsWith("blob:") || (value || "").startsWith("data:");
}

function isXaiMediaHost(url: string) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host.includes("vidgen.x.ai") || host.includes("imgen.x.ai") || host.includes("cdn.x.ai") || host === "x.ai" || host.endsWith(".x.ai");
    } catch {
        return /vidgen\.x\.ai|imgen\.x\.ai|cdn\.x\.ai/i.test(url);
    }
}

/** 中转站返回的 xAI 临时链：浏览器 CORS 读不到；优先走同源 /ai-proxy/media 取字节 */
async function tryFetchViaSameOriginMediaProxy(remoteUrl: string): Promise<Blob | null> {
    if (!isRemoteHttpUrl(remoteUrl) || !isXaiMediaHost(remoteUrl)) return null;
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
            throw new Error("请先登录");
        }
        const payload = (await response.json().catch(() => null)) as { code?: number; data?: CloudJob; msg?: string } | null;
        if (!response.ok || !payload || payload.code !== 0 || !payload.data) {
            // 把后端 502 原文透出，方便区分「超时 / 出网失败 / 类型不支持」
            throw new Error(payload?.msg || `远程上云失败（${response.status}）`);
        }
        return payload.data;
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new Error(
                input.type === "video"
                    ? "远程视频上云超时：本机服务器访问 vidgen 太慢或不通。可：① 配置并启动 ai-proxy 后重试生成以落盘 ② 浏览器另开视频链接下载后导入"
                    : "远程上云超时：服务器访问不了 imgen/vidgen。请用本机已落盘结果，或下载后导入",
            );
        }
        throw error;
    } finally {
        window.clearTimeout(timer);
    }
}

function toSaveError(error: unknown, fallback: string) {
    if (isCloudApiError(error)) return error.message || fallback;
    if (error instanceof Error && error.message) return error.message;
    return fallback;
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
                    error: toSaveError(fromUrlError, "远程图上云失败：浏览器 CORS 读不到，服务端也拉不到。可下载后本地导入"),
                };
            }
        }
        return { job: null, error: "没有可上传的本地文件或远程地址" };
    } catch (error) {
        console.warn("cloud image save failed", error);
        return { job: null, error: toSaveError(error, "上传失败") };
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
            // 中转站 + vidgen：浏览器读不到；先试同源 ai-proxy 取字节再 multipart 上云
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
            // 再让服务端直拉远程 CDN（本机/服务器能出网时成功）
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
                return {
                    job: null,
                    error:
                        toSaveError(
                            fromUrlError,
                            "视频可播放但无法上云：浏览器代理不等于 Docker 出网。ai-proxy/api 容器拉不到 vidgen 时会 502。可：① 给容器配置 HTTP_PROXY/HTTPS_PROXY（host.docker.internal:本地代理端口）后重建 api/ai-proxy；② 浏览器下载视频后本地导入再上云；③ 生成时尽量先落盘到本机 storageKey",
                        ),
                };
            }
        }
        return { job: null, error: "没有可上传的本地文件或远程地址" };
    } catch (error) {
        console.warn("cloud video save failed", error);
        return { job: null, error: toSaveError(error, "上传失败") };
    }
}
