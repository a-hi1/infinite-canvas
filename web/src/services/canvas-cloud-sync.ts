/**
 * Canvas project cloud sync (P2 MVP).
 * Local-first: always keep IndexedDB/local store; push/pull only when logged in.
 * Failure must never block local edit/save.
 */

import {
    CloudApiError,
    deleteCloudProject,
    getCloudProject,
    isCloudApiError,
    listCloudProjects,
    putCloudProject,
    type CloudCanvasProject,
} from "@/services/cloud-api";
import { useAuthStore } from "@/stores/use-auth-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PUSH_DEBOUNCE_MS = 1500;

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
        const result = await putCloudProject(toCloudProject(local), { force: options?.force });
        return { ok: true as const, created: Boolean(result.created) };
    } catch (error) {
        if (isCloudApiError(error) && error.status === 409) {
            const data = (error as CloudApiError & { data?: { project?: CloudCanvasProject } }).data;
            return { ok: false as const, reason: "conflict" as const, cloud: data?.project ? fromCloudProject(data.project) : null };
        }
        // Local remains source of truth; cloud failure is non-fatal.
        console.warn("canvas cloud push failed", error);
        return { ok: false as const, reason: "network" as const };
    }
}

/**
 * Pull cloud list and merge into local by updatedAt (newer wins per id).
 * Does not delete local-only projects.
 */
export async function pullAndMergeCanvasProjects() {
    if (!isLoggedIn()) return { ok: false as const, merged: 0, pulled: 0 };
    try {
        const { items } = await listCloudProjects();
        const store = useCanvasStore.getState();
        let merged = 0;
        let pulled = 0;

        for (const meta of items) {
            // Re-read store each iteration so sequential merges see prior replacements.
            const current = useCanvasStore.getState();
            const local = current.projects.find((p) => p.id === meta.id);
            const cloudTs = Date.parse(meta.updated_at || "") || 0;
            const localTs = local ? Date.parse(local.updatedAt || "") || 0 : 0;
            if (local && localTs >= cloudTs) continue;
            try {
                const full = await getCloudProject(meta.id);
                const cloudProject = fromCloudProject(full.project);
                const latest = useCanvasStore.getState();
                if (local || latest.projects.some((p) => p.id === cloudProject.id)) {
                    latest.replaceProjects(latest.projects.map((p) => (p.id === cloudProject.id ? cloudProject : p)));
                } else {
                    latest.replaceProjects([cloudProject, ...latest.projects]);
                }
                merged += 1;
                pulled += 1;
            } catch (error) {
                console.warn("canvas cloud pull one failed", meta.id, error);
            }
        }
        return { ok: true as const, merged, pulled, listed: items.length };
    } catch (error) {
        console.warn("canvas cloud list failed", error);
        return { ok: false as const, merged: 0, pulled: 0 };
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
