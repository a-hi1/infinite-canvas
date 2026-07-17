import { CLOUD_SYNC_STATUS, type CloudSyncStatus } from "@/lib/cloud-domain";

export type { CloudSyncStatus };

export function cloudSyncLabel(status?: CloudSyncStatus) {
    if (status === CLOUD_SYNC_STATUS.PENDING) return "同步中";
    if (status === CLOUD_SYNC_STATUS.SYNCED) return "已上云";
    if (status === CLOUD_SYNC_STATUS.FAILED) return "上云失败";
    if (status === CLOUD_SYNC_STATUS.SKIPPED) return "仅本机";
    return "";
}

export function cloudSyncColor(status?: CloudSyncStatus): "default" | "processing" | "success" | "error" | "warning" {
    if (status === CLOUD_SYNC_STATUS.PENDING) return "processing";
    if (status === CLOUD_SYNC_STATUS.SYNCED) return "success";
    if (status === CLOUD_SYNC_STATUS.FAILED) return "error";
    if (status === CLOUD_SYNC_STATUS.SKIPPED) return "default";
    return "default";
}

export function normalizeCloudSyncStatus(value: unknown): CloudSyncStatus | undefined {
    if (
        value === CLOUD_SYNC_STATUS.IDLE ||
        value === CLOUD_SYNC_STATUS.PENDING ||
        value === CLOUD_SYNC_STATUS.SYNCED ||
        value === CLOUD_SYNC_STATUS.FAILED ||
        value === CLOUD_SYNC_STATUS.SKIPPED
    ) {
        return value;
    }
    return undefined;
}
