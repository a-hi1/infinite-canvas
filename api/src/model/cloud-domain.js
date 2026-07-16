export const JOB_SOURCE = {
    CLIENT_UPLOAD: "client_upload",
    SERVER_FETCH: "server_fetch",
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
};
