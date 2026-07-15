import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { uploadCloudJob, blobFromUrl, type CloudJob } from "@/services/cloud-api";
import { useAuthStore } from "@/stores/use-auth-store";

function isRemoteHttpUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function isLocalObjectUrl(value: string) {
    return (value || "").startsWith("blob:") || (value || "").startsWith("data:");
}

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
    // UI should fail fast when server cannot reach remote CDN.
    const timer = window.setTimeout(() => controller.abort(), 12000);
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
        const payload = (await response.json().catch(() => null)) as { code?: number; data?: CloudJob; msg?: string } | null;
        if (!response.ok || !payload || payload.code !== 0 || !payload.data) {
            throw new Error(payload?.msg || `远程上云失败（${response.status}）`);
        }
        return payload.data;
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new Error("远程上云超时：服务器访问不了 imgen/vidgen 时会失败。请用本机已落盘结果，或下载后导入");
        }
        throw error;
    } finally {
        window.clearTimeout(timer);
    }
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
    if (!useAuthStore.getState().user) return null;
    try {
        let blob: Blob | null = null;
        if (input.storageKey) {
            blob = (await getImageBlob(input.storageKey)) || null;
        }
        if (!blob && isLocalObjectUrl(input.dataUrl)) {
            blob = await blobFromUrl(input.dataUrl);
        }
        if (blob && blob.size > 0) {
            return await uploadCloudJob({
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
        }
        if (isRemoteHttpUrl(input.dataUrl)) {
            return await uploadCloudJobFromUrl({
                type: "image",
                url: input.dataUrl,
                prompt: input.prompt,
                model: input.model,
                width: input.width,
                height: input.height,
                clientLocalId: input.clientLocalId,
                params: input.params,
            });
        }
        return null;
    } catch (error) {
        console.warn("cloud image save failed", error);
        return null;
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
    if (!useAuthStore.getState().user) return null;
    try {
        let blob: Blob | null = null;
        if (input.storageKey) {
            blob = (await getMediaBlob(input.storageKey)) || null;
        }
        if (!blob && isLocalObjectUrl(input.url)) {
            blob = await blobFromUrl(input.url);
        }
        if (blob && blob.size > 0) {
            return await uploadCloudJob({
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
        }
        if (isRemoteHttpUrl(input.url)) {
            return await uploadCloudJobFromUrl({
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
        }
        return null;
    } catch (error) {
        console.warn("cloud video save failed", error);
        return null;
    }
}
