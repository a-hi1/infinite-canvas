/** Stable domain enums for cloud API (JSON store + future Postgres/billing). */

export const JOB_TYPE = {
    IMAGE: "image",
    VIDEO: "video",
};

export const JOB_SOURCE = {
    CLIENT_UPLOAD: "client_upload",
    SERVER_FETCH: "server_fetch",
    /** Reserved for P1 server-side generation gateway. */
    SERVER_GENERATE: "server_generate",
};

export const JOB_STATUS = {
    SUCCESS: "success",
    FAILED: "failed",
    CANCELLED: "cancelled",
    DELETED: "deleted",
};

export const SAVE_STATUS = {
    STORED: "stored",
    FAILED: "failed",
    SKIPPED: "skipped",
};

export const FILE_STORAGE_BACKEND = {
    LOCAL: "local",
    S3: "s3",
    MINIO: "minio",
};

export const USER_STATUS = {
    ACTIVE: "active",
    DISABLED: "disabled",
};

/**
 * Credit ledger entry types (append-only).
 * grant/adjust: manual admin ops now.
 * charge/refund/reserve: reserved for P1 server-side generation billing.
 */
export const CREDIT_LEDGER_TYPE = {
    GRANT: "grant",
    ADJUST: "adjust",
    CHARGE: "charge",
    REFUND: "refund",
    RESERVE: "reserve",
    RELEASE: "release",
};

/** Currency unit stored as integer cents to avoid float drift. */
export const CREDIT_CURRENCY = {
    CNY_CENTS: "cny_cents",
};

/**
 * Stable machine-readable error reasons for API envelope `{ reason }`.
 * Frontend should prefer these over Chinese `msg` when branching.
 */
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
    PLATFORM_GENERATE_DISABLED: "platform_generate_disabled",
    PLATFORM_UPSTREAM_NOT_CONFIGURED: "platform_upstream_not_configured",
    PLATFORM_UPSTREAM_FAILED: "platform_upstream_failed",
    PLATFORM_NO_IMAGE: "platform_no_image",
    INTERNAL_ERROR: "internal_error",
};
