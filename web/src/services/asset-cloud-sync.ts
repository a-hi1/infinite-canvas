import localforage from "localforage";

import { downloadMissingCloudBlobs, uploadReferencedCloudBlobs } from "@/services/cloud-blob-sync";
import {
    CloudApiError,
    getCloudAssetManifest,
    isCloudApiError,
    putCloudAssetManifest,
    type CloudAssetManifest,
    type CloudAssetTombstone,
} from "@/services/cloud-api";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl } from "@/services/image-storage";
import { useAuthStore } from "@/stores/use-auth-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

const tombstoneStore = localforage.createInstance({ name: "infinite-canvas", storeName: "asset_cloud_sync" });
const TOMBSTONE_KEY = "tombstones";
const SNAPSHOT_KEY = "last_synced_snapshot";
const PUSH_DEBOUNCE_MS = 1800;
const MAX_TOMBSTONES = 20000;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let syncing: Promise<AssetSyncResult> | null = null;
let resyncRequested = false;
const pendingTombstones = new Map<string, CloudAssetTombstone>();
let lastSyncedSnapshot: AssetSyncSnapshot | null = null;
let lastSyncedLoaded = false;
let lastSyncFailed = false;
let statusVersion = 0;
const statusListeners = new Set<() => void>();

export type AssetSyncResult = {
    ok: boolean;
    merged: number;
    deleted: number;
    mediaDownloaded: number;
    mediaUploaded: number;
    reason?: "not_logged_in" | "network";
};

type AssetSyncSnapshot = {
    updatedAt: string;
    assetIds: string[];
    signatures: Record<string, string>;
};

export type AssetCloudBadge = "local" | "pending" | "synced" | "failed";

function isLoggedIn() {
    return Boolean(useAuthStore.getState().user);
}

function notifyStatusListeners() {
    statusVersion += 1;
    statusListeners.forEach((listener) => listener());
}

export function subscribeAssetCloudStatus(listener: () => void) {
    statusListeners.add(listener);
    return () => {
        statusListeners.delete(listener);
    };
}

export function getAssetCloudStatusVersion() {
    return statusVersion;
}

function assetSignature(asset: Asset) {
    const mediaKey =
        asset.kind === "image" || asset.kind === "video"
            ? String(asset.data.storageKey || "")
            : asset.kind === "text"
              ? String(asset.data.content || "")
              : "";
    const category = String(asset.category || "").trim();
    return `${asset.updatedAt}|${asset.kind}|${asset.title}|${category}|${mediaKey}`;
}

function buildSnapshot(assets: Asset[], updatedAt: string): AssetSyncSnapshot {
    const signatures: Record<string, string> = {};
    for (const asset of assets) signatures[asset.id] = assetSignature(asset);
    return {
        updatedAt,
        assetIds: assets.map((asset) => asset.id).sort(),
        signatures,
    };
}

async function ensureSyncedSnapshotLoaded() {
    if (lastSyncedLoaded) return lastSyncedSnapshot;
    lastSyncedLoaded = true;
    const stored = await tombstoneStore.getItem<AssetSyncSnapshot>(SNAPSHOT_KEY);
    if (stored && typeof stored === "object" && stored.signatures) {
        lastSyncedSnapshot = {
            updatedAt: String(stored.updatedAt || ""),
            assetIds: Array.isArray(stored.assetIds) ? stored.assetIds.map(String) : Object.keys(stored.signatures),
            signatures: stored.signatures,
        };
    }
    return lastSyncedSnapshot;
}

async function writeSyncedSnapshot(snapshot: AssetSyncSnapshot) {
    lastSyncedSnapshot = snapshot;
    lastSyncedLoaded = true;
    lastSyncFailed = false;
    await tombstoneStore.setItem(SNAPSHOT_KEY, snapshot);
    notifyStatusListeners();
}

export function getAssetCloudBadge(asset: Asset, options?: { loggedIn?: boolean; syncing?: boolean }): AssetCloudBadge {
    const loggedIn = options?.loggedIn ?? isLoggedIn();
    if (!loggedIn) return "local";
    if (options?.syncing) return "pending";
    if (lastSyncFailed) return "failed";
    const snapshot = lastSyncedSnapshot;
    if (!snapshot) return "pending";
    const signature = snapshot.signatures[asset.id];
    if (!signature) return "pending";
    return signature === assetSignature(asset) ? "synced" : "pending";
}

export function getAssetLibraryCloudSummary(assets: Asset[], options?: { loggedIn?: boolean; syncing?: boolean }) {
    const loggedIn = options?.loggedIn ?? isLoggedIn();
    if (!loggedIn) {
        return { label: "仅本机", detail: "登录后可同步到云端", tone: "local" as const, synced: 0, pending: assets.length, failed: 0 };
    }
    if (options?.syncing) {
        return { label: "同步中", detail: "正在上传/拉取资产清单与媒体", tone: "pending" as const, synced: 0, pending: assets.length, failed: 0 };
    }
    if (lastSyncFailed) {
        return { label: "上云失败", detail: "可点击「同步云端」重试，本机资产不受影响", tone: "failed" as const, synced: 0, pending: 0, failed: assets.length };
    }
    let synced = 0;
    let pending = 0;
    for (const asset of assets) {
        if (getAssetCloudBadge(asset, { loggedIn: true }) === "synced") synced += 1;
        else pending += 1;
    }
    if (!assets.length) {
        return { label: lastSyncedSnapshot ? "已上云" : "待同步", detail: lastSyncedSnapshot ? "云端清单为空" : "新增资产后会自动同步", tone: lastSyncedSnapshot ? ("synced" as const) : ("pending" as const), synced: 0, pending: 0, failed: 0 };
    }
    if (pending === 0) {
        return { label: "已上云", detail: `${synced} 条资产已与云端对齐`, tone: "synced" as const, synced, pending: 0, failed: 0 };
    }
    if (synced === 0) {
        return { label: "待同步", detail: `${pending} 条素材尚未确认上云`, tone: "pending" as const, synced: 0, pending, failed: 0 };
    }
    return { label: "部分已上云", detail: `已上云 ${synced} · 待同步 ${pending}`, tone: "pending" as const, synced, pending, failed: 0 };
}

function asTime(value: string | undefined) {
    return Date.parse(value || "") || 0;
}

function latestIso(values: string[]) {
    let latest = 0;
    for (const value of values) latest = Math.max(latest, asTime(value));
    return new Date(latest || Date.now()).toISOString();
}

function sanitizeAssetForCloud(asset: Asset): Asset {
    if (asset.kind === "image") {
        return {
            ...asset,
            coverUrl: asset.coverUrl.startsWith("blob:") ? "" : asset.coverUrl,
            data: { ...asset.data, dataUrl: asset.data.dataUrl.startsWith("blob:") ? "" : asset.data.dataUrl },
        };
    }
    if (asset.kind === "video") {
        return {
            ...asset,
            coverUrl: asset.coverUrl.startsWith("blob:") ? "" : asset.coverUrl,
            data: { ...asset.data, url: asset.data.url.startsWith("blob:") ? "" : asset.data.url },
        };
    }
    return asset;
}

function normalizeTombstones(rows: unknown): CloudAssetTombstone[] {
    if (!Array.isArray(rows)) return [];
    const byId = new Map<string, CloudAssetTombstone>();
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const id = String((row as CloudAssetTombstone).id || "").trim();
        const deletedAt = String((row as CloudAssetTombstone).deletedAt || "").trim();
        if (!id || !asTime(deletedAt)) continue;
        const current = byId.get(id);
        if (!current || asTime(deletedAt) > asTime(current.deletedAt)) byId.set(id, { id, deletedAt });
    }
    return [...byId.values()]
        .sort((a, b) => asTime(b.deletedAt) - asTime(a.deletedAt))
        .slice(0, MAX_TOMBSTONES);
}

async function readLocalTombstones() {
    const persisted = normalizeTombstones(await tombstoneStore.getItem<CloudAssetTombstone[]>(TOMBSTONE_KEY));
    return normalizeTombstones([...persisted, ...pendingTombstones.values()]);
}

async function writeLocalTombstones(rows: CloudAssetTombstone[]) {
    const normalized = normalizeTombstones([...rows, ...pendingTombstones.values()]);
    await tombstoneStore.setItem(TOMBSTONE_KEY, normalized);
    for (const row of normalized) {
        const pending = pendingTombstones.get(row.id);
        if (pending && asTime(row.deletedAt) >= asTime(pending.deletedAt)) pendingTombstones.delete(row.id);
    }
    return normalized;
}

export async function recordAssetDeletion(assetId: string, deletedAt = new Date().toISOString()) {
    // Record synchronously in memory first so an immediate manual sync cannot resurrect it.
    pendingTombstones.set(assetId, { id: assetId, deletedAt });
    const current = await readLocalTombstones();
    await writeLocalTombstones(current);
    // Local delete immediately makes cloud snapshot stale.
    lastSyncFailed = false;
    notifyStatusListeners();
    schedulePushAssetManifest();
}

export function schedulePushAssetManifest() {
    if (!isLoggedIn()) return;
    // Local CRUD makes previous "synced" badge provisional until next successful push.
    lastSyncFailed = false;
    notifyStatusListeners();
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        pushTimer = null;
        void syncAssetManifestNow({ pull: false });
    }, PUSH_DEBOUNCE_MS);
}

export async function hydrateAssetCloudStatus() {
    await ensureSyncedSnapshotLoaded();
    notifyStatusListeners();
    return lastSyncedSnapshot;
}

async function hydrateMergedAssets(assets: Asset[]) {
    return Promise.all(
        assets.map(async (asset): Promise<Asset> => {
            try {
                if (asset.kind === "image" && asset.data.storageKey) {
                    const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl || "");
                    return {
                        ...asset,
                        coverUrl: asset.coverUrl || dataUrl,
                        data: { ...asset.data, dataUrl: dataUrl || asset.data.dataUrl },
                    };
                }
                if (asset.kind === "video" && asset.data.storageKey) {
                    const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url || "");
                    return { ...asset, data: { ...asset.data, url: url || asset.data.url } };
                }
            } catch {
                // Keep metadata even when one local blob cannot hydrate.
            }
            return asset;
        }),
    );
}

function mergeAssetState(
    localAssets: Asset[],
    localTombstones: CloudAssetTombstone[],
    cloudManifest: CloudAssetManifest<Asset>,
) {
    const assets = new Map<string, Asset>();
    const tombstones = normalizeTombstones([...localTombstones, ...(cloudManifest.tombstones || [])]);
    const deletedAt = new Map(tombstones.map((row) => [row.id, asTime(row.deletedAt)]));

    for (const asset of cloudManifest.assets || []) {
        if (!asset?.id) continue;
        assets.set(asset.id, asset);
    }
    for (const asset of localAssets) {
        const current = assets.get(asset.id);
        if (!current || asTime(asset.updatedAt) >= asTime(current.updatedAt)) assets.set(asset.id, asset);
    }

    let deleted = 0;
    for (const [id, asset] of assets) {
        const tombstoneTime = deletedAt.get(id) || 0;
        if (tombstoneTime >= asTime(asset.updatedAt)) {
            assets.delete(id);
            deleted += 1;
        }
    }

    // A newer re-created/edited asset wins over an old tombstone; remove obsolete tombstones.
    const effectiveTombstones = tombstones.filter((row) => {
        const asset = assets.get(row.id);
        return !asset || asTime(row.deletedAt) >= asTime(asset.updatedAt);
    });
    const mergedAssets = [...assets.values()].sort((a, b) => asTime(b.updatedAt) - asTime(a.updatedAt));
    const updatedAt = latestIso([
        ...mergedAssets.map((asset) => asset.updatedAt),
        ...effectiveTombstones.map((row) => row.deletedAt),
        cloudManifest.updatedAt,
    ]);
    return { assets: mergedAssets, tombstones: effectiveTombstones, updatedAt, deleted };
}

async function putMergedManifest(manifest: CloudAssetManifest<Asset>): Promise<CloudAssetManifest<Asset>> {
    try {
        return (await putCloudAssetManifest(manifest)).manifest;
    } catch (error) {
        if (isCloudApiError(error) && error.status === 409) {
            const conflict = (error as CloudApiError & { data?: { manifest?: CloudAssetManifest<Asset> } }).data?.manifest;
            if (conflict) {
                const localTombstones = await readLocalTombstones();
                const merged = mergeAssetState(useAssetStore.getState().assets, localTombstones, conflict);
                const retryManifest: CloudAssetManifest<Asset> = {
                    version: 1,
                    updatedAt: merged.updatedAt,
                    assets: merged.assets.map(sanitizeAssetForCloud),
                    tombstones: merged.tombstones,
                };
                return (await putCloudAssetManifest(retryManifest, { force: true })).manifest;
            }
        }
        throw error;
    }
}

/**
 * Full asset sync. `pull=false` is used by debounced local CRUD but still fetches the
 * latest cloud manifest before merge, so concurrent devices do not overwrite each other.
 */
export async function syncAssetManifestNow(_options?: { pull?: boolean }): Promise<AssetSyncResult> {
    if (!isLoggedIn()) return { ok: false, merged: 0, deleted: 0, mediaDownloaded: 0, mediaUploaded: 0, reason: "not_logged_in" };
    if (syncing) {
        // A CRUD change/manual sync during an active run must trigger one more pass afterwards.
        resyncRequested = true;
        return syncing;
    }

    syncing = (async () => {
        try {
            const localStore = useAssetStore.getState();
            const localAssets = localStore.assets;
            const localTombstones = await readLocalTombstones();
            const remote = await getCloudAssetManifest<Asset>();
            const merged = mergeAssetState(localAssets, localTombstones, remote.manifest);

            const mediaUp = await uploadReferencedCloudBlobs(merged.assets);
            const mediaDown = await downloadMissingCloudBlobs(merged.assets);
            await writeLocalTombstones(merged.tombstones);
            const hydratedAssets = await hydrateMergedAssets(merged.assets);

            const localSignature = JSON.stringify(localAssets.map((asset) => [asset.id, asset.updatedAt]));
            const mergedSignature = JSON.stringify(hydratedAssets.map((asset) => [asset.id, asset.updatedAt]));
            if (localSignature !== mergedSignature || merged.deleted > 0 || mediaDown.downloaded > 0) {
                localStore.replaceAssets(hydratedAssets);
            }

            const manifest: CloudAssetManifest<Asset> = {
                version: 1,
                updatedAt: merged.updatedAt,
                assets: hydratedAssets.map(sanitizeAssetForCloud),
                tombstones: merged.tombstones,
            };
            const savedManifest = await putMergedManifest(manifest);

            // A 409 retry may have merged cloud changes that arrived after the initial GET.
            // Reflect that exact saved manifest in this device immediately.
            const finalTombstones = await readLocalTombstones();
            const finalMerged = mergeAssetState(useAssetStore.getState().assets, finalTombstones, savedManifest);
            const finalMediaDown = await downloadMissingCloudBlobs(finalMerged.assets);
            const finalAssets = await hydrateMergedAssets(finalMerged.assets);
            await writeLocalTombstones(finalMerged.tombstones);
            const finalSignature = JSON.stringify(finalAssets.map((asset) => [asset.id, asset.updatedAt]));
            const currentSignature = JSON.stringify(useAssetStore.getState().assets.map((asset) => [asset.id, asset.updatedAt]));
            if (finalSignature !== currentSignature || finalMediaDown.downloaded > 0) {
                useAssetStore.getState().replaceAssets(finalAssets);
            }

            await writeSyncedSnapshot(buildSnapshot(finalAssets, savedManifest.updatedAt || finalMerged.updatedAt));

            return {
                ok: true,
                merged: Math.max(0, finalAssets.length - localAssets.length + finalMerged.deleted),
                deleted: finalMerged.deleted,
                mediaDownloaded: mediaDown.downloaded + finalMediaDown.downloaded,
                mediaUploaded: mediaUp.uploaded,
            };
        } catch (error) {
            console.warn("asset cloud sync failed", error);
            lastSyncFailed = true;
            notifyStatusListeners();
            return { ok: false, merged: 0, deleted: 0, mediaDownloaded: 0, mediaUploaded: 0, reason: "network" };
        } finally {
            syncing = null;
            if (resyncRequested) {
                resyncRequested = false;
                schedulePushAssetManifest();
            }
        }
    })();
    return syncing;
}
