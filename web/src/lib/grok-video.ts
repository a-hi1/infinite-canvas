import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceVideo } from "@/types/media";

export function isGrokVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return isGrokVideoModel(modelOptionName(requestConfig.model || requestConfig.videoModel)) || isXaiBaseUrl(requestConfig.baseUrl);
}

export function isGrokVideoModel(model: string) {
    const value = model.toLowerCase();
    return value.includes("grok") && (value.includes("video") || value.includes("imagine"));
}

export function isXaiBaseUrl(baseUrl: string) {
    return baseUrl.toLowerCase().includes("api.x.ai");
}

/** Official xAI range is 1–15s; relays often work best at 5–10. Empty → 8 as soft default only. */
export function normalizeGrokDuration(value: string) {
    const raw = String(value ?? "").trim();
    // 空值才用 8；用户显式选 4/6/10… 必须原样保留（再夹到 1–15）
    const seconds = raw === "" || !Number.isFinite(Number(raw)) ? 8 : Math.floor(Number(raw));
    return Math.max(1, Math.min(15, seconds));
}

export function normalizeGrokResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "high") return "1080p";
    if (value === "auto" || value === "medium") return "720p";
    const raw = String(value || "720").replace(/p$/i, "") || "720";
    if (raw === "480" || raw === "720" || raw === "1080") return `${raw}p`;
    // Unknown UI values (e.g. leftover Seedance "high") → safe default for relays
    return "720p";
}

/** codex2api and similar OpenAI-compatible relays that proxy xAI video. */
export function isCodex2apiBaseUrl(baseUrl: string) {
    const value = baseUrl.toLowerCase();
    return value.includes("codex2api.com") || value.includes("codex2api");
}

export function normalizeGrokAspectRatio(value: string) {
    if (!value || value === "auto" || value === "adaptive") return "16:9";
    if (["16:9", "9:16", "1:1", "4:3", "3:4"].includes(value)) return value;
    const match = value.match(/^(\d+)x(\d+)$/);
    if (!match) return "16:9";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return "16:9";
    const ratio = width / height;
    const options = [
        ["16:9", 16 / 9],
        ["9:16", 9 / 16],
        ["1:1", 1],
        ["4:3", 4 / 3],
        ["3:4", 3 / 4],
    ] as const;
    return options.reduce((best, item) => (Math.abs(item[1] - ratio) < Math.abs(best[1] - ratio) ? item : best), options[0])[0];
}

/** Single-reference video edit via mid-relay POST /videos/edits (not multi-image generation). */
export const GROK_EDIT_REFERENCE_LIMITS = {
    videos: 1,
    /**
     * Upload/source hard cap. codex2api 实测 multipart → 415，本地文件走 JSON data URI（体积再膨胀约 33%）。
     * 建议源文件 ≤40MB 更稳；100MB 是应用硬顶，超大 JSON 仍可能被中转/代理拒绝。
     */
    videoMaxBytes: 100 * 1024 * 1024,
    /**
     * Soft hint for non-codex relays that still allow multipart fallback.
     * codex2api / xAI edits 会允许更大的 data URI（见 video.ts allowLargeDataUrl）。
     */
    jsonDataUrlMaxBytes: 12 * 1024 * 1024,
    minDurationMs: 1000,
    maxDurationMs: 15_000,
} as const;

function formatMb(bytes: number) {
    return Math.max(1, Math.round(bytes / 1024 / 1024));
}

/** Returns a Chinese error string, or "" when the single video ref is acceptable for Grok edits. */
export function grokEditVideoReferenceError(videos: ReferenceVideo[]) {
    if (!videos.length) return "Grok 视频编辑需要上传 1 条参考视频";
    if (videos.length > GROK_EDIT_REFERENCE_LIMITS.videos) {
        return `Grok 视频编辑当前只支持 ${GROK_EDIT_REFERENCE_LIMITS.videos} 条参考视频，已选择 ${videos.length} 条，请删减后重试`;
    }
    const video = videos[0];
    const label = video.name || "参考视频";
    if (video.bytes && video.bytes > GROK_EDIT_REFERENCE_LIMITS.videoMaxBytes) {
        return `${label} 超过 ${formatMb(GROK_EDIT_REFERENCE_LIMITS.videoMaxBytes)}MB，请压缩或剪短后再上传`;
    }
    if (video.durationMs) {
        if (video.durationMs < GROK_EDIT_REFERENCE_LIMITS.minDurationMs) {
            return `${label} 太短，建议至少 1 秒`;
        }
        if (video.durationMs > GROK_EDIT_REFERENCE_LIMITS.maxDurationMs) {
            return `${label} 超过 15 秒，请剪短后再上传`;
        }
    }
    const type = String(video.type || "").toLowerCase();
    if (type && !type.startsWith("video/") && type !== "application/octet-stream") {
        return `${label} 不是视频文件，请上传 mp4`;
    }
    return "";
}

export const grokVideoModeHint =
    "Grok 视频：文生/图生/多参考图走 generation（codex2api: /videos/generations；内网 New API: 只走 /video/generations，不试不存在的 /videos/generations）。单条参考 MP4 + 提示词走 /videos/edits（JSON body：video/video_url data URI 或公网 URL；codex2api 不接受 multipart/415）。New API 常无 edits 路由。建议源文件 ≤40MB、约 1–15 秒，硬顶 100MB。不要图+视频混用。多图压小本地参考图且不静默只发第一张。参考图生视频在中转上优先 720p（1080p 常忽略参考图）；纯文生可用 1080p。";
