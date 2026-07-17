/**
 * Frontend mirror of api/src/model/cloud-domain.js stable reason/status codes.
 * Keep values identical so UI can branch without Chinese string matching.
 * Do not invent extra wire values here without updating the API first.
 */

export const CLOUD_JOB_TYPE = {
    IMAGE: "image",
    VIDEO: "video",
} as const;

export type CloudJobType = (typeof CLOUD_JOB_TYPE)[keyof typeof CLOUD_JOB_TYPE];

export const CLOUD_JOB_SOURCE = {
    CLIENT_UPLOAD: "client_upload",
    SERVER_FETCH: "server_fetch",
    SERVER_GENERATE: "server_generate",
} as const;

export const CLOUD_JOB_STATUS = {
    SUCCESS: "success",
    FAILED: "failed",
    CANCELLED: "cancelled",
    DELETED: "deleted",
} as const;

export const CLOUD_SAVE_STATUS = {
    STORED: "stored",
    FAILED: "failed",
    SKIPPED: "skipped",
} as const;

/** Local history → cloud upload markers (browser only; not API job.status). */
export const CLOUD_SYNC_STATUS = {
    IDLE: "idle",
    PENDING: "pending",
    SYNCED: "synced",
    FAILED: "failed",
    SKIPPED: "skipped",
} as const;

export type CloudSyncStatus = (typeof CLOUD_SYNC_STATUS)[keyof typeof CLOUD_SYNC_STATUS];

export const CLOUD_ERROR_REASON = {
    AUTH_REQUIRED: "auth_required",
    ORIGIN_NOT_ALLOWED: "origin_not_allowed",
    STORAGE_QUOTA_EXCEEDED: "storage_quota_exceeded",
    INVITE_CODE_INVALID: "invite_code_invalid",
    EMAIL_ALREADY_REGISTERED: "email_already_registered",
    LOGIN_INVALID_CREDENTIALS: "login_invalid_credentials",
    ACCOUNT_TEMPORARILY_LOCKED: "account_temporarily_locked",
    UPLOAD_RATE_LIMITED: "upload_rate_limited",
    LOGIN_RATE_LIMITED: "login_rate_limited",
    REGISTER_RATE_LIMITED: "register_rate_limited",
    INVALID_EMAIL: "invalid_email",
    WEAK_PASSWORD: "weak_password",
    ACCOUNT_DISABLED: "account_disabled",
    NOT_FOUND: "not_found",
    BAD_REQUEST: "bad_request",
    PAYLOAD_TOO_LARGE: "payload_too_large",
    UNSUPPORTED_MEDIA_TYPE: "unsupported_media_type",
    REMOTE_FETCH_FORBIDDEN_HOST: "remote_fetch_forbidden_host",
    REMOTE_FETCH_PRIVATE_TARGET: "remote_fetch_private_target",
    REMOTE_FETCH_DNS_FAILED: "remote_fetch_dns_failed",
    REMOTE_FETCH_TIMEOUT: "remote_fetch_timeout",
    REMOTE_FETCH_TOO_MANY_REDIRECTS: "remote_fetch_too_many_redirects",
    REMOTE_FETCH_INVALID_URL: "remote_fetch_invalid_url",
    REMOTE_FETCH_UNSUPPORTED_TYPE: "remote_fetch_unsupported_type",
    REMOTE_FETCH_TOO_LARGE: "remote_fetch_too_large",
    REMOTE_FETCH_EMPTY: "remote_fetch_empty",
    REMOTE_FETCH_FAILED: "remote_fetch_failed",
    REMOTE_FETCH_BAD_GATEWAY: "remote_fetch_bad_gateway",
    REMOTE_FETCH_NOT_READY: "remote_fetch_not_ready",
    ADMIN_UNAUTHORIZED: "admin_unauthorized",
    ADMIN_NOT_CONFIGURED: "admin_not_configured",
    CREDITS_INSUFFICIENT: "credits_insufficient",
    USER_NOT_FOUND: "user_not_found",
    INTERNAL_ERROR: "internal_error",
} as const;

export type CloudErrorReason = (typeof CLOUD_ERROR_REASON)[keyof typeof CLOUD_ERROR_REASON];

export function isCloudErrorReason(value: unknown): value is CloudErrorReason {
    return typeof value === "string" && Object.values(CLOUD_ERROR_REASON).includes(value as CloudErrorReason);
}

/** Prefer stable reason; fall back to legacy Chinese / status text only when reason missing. */
export function isStorageQuotaError(error: { reason?: string; message?: string; status?: number } | null | undefined) {
    if (!error) return false;
    if (error.reason === CLOUD_ERROR_REASON.STORAGE_QUOTA_EXCEEDED) return true;
    if (error.status === 413) return true;
    const detail = `${error.message || ""}`;
    return detail.includes("空间不足") || detail.includes("storage_quota_exceeded");
}
