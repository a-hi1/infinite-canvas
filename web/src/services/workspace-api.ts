import {
    WORKSPACE_ITEM_KIND,
    WORKSPACE_ITEM_RESOLUTION,
    WORKSPACE_ITEM_SOURCE,
    WORKSPACE_ROLE,
    WORKSPACE_TASK_STATUS,
    type CloudErrorReason,
} from "@/lib/cloud-domain";
import { CloudApiError } from "@/services/cloud-api";

export { WORKSPACE_ITEM_KIND, WORKSPACE_ITEM_RESOLUTION, WORKSPACE_ITEM_SOURCE, WORKSPACE_ROLE, WORKSPACE_TASK_STATUS };

export type WorkspaceSummary = {
    id: string;
    name: string;
    owner_id: string;
    invite_code?: string;
    status?: string;
    created_at?: string;
    updated_at?: string;
    role?: string | null;
    member_count?: number;
};

export type WorkspaceMember = {
    id: string;
    workspace_id: string;
    user_id: string;
    role: string;
    joined_at?: string;
    display_name?: string;
    email?: string;
};

export type WorkspaceItemReaction = {
    user_id: string;
    resolution: string;
    comment?: string;
    updated_at?: string;
    display_name?: string;
    email?: string;
};

export type WorkspaceItem = {
    id: string;
    workspace_id: string;
    kind: string;
    title: string;
    note?: string;
    category?: string;
    tags?: string[];
    prompt?: string;
    model?: string;
    file_id?: string | null;
    text_content?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mime?: string;
    source_type?: string;
    source_ref?: string;
    /** Human revision label, e.g. "v2" / "终稿-A". */
    version?: string;
    /** Optional earlier item this revises (same workspace). */
    replaces_item_id?: string;
    /** Final draft flag on material wall. */
    is_final?: boolean;
    /** Member votes: 用/弃/改 (+ optional short comment). */
    reactions?: WorkspaceItemReaction[];
    created_by: string;
    created_by_name?: string;
    created_by_email?: string;
    created_at?: string;
    updated_at?: string;
    file_url?: string | null;
};

export type WorkspaceTaskAssignee = {
    user_id: string;
    display_name?: string;
    email?: string;
};

export type WorkspaceTaskDeliverable = {
    file_id: string;
    name?: string;
    mime?: string;
    bytes?: number;
    url?: string | null;
    uploaded_by?: string;
    created_at?: string;
};

export type WorkspaceTask = {
    id: string;
    workspace_id: string;
    title: string;
    body?: string;
    status: string;
    /** Multi-assignee (preferred). */
    assignee_user_ids?: string[];
    /** Legacy single assignee — first of assignee_user_ids when present. */
    assignee_user_id?: string | null;
    assignees?: WorkspaceTaskAssignee[];
    /** Multi deliverables (preferred). */
    deliverables?: WorkspaceTaskDeliverable[];
    /** Legacy single deliverable fields — first of deliverables when present. */
    deliverable_file_id?: string | null;
    deliverable_name?: string;
    deliverable_mime?: string;
    deliverable_bytes?: number;
    deliverable_url?: string | null;
    created_by: string;
    created_by_name?: string;
    created_by_email?: string;
    sort_order?: number;
    created_at?: string;
    updated_at?: string;
};

type ApiEnvelope<T> = { code: number; data: T; msg: string; reason?: string };

function notifyUnauthorized() {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("infinite-canvas:cloud-unauthorized"));
    }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers || {});
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }
    let response: Response;
    try {
        response = await fetch(`/api${path}`, {
            ...init,
            headers,
            credentials: "include",
        });
    } catch {
        throw new CloudApiError("无法连接云端服务", 0);
    }
    // Binary file routes return non-JSON; callers should use fetch directly.
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        if (response.status === 401) {
            notifyUnauthorized();
            throw new CloudApiError("请先登录", 401, "auth_required");
        }
        if (!response.ok) throw new CloudApiError(`请求失败（${response.status}）`, response.status);
        return response as unknown as T;
    }
    let payload: ApiEnvelope<T> | null = null;
    try {
        payload = (await response.json()) as ApiEnvelope<T>;
    } catch {
        payload = null;
    }
    if (response.status === 401) {
        notifyUnauthorized();
        throw new CloudApiError(payload?.msg || "请先登录", 401, payload?.reason as CloudErrorReason | undefined);
    }
    if (!response.ok || !payload || payload.code !== 0) {
        throw new CloudApiError(payload?.msg || `请求失败（${response.status}）`, response.status, payload?.reason);
    }
    return payload.data;
}

export function listWorkspaces() {
    return request<{ items: WorkspaceSummary[]; total: number }>("/workspaces");
}

export function createWorkspace(input: { name: string }) {
    return request<WorkspaceSummary>("/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: input.name }),
    });
}

export function joinWorkspace(input: { inviteCode: string }) {
    return request<WorkspaceSummary>("/workspaces/join", {
        method: "POST",
        body: JSON.stringify({ invite_code: input.inviteCode }),
    });
}

export function getWorkspace(workspaceId: string) {
    return request<{ workspace: WorkspaceSummary; members: WorkspaceMember[] }>(`/workspaces/${encodeURIComponent(workspaceId)}`);
}

export function resetWorkspaceInvite(workspaceId: string) {
    return request<WorkspaceSummary>(`/workspaces/${encodeURIComponent(workspaceId)}/invite/reset`, {
        method: "POST",
        body: "{}",
    });
}

export function archiveWorkspace(workspaceId: string) {
    return request<{ ok: boolean; id: string }>(`/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "DELETE",
    });
}

export function listWorkspaceItems(
    workspaceId: string,
    input?: { kind?: string; category?: string; page?: number; pageSize?: number },
) {
    const params = new URLSearchParams();
    if (input?.kind) params.set("kind", input.kind);
    if (input?.category) params.set("category", input.category);
    if (input?.page) params.set("page", String(input.page));
    if (input?.pageSize) params.set("page_size", String(input.pageSize));
    const qs = params.toString();
    return request<{ items: WorkspaceItem[]; total: number; page: number; page_size: number }>(
        `/workspaces/${encodeURIComponent(workspaceId)}/items${qs ? `?${qs}` : ""}`,
    );
}

export type ShareWorkspaceItemInput = {
    kind: string;
    title?: string;
    note?: string;
    category?: string;
    tags?: string[];
    prompt?: string;
    model?: string;
    sourceType?: string;
    sourceRef?: string;
    textContent?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mime?: string;
    version?: string;
    replacesItemId?: string;
    isFinal?: boolean;
    /** Media blob for image/video kinds. */
    file?: Blob;
    filename?: string;
};

export function createWorkspaceItem(workspaceId: string, input: ShareWorkspaceItemInput) {
    const isText = input.kind === WORKSPACE_ITEM_KIND.ASSET_TEXT;
    if (isText) {
        return request<WorkspaceItem>(`/workspaces/${encodeURIComponent(workspaceId)}/items`, {
            method: "POST",
            body: JSON.stringify({
                kind: input.kind,
                title: input.title || "",
                note: input.note || "",
                category: input.category || "",
                tags: input.tags || [],
                prompt: input.prompt || "",
                model: input.model || "",
                source_type: input.sourceType || WORKSPACE_ITEM_SOURCE.ASSET,
                source_ref: input.sourceRef || "",
                text_content: input.textContent || "",
                version: input.version || "",
                replaces_item_id: input.replacesItemId || "",
                is_final: Boolean(input.isFinal),
            }),
        });
    }
    const form = new FormData();
    form.append("kind", input.kind);
    form.append("title", input.title || "");
    form.append("note", input.note || "");
    form.append("category", input.category || "");
    form.append("tags", JSON.stringify(input.tags || []));
    form.append("prompt", input.prompt || "");
    form.append("model", input.model || "");
    form.append("source_type", input.sourceType || WORKSPACE_ITEM_SOURCE.ASSET);
    form.append("source_ref", input.sourceRef || "");
    form.append("width", String(input.width || 0));
    form.append("height", String(input.height || 0));
    form.append("bytes", String(input.bytes || 0));
    form.append("mime", input.mime || "");
    form.append("version", input.version || "");
    form.append("replaces_item_id", input.replacesItemId || "");
    form.append("is_final", input.isFinal ? "true" : "false");
    // Optional short card summary for documents (full body stays in file).
    if (input.textContent) form.append("text_content", input.textContent);
    if (input.file) {
        form.append("file", input.file, input.filename || "share.bin");
    }
    return request<WorkspaceItem>(`/workspaces/${encodeURIComponent(workspaceId)}/items`, {
        method: "POST",
        body: form,
    });
}

export type UpdateWorkspaceItemInput = {
    title?: string;
    note?: string;
    category?: string;
    tags?: string[];
    version?: string;
    replacesItemId?: string | null;
    isFinal?: boolean;
};

export function updateWorkspaceItem(workspaceId: string, itemId: string, patch: UpdateWorkspaceItemInput) {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.note !== undefined) body.note = patch.note;
    if (patch.category !== undefined) body.category = patch.category;
    if (patch.tags !== undefined) body.tags = patch.tags;
    if (patch.version !== undefined) body.version = patch.version;
    if (patch.replacesItemId !== undefined) body.replaces_item_id = patch.replacesItemId || "";
    if (patch.isFinal !== undefined) body.is_final = patch.isFinal;
    return request<WorkspaceItem>(
        `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}`,
        {
            method: "PATCH",
            body: JSON.stringify(body),
        },
    );
}

/** Upsert caller's own 用/弃/改 vote on a shared item. */
export function upsertWorkspaceItemReaction(
    workspaceId: string,
    itemId: string,
    input: { resolution: string; comment?: string },
) {
    return request<WorkspaceItem>(
        `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/reaction`,
        {
            method: "PUT",
            body: JSON.stringify({
                resolution: input.resolution,
                comment: input.comment ?? "",
            }),
        },
    );
}

/** Clear own reaction; owner may pass userId to clear another's. */
export function clearWorkspaceItemReaction(workspaceId: string, itemId: string, userId?: string) {
    const qs = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
    return request<WorkspaceItem>(
        `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/reaction${qs}`,
        { method: "DELETE" },
    );
}

export function deleteWorkspaceItem(workspaceId: string, itemId: string) {
    return request<{ ok: boolean; id: string }>(
        `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}`,
        { method: "DELETE" },
    );
}

export function removeWorkspaceMember(workspaceId: string, userId: string) {
    return request<{ ok: boolean; user_id: string }>(
        `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
    );
}

export function listWorkspaceTasks(workspaceId: string) {
    return request<{ items: WorkspaceTask[]; total: number }>(`/workspaces/${encodeURIComponent(workspaceId)}/tasks`);
}

export type WorkspaceTaskInput = {
    title: string;
    body?: string;
    status?: string;
    /** Multi-select assignees (preferred). */
    assigneeUserIds?: string[];
    /** Legacy single assignee. */
    assigneeUserId?: string | null;
};

export function createWorkspaceTask(workspaceId: string, input: WorkspaceTaskInput) {
    const assigneeIds =
        input.assigneeUserIds !== undefined
            ? input.assigneeUserIds
            : input.assigneeUserId
              ? [input.assigneeUserId]
              : [];
    return request<WorkspaceTask>(`/workspaces/${encodeURIComponent(workspaceId)}/tasks`, {
        method: "POST",
        body: JSON.stringify({
            title: input.title,
            body: input.body || "",
            status: input.status || WORKSPACE_TASK_STATUS.TODO,
            assignee_user_ids: assigneeIds,
            assignee_user_id: assigneeIds[0] || null,
        }),
    });
}

export function updateWorkspaceTask(
    workspaceId: string,
    taskId: string,
    patch: {
        title?: string;
        body?: string;
        status?: string;
        assigneeUserIds?: string[];
        assigneeUserId?: string | null;
        /** Append a deliverable file (multipart). Does not replace existing ones. */
        deliverableFile?: Blob;
        deliverableFilename?: string;
        /** Remove one deliverable by file_id. */
        removeDeliverableFileId?: string;
        /** Clear all deliverables. */
        clearDeliverable?: boolean;
    },
) {
    if (patch.deliverableFile || patch.clearDeliverable || patch.removeDeliverableFileId) {
        const form = new FormData();
        if (patch.title !== undefined) form.append("title", patch.title);
        if (patch.body !== undefined) form.append("body", patch.body);
        if (patch.status !== undefined) form.append("status", patch.status);
        if (patch.assigneeUserIds !== undefined) {
            form.append("assignee_user_ids", JSON.stringify(patch.assigneeUserIds));
            form.append("assignee_user_id", patch.assigneeUserIds[0] || "");
        } else if (patch.assigneeUserId !== undefined) {
            form.append("assignee_user_ids", JSON.stringify(patch.assigneeUserId ? [patch.assigneeUserId] : []));
            form.append("assignee_user_id", patch.assigneeUserId || "");
        }
        if (patch.clearDeliverable) form.append("clear_deliverable", "true");
        if (patch.removeDeliverableFileId) form.append("remove_deliverable_file_id", patch.removeDeliverableFileId);
        if (patch.deliverableFile) {
            form.append("file", patch.deliverableFile, patch.deliverableFilename || "deliverable.bin");
        }
        return request<WorkspaceTask>(
            `/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}`,
            {
                method: "PATCH",
                body: form,
            },
        );
    }

    const body: Record<string, unknown> = {
        title: patch.title,
        body: patch.body,
        status: patch.status,
    };
    if (patch.assigneeUserIds !== undefined) {
        body.assignee_user_ids = patch.assigneeUserIds;
        body.assignee_user_id = patch.assigneeUserIds[0] || null;
    } else if (patch.assigneeUserId !== undefined) {
        body.assignee_user_ids = patch.assigneeUserId ? [patch.assigneeUserId] : [];
        body.assignee_user_id = patch.assigneeUserId || null;
    }
    return request<WorkspaceTask>(
        `/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}`,
        {
            method: "PATCH",
            body: JSON.stringify(body),
        },
    );
}

export function deleteWorkspaceTask(workspaceId: string, taskId: string) {
    return request<{ ok: boolean; id: string }>(
        `/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}`,
        { method: "DELETE" },
    );
}

function normalizeWorkspaceFileUrl(fileUrl: string) {
    if (fileUrl.startsWith("http")) return fileUrl;
    if (fileUrl.startsWith("/api/")) return fileUrl;
    if (fileUrl.startsWith("/workspace-files/")) return `/api${fileUrl}`;
    return `/api/workspace-files/${fileUrl}`;
}

/** Session-scoped blob URL cache — cards/modals share one download; callers should NOT revoke. */
const OBJECT_URL_CACHE_MAX = 96;
const objectUrlCache = new Map<string, string>();
const objectUrlInflight = new Map<string, Promise<string>>();
const textCache = new Map<string, string>();
const textInflight = new Map<string, Promise<string>>();

function touchObjectUrlCache(key: string, url: string) {
    if (objectUrlCache.has(key)) objectUrlCache.delete(key);
    objectUrlCache.set(key, url);
    while (objectUrlCache.size > OBJECT_URL_CACHE_MAX) {
        const oldest = objectUrlCache.keys().next().value as string | undefined;
        if (!oldest) break;
        const oldUrl = objectUrlCache.get(oldest);
        objectUrlCache.delete(oldest);
        if (oldUrl) URL.revokeObjectURL(oldUrl);
    }
}

/** Auth-gated blob URL for a workspace media file (shared cache; do not revoke). */
export async function workspaceFileObjectUrl(fileUrl: string) {
    const url = normalizeWorkspaceFileUrl(fileUrl);
    const cached = objectUrlCache.get(url);
    if (cached) {
        touchObjectUrlCache(url, cached);
        return cached;
    }
    const pending = objectUrlInflight.get(url);
    if (pending) return pending;

    const promise = (async () => {
        const response = await fetch(url, { credentials: "include" });
        if (response.status === 401) {
            notifyUnauthorized();
            throw new CloudApiError("请先登录", 401, "auth_required");
        }
        if (!response.ok) throw new CloudApiError(`读取工作空间文件失败（${response.status}）`, response.status);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        touchObjectUrlCache(url, objectUrl);
        return objectUrl;
    })();
    objectUrlInflight.set(url, promise);
    try {
        return await promise;
    } finally {
        objectUrlInflight.delete(url);
    }
}

/** Auth-gated UTF-8 text for workspace documents (md/txt/csv), with short session cache. */
export async function workspaceFileText(fileUrl: string) {
    const url = normalizeWorkspaceFileUrl(fileUrl);
    const cached = textCache.get(url);
    if (cached != null) return cached;
    const pending = textInflight.get(url);
    if (pending) return pending;

    const promise = (async () => {
        const response = await fetch(url, { credentials: "include" });
        if (response.status === 401) {
            notifyUnauthorized();
            throw new CloudApiError("请先登录", 401, "auth_required");
        }
        if (!response.ok) throw new CloudApiError(`读取工作空间文件失败（${response.status}）`, response.status);
        const text = await response.text();
        if (textCache.size > 40) {
            const oldest = textCache.keys().next().value as string | undefined;
            if (oldest) textCache.delete(oldest);
        }
        textCache.set(url, text);
        return text;
    })();
    textInflight.set(url, promise);
    try {
        return await promise;
    } finally {
        textInflight.delete(url);
    }
}

export function memberDisplayName(member: Pick<WorkspaceMember, "display_name" | "email" | "user_id"> | null | undefined) {
    if (!member) return "未知成员";
    return member.display_name || member.email || member.user_id.slice(0, 8);
}

export function itemUploaderLabel(item: Pick<WorkspaceItem, "created_by_name" | "created_by_email" | "created_by">) {
    return item.created_by_name || item.created_by_email || item.created_by.slice(0, 8) || "未知";
}

export function taskAssigneeIds(task: Pick<WorkspaceTask, "assignee_user_ids" | "assignee_user_id" | "assignees">) {
    if (Array.isArray(task.assignee_user_ids) && task.assignee_user_ids.length) return task.assignee_user_ids;
    if (Array.isArray(task.assignees) && task.assignees.length) return task.assignees.map((a) => a.user_id);
    if (task.assignee_user_id) return [task.assignee_user_id];
    return [] as string[];
}

/** Normalize multi + legacy single deliverable fields into a list. */
export function taskDeliverables(task: Pick<WorkspaceTask, "deliverables" | "deliverable_file_id" | "deliverable_name" | "deliverable_mime" | "deliverable_bytes" | "deliverable_url">) {
    if (Array.isArray(task.deliverables) && task.deliverables.length) {
        return task.deliverables.filter((d) => d && d.file_id);
    }
    if (task.deliverable_file_id) {
        return [
            {
                file_id: task.deliverable_file_id,
                name: task.deliverable_name || "",
                mime: task.deliverable_mime || "",
                bytes: task.deliverable_bytes || 0,
                url: task.deliverable_url || `/api/workspace-files/${task.deliverable_file_id}`,
            },
        ] as WorkspaceTaskDeliverable[];
    }
    return [] as WorkspaceTaskDeliverable[];
}

export function sourceTypeLabel(sourceType?: string) {
    if (sourceType === WORKSPACE_ITEM_SOURCE.ASSET) return "我的资产";
    if (sourceType === WORKSPACE_ITEM_SOURCE.WORKBENCH_LOCAL) return "工作台本机";
    if (sourceType === WORKSPACE_ITEM_SOURCE.WORKBENCH_CLOUD) return "工作台云端";
    if (sourceType === WORKSPACE_ITEM_SOURCE.LOCAL_UPLOAD) return "本地上传";
    if (sourceType === WORKSPACE_ITEM_SOURCE.CANVAS) return "画布";
    return sourceType || "分享";
}

/** Strip channelId:: prefix from model keys for display. */
export function displayModelName(model?: string | null) {
    const value = String(model || "").trim();
    if (!value) return "";
    const idx = value.indexOf("::");
    return idx >= 0 ? value.slice(idx + 2) || value : value;
}

export function resolutionLabel(resolution?: string | null) {
    if (resolution === WORKSPACE_ITEM_RESOLUTION.USE) return "用";
    if (resolution === WORKSPACE_ITEM_RESOLUTION.DISCARD) return "弃";
    if (resolution === WORKSPACE_ITEM_RESOLUTION.REVISE) return "改";
    return resolution || "";
}

/** Count votes by resolution for card badges. */
export function reactionCounts(reactions?: WorkspaceItemReaction[] | null) {
    const counts = { use: 0, discard: 0, revise: 0, total: 0 };
    for (const r of reactions || []) {
        if (!r) continue;
        counts.total += 1;
        if (r.resolution === WORKSPACE_ITEM_RESOLUTION.USE) counts.use += 1;
        else if (r.resolution === WORKSPACE_ITEM_RESOLUTION.DISCARD) counts.discard += 1;
        else if (r.resolution === WORKSPACE_ITEM_RESOLUTION.REVISE) counts.revise += 1;
    }
    return counts;
}
