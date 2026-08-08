/**
 * 远程媒体域名白名单（浏览器侧）。
 * 与 api `isAllowedMediaHost` 保持同步：上云 from-url / 同源 media 代理只放行这些公网 CDN。
 * 私网/环回仍由调用方与服务端 DNS 校验拒绝。
 */

const EXACT_HOSTS = new Set([
    "imgen.x.ai",
    "vidgen.x.ai",
    "cdn.x.ai",
    "x.ai",
    "platform-outputs.agnes-ai.space",
    "apihub.agnes-ai.com",
]);

/** 后缀匹配（host.endsWith） */
const HOST_SUFFIXES = [
    ".imgen.x.ai",
    ".vidgen.x.ai",
    ".cdn.x.ai",
    ".x.ai",
    ".amazonaws.com",
    ".cloudfront.net",
    ".r2.dev",
    // Seedance / 火山方舟 / 字节临时媒体
    ".volces.com",
    ".volcengine.com",
    ".volcengineapi.com",
    ".byteimg.com",
    ".bytedance.net",
    ".bytecdn.com",
    // 常见对象存储 / CDN
    ".aliyuncs.com",
    ".myqcloud.com",
    ".googleusercontent.com",
    ".blob.core.windows.net",
    ".agnes-ai.space",
    ".agnes-ai.com",
] as const;

/** 浏览器 JS fetch 常被 CORS 拦、但 <video>/<img> 仍可能能播的主机 */
const CORS_BLOCKED_SUFFIXES = [
    ".vidgen.x.ai",
    ".imgen.x.ai",
    ".cdn.x.ai",
    ".volces.com",
    ".volcengine.com",
    ".volcengineapi.com",
    ".byteimg.com",
    ".bytedance.net",
    ".bytecdn.com",
] as const;

const CORS_BLOCKED_EXACT = new Set(["vidgen.x.ai", "imgen.x.ai", "cdn.x.ai"]);

function normalizeHost(hostname: string) {
    return String(hostname || "")
        .toLowerCase()
        .replace(/\.$/, "");
}

export function hostnameFromMediaUrl(url: string): string {
    try {
        return normalizeHost(new URL(url).hostname);
    } catch {
        return "";
    }
}

/** 是否允许走云端 from-url / 同源 media 代理（与 api 白名单对齐） */
export function isAllowedRemoteMediaHost(hostnameOrUrl: string): boolean {
    const host = hostnameOrUrl.includes("://") ? hostnameFromMediaUrl(hostnameOrUrl) : normalizeHost(hostnameOrUrl);
    if (!host) return false;
    if (EXACT_HOSTS.has(host)) return true;
    return HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * 已知常拦 CORS 的媒体 CDN：落盘时应优先 /ai-proxy/media，不要只靠浏览器直 fetch。
 * 比「允许上云」名单更窄，避免对本可直连的 CDN 无谓绕代理。
 */
export function isLikelyCorsBlockedMediaHost(url: string): boolean {
    const host = hostnameFromMediaUrl(url);
    if (!host) {
        return /vidgen\.x\.ai|imgen\.x\.ai|cdn\.x\.ai|volces\.com|volcengine|byteimg\.com|bytecdn\.com/i.test(url || "");
    }
    if (CORS_BLOCKED_EXACT.has(host)) return true;
    return CORS_BLOCKED_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}
