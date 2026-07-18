/**
 * Canvas project cloud sync (P2).
 * Local-first: IndexedDB remains source of truth.
 * - Project JSON: debounced PUT /api/projects/:id
 * - Media blobs: upload missing storageKeys via /api/blobs; download on pull
 * - Local project deletion tombstones prevent cloud resurrection after offline deletes
 * Failure must never block local edit/save.
 */

import localforage from "localforage";

import {
    CloudApiError,
    deleteCloudProject,
    getCloudProject,
    isCloudApiError,
    listCloudProjects,
    putCloudProject,
    type CloudCanvasProject,
} from "@/services/cloud-api";
import { downloadMissingCloudBlobs, uploadReferencedCloudBlobs } from "@/services/cloud-blob-sync";
import { useAuthStore } from "@/stores/use-auth-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PUSH_DEBOUNCE_MS = 1500;
const tombstoneStore = localforage.createInstance({ name: "infinite-canvas", storeName: "canvas_cloud_sync" });
const TOMBSTONE_KEY = "project_tombstones";
const SNAPSHOT_KEY = "last_synced_snapshot";
const MAX_TOMBSTONES = 5000;
const pendingTombstones = new Map<string, { id: string; deletedAt: string }>();
const failedProjectIds = new Set<string>();
let lastSyncedSnapshot: CanvasSyncSnapshot | null = null;
let lastSyncedLoaded = false;
let statusVersion = 0;
const statusListeners = new Set<() => void>();

type CanvasSyncSnapshot = {
    signatures: Record<string, string>;
};

export type CanvasCloudBadge = "local" | "pending" | "synced" | "failed";

function isLoggedIn() {
    return Boolean(useAuthStore.getState().user);
}

function notifyStatusListeners() {
    statusVersion += 1;
    statusListeners.forEach((listener) => listener());
}

export function subscribeCanvasCloudStatus(listener: () => void) {
    statusListeners.add(listener);
    return () => {
        statusListeners.delete(listener);
    };
}

export function getCanvasCloudStatusVersion() {
    return statusVersion;
}

function projectSignature(project: Pick<CanvasProject, "updatedAt" | "title">) {
    return `${project.updatedAt}|${project.title}`;
}

async function ensureSyncedSnapshotLoaded() {
    if (lastSyncedLoaded) return lastSyncedSnapshot;
    lastSyncedLoaded = true;
    const stored = await tombstoneStore.getItem<CanvasSyncSnapshot>(SNAPSHOT_KEY);
    if (stored && typeof stored === "object" && stored.signatures) {
        lastSyncedSnapshot = { signatures: stored.signatures };
    }
    return lastSyncedSnapshot;
}

async function writeSyncedSnapshot(snapshot: CanvasSyncSnapshot) {
    lastSyncedSnapshot = snapshot;
    lastSyncedLoaded = true;
    await tombstoneStore.setItem(SNAPSHOT_KEY, snapshot);
    notifyStatusListeners();
}

async function markProjectsSynced(projects: Array<Pick<CanvasProject, "id" | "updatedAt" | "title">>) {
    await ensureSyncedSnapshotLoaded();
    const signatures = { ...(lastSyncedSnapshot?.signatures || {}) };
    for (const project of projects) {
        signatures[project.id] = projectSignature(project);
        failedProjectIds.delete(project.id);
    }
    await writeSyncedSnapshot({ signatures });
}

export function getCanvasProjectCloudBadge(
    project: Pick<CanvasProject, "id" | "updatedAt" | "title">,
    options?: { loggedIn?: boolean; syncing?: boolean },
): CanvasCloudBadge {
    const loggedIn = options?.loggedIn ?? isLoggedIn();
    if (!loggedIn) return "local";
    if (options?.syncing || pushTimers.has(project.id)) return "pending";
    if (failedProjectIds.has(project.id)) return "failed";
    const signature = lastSyncedSnapshot?.signatures[project.id];
    if (!signature) return "pending";
    return signature === projectSignature(project) ? "synced" : "pending";
}

export function getCanvasLibraryCloudSummary(
    projects: Array<Pick<CanvasProject, "id" | "updatedAt" | "title">>,
    options?: { loggedIn?: boolean; syncing?: boolean },
) {
    const loggedIn = options?.loggedIn ?? isLoggedIn();
    if (!loggedIn) {
        return { label: "仅本机", detail: "登录后可同步到云端", tone: "local" as const, synced: 0, pending: projects.length, failed: 0 };
    }
    if (options?.syncing) {
        return { label: "同步中", detail: "正在上传/拉取画布与媒体", tone: "pending" as const, synced: 0, pending: projects.length, failed: 0 };
    }
    let synced = 0;
    let pending = 0;
    let failed = 0;
    for (const project of projects) {
        const badge = getCanvasProjectCloudBadge(project, { loggedIn: true, syncing: false });
        if (badge === "synced") synced += 1;
        else if (badge === "failed") failed += 1;
        else pending += 1;
    }
    if (!projects.length) {
        return {
            label: lastSyncedSnapshot ? "已上云" : "待同步",
            detail: lastSyncedSnapshot ? "云端暂无画布" : "新建画布后会自动同步",
            tone: lastSyncedSnapshot ? ("synced" as const) : ("pending" as const),
            synced: 0,
            pending: 0,
            failed: 0,
        };
    }
    if (failed > 0) {
        return { label: "上云失败", detail: `${failed} 个画布同步失败，可重试`, tone: "failed" as const, synced, pending, failed };
    }
    if (pending === 0) {
        return { label: "已上云", detail: `${synced} 个画布已与云端对齐`, tone: "synced" as const, synced, pending: 0, failed: 0 };
    }
    if (synced === 0) {
        return { label: "待同步", detail: `${pending} 个画布尚未确认上云`, tone: "pending" as const, synced: 0, pending, failed: 0 };
    }
    return { label: "部分已上云", detail: `已上云 ${synced} · 待同步 ${pending}`, tone: "pending" as const, synced, pending, failed: 0 };
}

export async function hydrateCanvasCloudStatus() {
    await ensureSyncedSnapshotLoaded();
    notifyStatusListeners();
    return lastSyncedSnapshot;
}

function asTime(value?: string) {
    return Date.parse(value || "") || 0;
}

function normalizeTombstones(rows: unknown) {
    if (!Array.isArray(rows)) return [] as Array<{ id: string; deletedAt: string }>;
    const byId = new Map<string, { id: string; deletedAt: string }>();
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const id = String((row as { id?: string }).id || "").trim();
        const deletedAt = String((row as { deletedAt?: string }).deletedAt || "").trim();
        if (!id || !asTime(deletedAt)) continue;
        const current = byId.get(id);
        if (!current || asTime(deletedAt) > asTime(current.deletedAt)) byId.set(id, { id, deletedAt });
    }
    return [...byId.values()].sort((a, b) => asTime(b.deletedAt) - asTime(a.deletedAt)).slice(0, MAX_TOMBSTONES);
}

async function readLocalTombstones() {
    const persisted = normalizeTombstones(await tombstoneStore.getItem(TOMBSTONE_KEY));
    return normalizeTombstones([...persisted, ...pendingTombstones.values()]);
}

async function writeLocalTombstones(rows: Array<{ id: string; deletedAt: string }>) {
    const normalized = normalizeTombstones([...rows, ...pendingTombstones.values()]);
    await tombstoneStore.setItem(TOMBSTONE_KEY, normalized);
    for (const row of normalized) {
        const pending = pendingTombstones.get(row.id);
        if (pending && asTime(row.deletedAt) >= asTime(pending.deletedAt)) pendingTombstones.delete(row.id);
    }
    return normalized;
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

/** Debounced push after local save. Safe no-op when logged out / offline. */
export function schedulePushCanvasProject(projectId: string) {
    if (!isLoggedIn()) return;
    // A recreated/imported project with same id should not stay tombstoned.
    pendingTombstones.delete(projectId);
    failedProjectIds.delete(projectId);
    void readLocalTombstones().then((rows) => writeLocalTombstones(rows.filter((row) => row.id !== projectId)));
    notifyStatusListeners();
    const prev = pushTimers.get(projectId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
        pushTimers.delete(projectId);
        notifyStatusListeners();
        void pushCanvasProjectNow(projectId);
    }, PUSH_DEBOUNCE_MS);
    pushTimers.set(projectId, timer);
    notifyStatusListeners();
}

export async function pushCanvasProjectNow(projectId: string, options?: { force?: boolean }) {
    if (!isLoggedIn()) return { ok: false as const, reason: "not_logged_in" as const };
    const local = useCanvasStore.getState().openProject(projectId);
    if (!local) return { ok: false as const, reason: "missing_local" as const };
    try {
        // Media first so other devices can resolve storageKeys after JSON lands.
        await uploadReferencedCloudBlobs(local);
        const result = await putCloudProject(toCloudProject(local), { force: options?.force });
        // Successful push means this id is alive again.
        const rows = await readLocalTombstones();
        await writeLocalTombstones(rows.filter((row) => row.id !== projectId));
        await markProjectsSynced([local]);
        return { ok: true as const, created: Boolean(result.created) };
    } catch (error) {
        if (isCloudApiError(error) && error.status === 409) {
            const data = (error as CloudApiError & { data?: { project?: CloudCanvasProject } }).data;
            failedProjectIds.add(projectId);
            notifyStatusListeners();
            return { ok: false as const, reason: "conflict" as const, cloud: data?.project ? fromCloudProject(data.project) : null };
        }
        console.warn("canvas cloud push failed", error);
        failedProjectIds.add(projectId);
        notifyStatusListeners();
        return { ok: false as const, reason: "network" as const };
    }
}

/**
 * Pull cloud list and merge into local by updatedAt (newer wins per id).
 * Does not delete local-only projects. Downloads missing media best-effort.
 * Local deletion tombstones suppress cloud resurrection until cloud delete succeeds
 * or a newer local recreation is pushed.
 */
export async function pullAndMergeCanvasProjects() {
    if (!isLoggedIn()) return { ok: false as const, merged: 0, pulled: 0, mediaDownloaded: 0 };
    try {
        const { items } = await listCloudProjects();
        let merged = 0;
        let pulled = 0;
        let mediaDownloaded = 0;
        let suppressed = 0;
        const tombstones = await readLocalTombstones();
        const tombstoneMap = new Map(tombstones.map((row) => [row.id, asTime(row.deletedAt)]));
        const remainingTombstones = [...tombstones];

        for (const meta of items) {
            const current = useCanvasStore.getState();
            const local = current.projects.find((p) => p.id === meta.id);
            const cloudTs = Date.parse(meta.updated_at || "") || 0;
            const localTs = local ? Date.parse(local.updatedAt || "") || 0 : 0;
            const deletedAt = tombstoneMap.get(meta.id) || 0;

            // Locally deleted after last known cloud revision: keep suppressed and retry cloud delete.
            if (!local && deletedAt && deletedAt >= cloudTs) {
                suppressed += 1;
                void removeCloudCanvasProject(meta.id);
                continue;
            }
            // Cloud is newer than local delete tombstone: accept cloud revival as intentional remote edit.
            if (!local && deletedAt && cloudTs > deletedAt) {
                // drop this tombstone
                const idx = remainingTombstones.findIndex((row) => row.id === meta.id);
                if (idx >= 0) remainingTombstones.splice(idx, 1);
            }

            if (local && localTs >= cloudTs) {
                const media = await downloadMissingCloudBlobs(local);
                mediaDownloaded += media.downloaded;
                continue;
            }
            try {
                const full = await getCloudProject(meta.id);
                const cloudProject = fromCloudProject(full.project);
                // If local exists and is still newer after fetch race, keep local.
                const latestLocal = useCanvasStore.getState().projects.find((p) => p.id === cloudProject.id);
                if (latestLocal && asTime(latestLocal.updatedAt) >= asTime(cloudProject.updatedAt)) {
                    const media = await downloadMissingCloudBlobs(latestLocal);
                    mediaDownloaded += media.downloaded;
                    continue;
                }
                const latest = useCanvasStore.getState();
                if (latest.projects.some((p) => p.id === cloudProject.id)) {
                    latest.replaceProjects(latest.projects.map((p) => (p.id === cloudProject.id ? cloudProject : p)));
                } else {
                    latest.replaceProjects([cloudProject, ...latest.projects]);
                }
                const media = await downloadMissingCloudBlobs(cloudProject);
                mediaDownloaded += media.downloaded;
                merged += 1;
                pulled += 1;
            } catch (error) {
                console.warn("canvas cloud pull one failed", meta.id, error);
            }
        }
        await writeLocalTombstones(remainingTombstones);
        // After a successful pull/merge pass, mark currently local projects that match cloud updatedAt as synced.
        const localProjects = useCanvasStore.getState().projects;
        const cloudUpdated = new Map(items.map((item) => [item.id, item.updated_at || ""]));
        const confirmed = localProjects.filter((project) => {
            const cloudAt = cloudUpdated.get(project.id);
            return cloudAt && asTime(cloudAt) === asTime(project.updatedAt);
        });
        if (confirmed.length) await markProjectsSynced(confirmed);
        else notifyStatusListeners();
        return { ok: true as const, merged, pulled, listed: items.length, mediaDownloaded, suppressed };
    } catch (error) {
        console.warn("canvas cloud list failed", error);
        notifyStatusListeners();
        return { ok: false as const, merged: 0, pulled: 0, mediaDownloaded: 0 };
    }
}

export async function recordCanvasProjectDeletion(projectId: string, deletedAt = new Date().toISOString()) {
    pendingTombstones.set(projectId, { id: projectId, deletedAt });
    failedProjectIds.delete(projectId);
    const rows = await readLocalTombstones();
    await writeLocalTombstones(rows);
    await ensureSyncedSnapshotLoaded();
    if (lastSyncedSnapshot?.signatures[projectId]) {
        const signatures = { ...lastSyncedSnapshot.signatures };
        delete signatures[projectId];
        await writeSyncedSnapshot({ signatures });
    } else {
        notifyStatusListeners();
    }
    // Best-effort immediate cloud delete; tombstone covers offline/failures.
    await removeCloudCanvasProject(projectId);
}

export async function removeCloudCanvasProject(projectId: string) {
    if (!isLoggedIn()) return false;
    try {
        await deleteCloudProject(projectId);
        const rows = await readLocalTombstones();
        await writeLocalTombstones(rows.filter((row) => row.id !== projectId));
        notifyStatusListeners();
        return true;
    } catch (error) {
        console.warn("canvas cloud delete failed", error);
        notifyStatusListeners();
        return false;
    }
}
