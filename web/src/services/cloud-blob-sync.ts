/** Shared authenticated blob sync for canvas projects and asset library. */

import { downloadCloudBlobByKey, isCloudApiError, uploadCloudBlob } from "@/services/cloud-api";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";

export const CLOUD_BLOB_CONCURRENCY = 3;
export const CLOUD_STORAGE_KEY_RE = /^(image|video|video-asset|audio|file|video-reference|audio-reference):[A-Za-z0-9_-]+$/;

export function collectCloudStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string") {
        if (CLOUD_STORAGE_KEY_RE.test(value)) keys.add(value);
        return keys;
    }
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof (value as { storageKey?: string }).storageKey === "string") {
        const key = (value as { storageKey: string }).storageKey;
        if (CLOUD_STORAGE_KEY_RE.test(key)) keys.add(key);
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(child)) child.forEach((item) => collectCloudStorageKeys(item, keys));
        else collectCloudStorageKeys(child, keys);
    }
    return keys;
}

export async function getLocalCloudBlob(storageKey: string) {
    if (storageKey.startsWith("image:")) return getImageBlob(storageKey);
    return getMediaBlob(storageKey);
}

export async function setLocalCloudBlob(storageKey: string, blob: Blob) {
    if (storageKey.startsWith("image:")) return setImageBlob(storageKey, blob);
    return setMediaBlob(storageKey, blob);
}

export async function runCloudBlobPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const current = items[index++];
            await worker(current);
        }
    });
    await Promise.all(runners);
}

export async function uploadReferencedCloudBlobs(value: unknown) {
    const keys = [...collectCloudStorageKeys(value)];
    if (!keys.length) return { uploaded: 0, skipped: 0 };
    let uploaded = 0;
    let skipped = 0;
    await runCloudBlobPool(keys, CLOUD_BLOB_CONCURRENCY, async (key) => {
        try {
            const blob = await getLocalCloudBlob(key);
            if (!blob || blob.size <= 0) {
                skipped += 1;
                return;
            }
            await uploadCloudBlob({ clientKey: key, blob, filename: key.replace(":", "-") });
            uploaded += 1;
        } catch (error) {
            console.warn("cloud blob upload failed", key, error);
            skipped += 1;
        }
    });
    return { uploaded, skipped };
}

export async function downloadMissingCloudBlobs(value: unknown) {
    const keys = [...collectCloudStorageKeys(value)];
    if (!keys.length) return { downloaded: 0, missing: 0 };
    let downloaded = 0;
    let missing = 0;
    await runCloudBlobPool(keys, CLOUD_BLOB_CONCURRENCY, async (key) => {
        try {
            const local = await getLocalCloudBlob(key);
            if (local && local.size > 0) return;
            const blob = await downloadCloudBlobByKey(key);
            if (!blob.size) {
                missing += 1;
                return;
            }
            await setLocalCloudBlob(key, blob);
            downloaded += 1;
        } catch (error) {
            if (isCloudApiError(error) && error.status === 404) missing += 1;
            else console.warn("cloud blob download failed", key, error);
        }
    });
    return { downloaded, missing };
}
