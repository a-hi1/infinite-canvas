export type CloudUser = {
    id: string;
    email: string;
    display_name?: string;
    plan_code?: string;
    status?: string;
    created_at?: string;
};

export type CloudFile = {
    id: string;
    kind: string;
    mime: string;
    bytes: number;
    width?: number;
    height?: number;
    duration_ms?: number;
    url: string;
};

export type CloudJob = {
    id: string;
    type: "image" | "video" | string;
    status: string;
    prompt: string;
    model: string;
    params?: Record<string, unknown>;
    error_message?: string;
    result_file_id?: string | null;
    client_local_id?: string;
    source?: string;
    provider?: string;
    save_status?: string;
    created_at?: string;
    finished_at?: string;
    file?: CloudFile | null;
    /** Response-only: same client_local_id already stored (retry-safe; future billing should not double-charge). */
    deduped?: boolean;
    repaired?: boolean;
};

type ApiEnvelope<T> = { code: number; data: T; msg: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers || {});
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }
    const response = await fetch(`/api${path}`, {
        ...init,
        headers,
        credentials: "include",
    });
    let payload: ApiEnvelope<T> | null = null;
    try {
        payload = (await response.json()) as ApiEnvelope<T>;
    } catch {
        payload = null;
    }
    if (!response.ok || !payload || payload.code !== 0) {
        throw new Error(payload?.msg || `请求失败（${response.status}）`);
    }
    return payload.data;
}

export function getCloudMe() {
    return request<{ user: CloudUser | null }>("/auth/me");
}

export function cloudRegister(input: { email: string; password: string; displayName?: string; inviteCode?: string }) {
    return request<{ user: CloudUser }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({
            email: input.email,
            password: input.password,
            display_name: input.displayName || "",
            invite_code: input.inviteCode || "",
        }),
    });
}

export function cloudLogin(input: { email: string; password: string }) {
    return request<{ user: CloudUser }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
    });
}

export function cloudLogout() {
    return request<{ ok: boolean }>("/auth/logout", { method: "POST", body: "{}" });
}

export function listCloudJobs(input?: { type?: "image" | "video"; page?: number; pageSize?: number }) {
    const params = new URLSearchParams();
    if (input?.type) params.set("type", input.type);
    if (input?.page) params.set("page", String(input.page));
    if (input?.pageSize) params.set("page_size", String(input.pageSize));
    const q = params.toString();
    return request<{ items: CloudJob[]; total: number; page: number; page_size: number }>(`/jobs${q ? `?${q}` : ""}`);
}

export async function uploadCloudJob(input: {
    type: "image" | "video";
    file: Blob;
    filename?: string;
    prompt?: string;
    model?: string;
    provider?: string;
    clientLocalId?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    params?: Record<string, unknown>;
}) {
    const form = new FormData();
    form.append("file", input.file, input.filename || (input.type === "image" ? "result.png" : "result.mp4"));
    form.append("prompt", input.prompt || "");
    form.append("model", input.model || "");
    form.append("provider", input.provider || "");
    form.append("client_local_id", input.clientLocalId || "");
    form.append("width", String(input.width || 0));
    form.append("height", String(input.height || 0));
    form.append("duration_ms", String(input.durationMs || 0));
    form.append("params_json", JSON.stringify(input.params || {}));
    return request<CloudJob>(`/jobs/${input.type}`, { method: "POST", body: form });
}

export function deleteCloudJob(jobId: string) {
    return request<{ ok: boolean }>(`/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
}

export async function blobFromUrl(url: string) {
    const response = await fetch(url, { credentials: url.startsWith("/") ? "include" : "same-origin" });
    if (!response.ok) throw new Error(`读取文件失败（${response.status}）`);
    return response.blob();
}

/** 带登录态拉取云端文件，转为可预览 blob URL（用完须 revoke）。 */
export async function cloudFileObjectUrl(fileUrl: string) {
    const url = fileUrl.startsWith("http") ? fileUrl : fileUrl.startsWith("/api/") ? fileUrl : fileUrl.startsWith("/files/") ? `/api${fileUrl}` : `/api/files/${fileUrl}`;
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`读取云端文件失败（${response.status}）`);
    const blob = await response.blob();
    return URL.createObjectURL(blob);
}
