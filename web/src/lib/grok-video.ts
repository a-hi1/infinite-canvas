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
    "Grok 视频：文生/图生/多参考图都走 generation——公网 codex2api: /videos/generations；内网 New API: 优先 /video/generations（避免 OpenAI /videos 的 invalid api platform）。不走 /videos/edits。多图压小本地参考图且不静默只发第一张。时长 1–15 秒，分辨率建议 720p。";
