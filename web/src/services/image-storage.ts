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
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    if (url.startsWith("blob:") || image.storageKey) {
        return blobToDataUrl(await fetchImageBlob(url));
    }
    if (isRemoteHttpUrl(url)) {
        try {
            return blobToDataUrl(await fetchImageBlob(url));
        } catch {
            // Keep remote URL for display / providers that accept public image URLs.
            // Callers that require binary upload must handle non-data URLs themselves.
            return url;
        }
    }
    return blobToDataUrl(await fetchImageBlob(url));
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

    try {
        return await readBlobResponse(await fetch(input), "下载远程图片失败");
    } catch (error) {
        const proxyUrls = mediaProxyCandidates(input);
        if (!proxyUrls.length) {
            throw new Error(formatRemoteImageError(error, "远程图片下载失败（可能被 CORS 拦截）"));
        }
        let lastError = error;
        for (const proxyUrl of proxyUrls) {
            try {
                return await readBlobResponse(await fetch(proxyUrl), "通过媒体代理下载远程图片失败");
            } catch (proxyError) {
                lastError = proxyError;
            }
        }
        throw new Error(formatRemoteImageError(lastError, "远程图片下载失败（可能被 CORS 拦截，或服务器无法访问该图片地址）"));
    }
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
    const tokens = new Set<string>();
    const config = useConfigStore.getState().config;
    const preferredModel = config.imageModel || config.model;
    if (preferredModel) {
        const channel = resolveModelRequestConfig(config, preferredModel);
        if (isAiProxyBaseUrl(channel.baseUrl) && channel.apiKey.trim()) tokens.add(channel.apiKey.trim());
    }
    if (isAiProxyBaseUrl(config.baseUrl) && config.apiKey.trim()) tokens.add(config.apiKey.trim());
    for (const channel of config.channels || []) {
        if (isAiProxyBaseUrl(channel.baseUrl) && channel.apiKey.trim()) tokens.add(channel.apiKey.trim());
    }

    const candidates = Array.from(tokens).map((token) => {
        const params = new URLSearchParams({ url });
        params.set("token", token);
        return `${AI_PROXY_BASE_URL}/media?${params.toString()}`;
    });
    // Only try unauthenticated media proxy when no proxy token is known.
    if (!candidates.length) candidates.push(`${AI_PROXY_BASE_URL}/media?${new URLSearchParams({ url }).toString()}`);
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
