export type CloudUser = {
    id: string;
    email: string;
    display_name?: string;
    plan_code?: string;
    status?: string;
    created_at?: string;
};

export type CloudUsage = {
    used_bytes: number;
    job_count: number;
    image_job_count?: number;
    video_job_count?: number;
};

export type CloudLimits = {
    max_user_bytes: number;
    max_image_bytes: number;
    max_video_bytes: number;
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

/** 带 HTTP 状态的云 API 错误，便于 401 清会话、413 展示容量不足 */
export class CloudApiError extends Error {
    status: number;
    constructor(message: string, status = 500) {
        super(message);
        this.name = "CloudApiError";
        this.status = status;
    }
}

function notifyUnauthorized() {
    // 松耦合：auth store 在 client-root 注册监听，避免 cloud-api ↔ store 循环依赖
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
    let payload: ApiEnvelope<T> | null = null;
    try {
        payload = (await response.json()) as ApiEnvelope<T>;
    } catch {
        payload = null;
    }
    if (response.status === 401) {
        // /auth/me 未登录返回 200+user:null，这里 401 来自受保护接口
        notifyUnauthorized();
        throw new CloudApiError(payload?.msg || "请先登录", 401);
    }
    if (!response.ok || !payload || payload.code !== 0) {
        throw new CloudApiError(payload?.msg || `请求失败（${response.status}）`, response.status);
    }
    return payload.data;
}

export function getCloudMe() {
    return request<{ user: CloudUser | null; usage?: CloudUsage | null; limits?: CloudLimits | null }>("/auth/me");
}

export function isCloudApiError(error: unknown): error is CloudApiError {
    return error instanceof CloudApiError;
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
