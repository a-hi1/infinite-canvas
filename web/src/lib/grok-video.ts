import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

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

/** Official xAI range is 1–15s; relays often work best at 5–10. */
export function normalizeGrokDuration(value: string) {
    const seconds = Math.floor(Number(value) || 8);
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

export const grokVideoModeHint =
    "Grok 视频（含 codex2api）：文生用 grok-imagine-video；图生优先本地小图 jpg/png + grok-imagine-video-1.5。时长 1–15 秒（官方上限 15；中转常 5–10 更稳）。分辨率建议 720p（1080p 中转易 400）。中转若只支持创建不支持查询，需 POST 直接返回 video.url，或补齐 GET /v1/videos/{request_id}。";
