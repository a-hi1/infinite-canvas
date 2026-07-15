/** Shared local-history cloud sync markers. Forward-compatible with future billing/job links. */
export type CloudSyncStatus = "idle" | "pending" | "synced" | "failed" | "skipped";

export function cloudSyncLabel(status?: CloudSyncStatus) {
    if (status === "pending") return "同步中";
    if (status === "synced") return "已上云";
    if (status === "failed") return "上云失败";
    if (status === "skipped") return "仅本机";
    return "";
}

export function cloudSyncColor(status?: CloudSyncStatus): "default" | "processing" | "success" | "error" | "warning" {
    if (status === "pending") return "processing";
    if (status === "synced") return "success";
    if (status === "failed") return "error";
    if (status === "skipped") return "default";
    return "default";
}

export function normalizeCloudSyncStatus(value: unknown): CloudSyncStatus | undefined {
    if (value === "idle" || value === "pending" || value === "synced" || value === "failed" || value === "skipped") return value;
    return undefined;
}
