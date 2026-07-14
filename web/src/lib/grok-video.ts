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

export function normalizeGrokDuration(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return Math.max(1, Math.min(10, seconds));
}

export function normalizeGrokResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "high") return "1080p";
    if (value === "auto" || value === "medium") return "720p";
    const resolution = String(value || "720").replace(/p$/i, "") || "720";
    return `${resolution}p`;
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

export const grokVideoModeHint = "Grok 参考图生视频：请上传本地小图（优先 jpg/png）。单图走 image，多图走 reference_images；会优先尝试 grok-imagine-video-1.5。中转站若只支持创建不支持查询，需 POST 响应直接返回 video.url，或补齐 GET /v1/videos/{request_id}。";
