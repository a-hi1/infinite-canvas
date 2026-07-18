/**
 * Canvas project cloud sync (P2).
 * Local-first: IndexedDB remains source of truth.
 * - Project JSON: debounced PUT /api/projects/:id
 * - Media blobs: upload missing storageKeys via /api/blobs; download on pull
 * Failure must never block local edit/save.
 */

import {
    CloudApiError,
    deleteCloudProject,
    downloadCloudBlobByKey,
    getCloudProject,
    isCloudApiError,
    listCloudProjects,
    putCloudProject,
    uploadCloudBlob,
    type CloudCanvasProject,
} from "@/services/cloud-api";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { useAuthStore } from "@/stores/use-auth-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PUSH_DEBOUNCE_MS = 1500;
const MEDIA_CONCURRENCY = 3;
const STORAGE_KEY_RE = /^(image|video|audio|file|video-reference|audio-reference):[A-Za-z0-9_-]+$/;

function isLoggedIn() {
    return Boolean(useAuthStore.getState().user);
}

function toCloudProject(project: CanvasProject): CloudCanvasProject {
    return {
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        nodes: project.nodes as unknown[],
        connections: project.connections as unknown[],
        chatSessions: project.chatSessions as unknown[],
        activeChatId: project.activeChatId,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
        viewport: project.viewport,
    };
}

function fromCloudProject(project: CloudCanvasProject): CanvasProject {
    return {
        id: project.id,
        title: project.title || "未命名画布",
        createdAt: project.createdAt || new Date().toISOString(),
        updatedAt: project.updatedAt || new Date().toISOString(),
        nodes: (project.nodes || []) as CanvasProject["nodes"],
        connections: (project.connections || []) as CanvasProject["connections"],
        chatSessions: (project.chatSessions || []) as CanvasProject["chatSessions"],
        activeChatId: project.activeChatId ?? null,
        backgroundMode: (project.backgroundMode as CanvasProject["backgroundMode"]) || "lines",
        showImageInfo: Boolean(project.showImageInfo),
        viewport: project.viewport || { x: 0, y: 0, k: 1 },
    };
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string") {
        if (STORAGE_KEY_RE.test(value)) keys.add(value);
        return keys;
    }
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof (value as { storageKey?: string }).storageKey === "string") {
        const k = (value as { storageKey: string }).storageKey;
        if (STORAGE_KEY_RE.test(k)) keys.add(k);
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(child)) child.forEach((item) => collectStorageKeys(item, keys));
        else collectStorageKeys(child, keys);
    }
    return keys;
}

async function getLocalBlob(storageKey: string) {
    if (storageKey.startsWith("image:")) return getImageBlob(storageKey);
    return getMediaBlob(storageKey);
}

async function setLocalBlob(storageKey: string, blob: Blob) {
    if (storageKey.startsWith("image:")) return setImageBlob(storageKey, blob);
    return setMediaBlob(storageKey, blob);
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const current = items[index++];
            await worker(current);
        }
    });
    await Promise.all(runners);
}

/** Upload local blobs referenced by project; skip missing/remote-only keys. */
async function uploadProjectMedia(project: CanvasProject) {
    const keys = [...collectStorageKeys(project)];
    if (!keys.length) return { uploaded: 0, skipped: 0 };
    let uploaded = 0;
    let skipped = 0;
    await runPool(keys, MEDIA_CONCURRENCY, async (key) => {
        try {
            const blob = await getLocalBlob(key);
            if (!blob || blob.size <= 0) {
                skipped += 1;
                return;
            }
            await uploadCloudBlob({ clientKey: key, blob, filename: key.replace(":", "-") });
            uploaded += 1;
        } catch (error) {
            // Non-fatal: JSON still useful without every blob.
            console.warn("canvas media upload failed", key, error);
            skipped += 1;
        }
    });
    return { uploaded, skipped };
}

/** Download missing blobs for a project document after JSON merge. */
async function downloadProjectMedia(project: CanvasProject) {
    const keys = [...collectStorageKeys(project)];
    if (!keys.length) return { downloaded: 0, missing: 0 };
    let downloaded = 0;
    let missing = 0;
    await runPool(keys, MEDIA_CONCURRENCY, async (key) => {
        try {
            const local = await getLocalBlob(key);
            if (local && local.size > 0) return;
            const blob = await downloadCloudBlobByKey(key);
            if (!blob.size) {
                missing += 1;
                return;
            }
            await setLocalBlob(key, blob);
            downloaded += 1;
        } catch (error) {
            if (isCloudApiError(error) && error.status === 404) missing += 1;
            else console.warn("canvas media download failed", key, error);
        }
    });
    return { downloaded, missing };
}

/** Debounced push after local save. Safe no-op when logged out / offline. */
export function schedulePushCanvasProject(projectId: string) {
    if (!isLoggedIn()) return;
    const prev = pushTimers.get(projectId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
        pushTimers.delete(projectId);
        void pushCanvasProjectNow(projectId);
    }, PUSH_DEBOUNCE_MS);
    pushTimers.set(projectId, timer);
}

export async function pushCanvasProjectNow(projectId: string, options?: { force?: boolean }) {
    if (!isLoggedIn()) return { ok: false as const, reason: "not_logged_in" as const };
    const local = useCanvasStore.getState().openProject(projectId);
    if (!local) return { ok: false as const, reason: "missing_local" as const };
    try {
        // Media first so other devices can resolve storageKeys after JSON lands.
        await uploadProjectMedia(local);
        const result = await putCloudProject(toCloudProject(local), { force: options?.force });
        return { ok: true as const, created: Boolean(result.created) };
    } catch (error) {
        if (isCloudApiError(error) && error.status === 409) {
            const data = (error as CloudApiError & { data?: { project?: CloudCanvasProject } }).data;
            return { ok: false as const, reason: "conflict" as const, cloud: data?.project ? fromCloudProject(data.project) : null };
        }
        console.warn("canvas cloud push failed", error);
        return { ok: false as const, reason: "network" as const };
    }
}

/**
 * Pull cloud list and merge into local by updatedAt (newer wins per id).
 * Does not delete local-only projects. Downloads missing media best-effort.
 */
export async function pullAndMergeCanvasProjects() {
    if (!isLoggedIn()) return { ok: false as const, merged: 0, pulled: 0, mediaDownloaded: 0 };
    try {
        const { items } = await listCloudProjects();
        let merged = 0;
        let pulled = 0;
        let mediaDownloaded = 0;

        for (const meta of items) {
            const current = useCanvasStore.getState();
            const local = current.projects.find((p) => p.id === meta.id);
            const cloudTs = Date.parse(meta.updated_at || "") || 0;
            const localTs = local ? Date.parse(local.updatedAt || "") || 0 : 0;
            if (local && localTs >= cloudTs) {
                // Still try fill missing media for local project that is already newest JSON.
                const media = await downloadProjectMedia(local);
                mediaDownloaded += media.downloaded;
                continue;
            }
            try {
                const full = await getCloudProject(meta.id);
                const cloudProject = fromCloudProject(full.project);
                const latest = useCanvasStore.getState();
                if (latest.projects.some((p) => p.id === cloudProject.id)) {
                    latest.replaceProjects(latest.projects.map((p) => (p.id === cloudProject.id ? cloudProject : p)));
                } else {
                    latest.replaceProjects([cloudProject, ...latest.projects]);
                }
                const media = await downloadProjectMedia(cloudProject);
                mediaDownloaded += media.downloaded;
                merged += 1;
                pulled += 1;
            } catch (error) {
                console.warn("canvas cloud pull one failed", meta.id, error);
            }
        }
        return { ok: true as const, merged, pulled, listed: items.length, mediaDownloaded };
    } catch (error) {
        console.warn("canvas cloud list failed", error);
        return { ok: false as const, merged: 0, pulled: 0, mediaDownloaded: 0 };
    }
}

export async function removeCloudCanvasProject(projectId: string) {
    if (!isLoggedIn()) return;
    try {
        await deleteCloudProject(projectId);
    } catch (error) {
        console.warn("canvas cloud delete failed", error);
    }
}
