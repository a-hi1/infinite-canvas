import localforage from "localforage";

import { nanoid } from "nanoid";
import { readImageMeta } from "@/lib/image-utils";
import { AI_PROXY_BASE_URL, isAiProxyBaseUrl, resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";

export type UploadedImage = {
    url: string;
    storageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    remote?: boolean;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const objectUrls = new Map<string, string>();

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    if (typeof input === "string" && isRemoteHttpUrl(input)) {
        try {
            return await storeImageBlob(await fetchImageBlob(input));
        } catch {
            // Some providers (e.g. xAI imgen) return temporary HTTPS URLs that browsers can show via <img>
            // but cannot fetch due to CORS. Keep the remote URL so generation can still succeed and re-run.
            const meta = await readImageMeta(input);
            return {
                url: input,
                width: meta.width,
                height: meta.height,
                bytes: 0,
                mimeType: meta.mimeType,
                remote: true,
            };
        }
    }

    const blob = typeof input === "string" ? await fetchImageBlob(input) : input;
    return storeImageBlob(blob);
}

/** Hosts known to allow <img> display but block browser JS fetch (CORS). */
function isBrowserFetchBlockedHost(url: string) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return (
            host === "imgen.x.ai" ||
            host.endsWith(".imgen.x.ai") ||
            host === "vidgen.x.ai" ||
            host.endsWith(".vidgen.x.ai") ||
            host === "cdn.x.ai" ||
            host.endsWith(".cdn.x.ai")
        );
    } catch {
        return /imgen\.x\.ai|vidgen\.x\.ai|cdn\.x\.ai/i.test(url);
    }
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    // 优先本地 storageKey，避免 remote imgen URL 抢先导致读失败
    if (image.storageKey) {
        const localUrl = await resolveImageUrl(image.storageKey, "");
        if (localUrl) {
            if (localUrl.startsWith("data:")) return localUrl;
            return blobToDataUrl(await fetchImageBlob(localUrl));
        }
    }

    const url = image.dataUrl || image.url || "";
    if (!url) return "";
    if (url.startsWith("data:")) return url;
    if (url.startsWith("blob:")) return blobToDataUrl(await fetchImageBlob(url));

    if (isRemoteHttpUrl(url)) {
        try {
            return blobToDataUrl(await fetchImageBlob(url));
        } catch {
            // 远程临时图（如 imgen.x.ai）常因 CORS 读不到。调用方若需要二进制上传必须处理非 data URL。
            return url;
        }
    }

    return blobToDataUrl(await fetchImageBlob(url));
}

/** 把图片转成可上传的本地 data URL；远程不可读时抛出明确错误。 */
export async function ensureLocalImageDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string; name?: string }) {
    const dataUrl = await imageToDataUrl(image);
    if (dataUrl?.startsWith("data:")) return dataUrl;
    if (image.storageKey) {
        const localUrl = await resolveImageUrl(image.storageKey, "");
        if (localUrl?.startsWith("blob:") || localUrl?.startsWith("data:")) {
            return localUrl.startsWith("data:") ? localUrl : blobToDataUrl(await fetchImageBlob(localUrl));
        }
    }
    throw new Error("这张图还不能当参考图：它是远程临时地址且浏览器无法读取。请用“下载”后重新上传本地图，或换返回 base64 的生图渠道");
}

async function storeImageBlob(blob: Blob): Promise<UploadedImage> {
    const storageKey = `image:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = await readImageMeta(url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

async function fetchImageBlob(input: string) {
    if (!isRemoteHttpUrl(input)) {
        return (await fetch(input)).blob();
    }

    // imgen/vidgen: skip direct browser fetch (always CORS noise + fails). Try same-origin helpers only.
    let lastError: unknown = new Error("远程图需要同源代理或服务端代拉");
    if (!isBrowserFetchBlockedHost(input)) {
        try {
            return await readBlobResponse(await fetch(input), "下载远程图片失败");
        } catch (error) {
            lastError = error;
        }
    }

    // 1) optional ai-proxy media (only when current image channel is /ai-proxy)
    const proxyUrls = mediaProxyCandidates(input);
    for (const proxyUrl of proxyUrls) {
        try {
            return await readBlobResponse(await fetch(proxyUrl), "通过媒体代理下载远程图片失败");
        } catch (proxyError) {
            lastError = proxyError;
        }
    }
    // 2) if logged into cloud API, try server allowlisted fetch.
    // Note: many local Docker hosts cannot reach imgen.x.ai at all; then this still fails with a clear message.
    try {
        return await fetchRemoteImageViaCloudApi(input);
    } catch (cloudError) {
        lastError = cloudError;
    }
    const detail = lastError instanceof Error ? lastError.message : "";
    throw new Error(
        detail.includes("服务器无法连接") || detail.includes("网络不通") || detail.includes("出网")
            ? `${detail}。也可：浏览器另开图片链接 → 另存为 → 素材页本地导入`
            : formatRemoteImageError(lastError, "远程图片下载失败（imgen 禁止浏览器直读；请登录后由服务端代拉，或下载后本地导入）"),
    );
}

/** Login-session server pull: POST /api/jobs/image/from-url then GET file blob. */
async function fetchRemoteImageViaCloudApi(remoteUrl: string) {
    const create = await fetch("/api/jobs/image/from-url", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            url: remoteUrl,
            client_local_id: `asset-import:${hashShort(remoteUrl)}`,
            prompt: "",
            model: "",
            params: { purpose: "local_asset_import" },
        }),
    });
    const payload = (await create.json().catch(() => null)) as {
        code?: number;
        msg?: string;
        data?: { file?: { url?: string; id?: string } | null; result_file_id?: string | null };
    } | null;
    if (!create.ok || !payload || payload.code !== 0) {
        throw new Error(payload?.msg || `服务端拉取远程图失败（${create.status}）`);
    }
    const fileUrl = payload.data?.file?.url || (payload.data?.result_file_id ? `/api/files/${payload.data.result_file_id}` : "");
    if (!fileUrl) throw new Error("服务端未返回文件");
    const absolute = fileUrl.startsWith("http") ? fileUrl : fileUrl.startsWith("/api/") ? fileUrl : `/api${fileUrl.startsWith("/") ? fileUrl : `/${fileUrl}`}`;
    return readBlobResponse(await fetch(absolute, { credentials: "include" }), "读取服务端落盘图片失败");
}

function hashShort(value: string) {
    let h = 0;
    for (let i = 0; i < value.length; i += 1) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
}

async function readBlobResponse(response: Response, fallback: string) {
    if (!response.ok) {
        let detail = "";
        try {
            const payload = (await response.clone().json()) as { error?: { message?: string }; msg?: string };
            detail = payload.error?.message || payload.msg || "";
        } catch {
            detail = "";
        }
        throw new Error(detail ? `${fallback}：${response.status} ${detail}` : `${fallback}：${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error(`${fallback}：空响应`);
    return blob;
}

function isRemoteHttpUrl(value: string) {
    return /^https?:\/\//i.test(value);
}

function mediaProxyCandidates(url: string) {
    const config = useConfigStore.getState().config;
    const preferredModel = config.imageModel || config.model;
    const preferredChannel = preferredModel ? resolveModelRequestConfig(config, preferredModel) : null;
    // 只看当前图片模型所在渠道，避免 Agnes 代理渠道“污染” Grok 直连中转站链路。
    if (!preferredChannel || !isAiProxyBaseUrl(preferredChannel.baseUrl)) return [];

    const candidates: string[] = [`${AI_PROXY_BASE_URL}/media?${new URLSearchParams({ url }).toString()}`];
    if (preferredChannel.apiKey.trim()) {
        const params = new URLSearchParams({ url });
        params.set("token", preferredChannel.apiKey.trim());
        candidates.push(`${AI_PROXY_BASE_URL}/media?${params.toString()}`);
    }
    return candidates;
}

function formatRemoteImageError(error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : "";
    if (!message) return fallback;
    if (message.includes(fallback)) return message;
    return `${fallback}：${message}`;
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
