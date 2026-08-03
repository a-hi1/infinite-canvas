import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

function scheduleAssetCloudPush() {
    void import("@/services/asset-cloud-sync")
        .then((mod) => mod.schedulePushAssetManifest())
        .catch(() => {
            // Cloud is optional; local persistence remains authoritative.
        });
}

function recordAssetCloudDeletion(id: string) {
    void import("@/services/asset-cloud-sync")
        .then((mod) => mod.recordAssetDeletion(id))
        .catch(() => {
            // Cloud is optional; local deletion already succeeded.
        });
}

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    /** 用户自定义分类名；空/缺省 = 未分类。与 kind 正交，仅用于管理筛选。 */
    category?: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    /** Prepend a batch as one block (keeps input order; avoids forEach+addAsset reversing export/import). */
    addAssets: (assets: Array<Omit<Asset, "id" | "createdAt" | "updatedAt">>) => string[];
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    /** Batch delete: one cleanup pass + per-id cloud tombstone. */
    removeAssets: (ids: string[]) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

const ASSET_STORE_KEY = "infinite-canvas:asset_store";
const ASSET_HYDRATION_TIMEOUT_MS = 8000;

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        let parsed: StorageValue<AssetStore>;
        try {
            parsed = JSON.parse(value) as StorageValue<AssetStore>;
        } catch {
            return null;
        }
        parsed.state.assets = await Promise.all((parsed.state.assets || []).map(hydratePersistedAsset));
        return parsed;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

async function hydratePersistedAsset(asset: Asset): Promise<Asset> {
    try {
        if (asset.kind === "video") return hydratePersistedVideoAsset(asset);
        if (asset.kind === "image") return hydratePersistedImageAsset(asset);
        return asset;
    } catch {
        return stripStaleBlobUrls(asset);
    }
}

async function hydratePersistedVideoAsset(asset: VideoAsset): Promise<VideoAsset> {
    if (!asset.data.storageKey) return asset;
    const url = await withAssetHydrationTimeout(resolveMediaUrl(asset.data.storageKey, ""));
    return { ...asset, coverUrl: safeStoredUrl(asset.coverUrl), data: { ...asset.data, url: url || safeStoredUrl(asset.data.url) } };
}

async function hydratePersistedImageAsset(asset: ImageAsset): Promise<ImageAsset> {
    if (asset.data.storageKey) {
        const dataUrl = await withAssetHydrationTimeout(resolveImageUrl(asset.data.storageKey, ""));
        const coverUrl = asset.coverUrl.startsWith("blob:") ? dataUrl : asset.coverUrl;
        return { ...asset, coverUrl: safeStoredUrl(coverUrl), data: { ...asset.data, dataUrl: dataUrl || safeStoredUrl(asset.data.dataUrl) } };
    }
    if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
    const image = await withAssetHydrationTimeout(uploadImage(asset.data.dataUrl));
    return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
}

function stripStaleBlobUrls(asset: Asset): Asset {
    if (asset.kind === "image") return { ...asset, coverUrl: safeStoredUrl(asset.coverUrl), data: { ...asset.data, dataUrl: safeStoredUrl(asset.data.dataUrl) } };
    if (asset.kind === "video") return { ...asset, coverUrl: safeStoredUrl(asset.coverUrl), data: { ...asset.data, url: safeStoredUrl(asset.data.url) } };
    return asset;
}

function withAssetHydrationTimeout<T>(promise: Promise<T>) {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            window.setTimeout(() => reject(new Error("素材恢复超时")), ASSET_HYDRATION_TIMEOUT_MS);
        }),
    ]);
}

function safeStoredUrl(value = "") {
    return value.startsWith("blob:") ? "" : value;
}

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                scheduleAssetCloudPush();
                return id;
            },
            addAssets: (items) => {
                if (!items?.length) return [];
                const now = new Date().toISOString();
                const prepared = items.map((asset) => {
                    const id = nanoid();
                    return { ...asset, id, createdAt: now, updatedAt: now } as Asset;
                });
                // One prepend keeps package/export order (first item stays first in the new block).
                set((state) => ({ assets: [...prepared, ...state.assets] }));
                scheduleAssetCloudPush();
                return prepared.map((asset) => asset.id);
            },
            updateAsset: (id, patch) => {
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                }));
                scheduleAssetCloudPush();
            },
            removeAsset: (id) => {
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    get().cleanupImages({ assets });
                    return { assets };
                });
                recordAssetCloudDeletion(id);
            },
            removeAssets: (ids) => {
                const idSet = new Set((ids || []).filter(Boolean));
                if (!idSet.size) return;
                set((state) => {
                    const assets = state.assets.filter((asset) => !idSet.has(asset.id));
                    get().cleanupImages({ assets });
                    return { assets };
                });
                for (const id of idSet) recordAssetCloudDeletion(id);
            },
            replaceAssets: (assets) => set({ assets }),
            cleanupImages: (extra) => {
                // 等 canvas persist 完成，避免「projects 还是 []」时 GC 把画布图当孤儿删掉。
                // 生图/视频历史 storageKey 由 cleanupUnused* 内部额外扫描，不依赖 extra。
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
                    const canvas = useCanvasStore.getState();
                    if (!canvas.hydrated) {
                        await new Promise<void>((resolve) => {
                            const started = Date.now();
                            const timer = window.setInterval(() => {
                                if (useCanvasStore.getState().hydrated || Date.now() - started > 5000) {
                                    window.clearInterval(timer);
                                    resolve();
                                }
                            }, 50);
                        });
                    }
                    const projects = useCanvasStore.getState().projects;
                    await cleanupUnusedImages({ assets: get().assets, projects, extra });
                    await cleanupUnusedMedia({ assets: get().assets, projects, extra });
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => () => {
                useAssetStore.setState({ hydrated: true });
            },
        },
    ),
);
