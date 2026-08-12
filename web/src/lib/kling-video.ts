import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

/** Kling / 可灵（openai2api / New API 统一任务口）支持的时长。 */
export const KLING_VIDEO_SECONDS = [5, 10] as const;

/** 面板展示的像素尺寸 → 上游 aspect_ratio。 */
export const KLING_VIDEO_SIZE_OPTIONS = [
    { value: "1280x720", label: "横屏 16:9", aspectRatio: "16:9" },
    { value: "720x1280", label: "竖屏 9:16", aspectRatio: "9:16" },
    { value: "1024x1024", label: "方形 1:1", aspectRatio: "1:1" },
] as const;

export const KLING_VIDEO_MODES = [
    { value: "std", label: "标准 std" },
    { value: "pro", label: "高品质 pro" },
] as const;

/** 图生：首帧 + 可选尾帧（image_tail）。 */
export const KLING_REFERENCE_LIMITS = {
    images: 2,
} as const;

export function isKlingVideoModel(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return value.includes("kling");
}

export function isKlingVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return isKlingVideoModel(modelOptionName(requestConfig.model || requestConfig.videoModel));
}

/** 空 → 5；显式秒数夹到 5 或 10（可灵常见档）。 */
export function normalizeKlingDuration(value: string | number | undefined | null) {
    const raw = String(value ?? "").trim();
    const n = raw === "" || !Number.isFinite(Number(raw)) ? 5 : Math.floor(Number(raw));
    if (n <= 5) return 5;
    return 10;
}

export function normalizeKlingMode(value: string | undefined | null) {
    const raw = String(value || "").toLowerCase().trim();
    if (raw === "pro" || raw === "high" || raw === "1080" || raw === "1080p") return "pro";
    return "std";
}

/** 从 vquality / 清晰度档映射 mode（std/pro）。 */
export function klingModeFromQuality(vquality: string | undefined | null) {
    const raw = String(vquality || "").toLowerCase().trim();
    if (raw === "high" || raw === "1080" || raw === "1080p" || raw === "pro") return "pro";
    return "std";
}

export function normalizeKlingSize(value: string | undefined | null) {
    const raw = String(value || "").trim();
    if (/^\d+x\d+$/i.test(raw)) {
        const [w, h] = raw.toLowerCase().split("x").map((part) => Number(part));
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            if (Math.abs(w / h - 1) < 0.08) return "1024x1024";
            if (w > h) return "1280x720";
            return "720x1280";
        }
    }
    if (raw === "16:9" || raw === "landscape") return "1280x720";
    if (raw === "9:16" || raw === "portrait" || raw === "2:3" || raw === "3:4") return "720x1280";
    if (raw === "1:1" || raw === "square") return "1024x1024";
    return "1280x720";
}

export function klingAspectRatioFromSize(size: string | undefined | null) {
    const normalized = normalizeKlingSize(size);
    if (normalized === "720x1280") return "9:16";
    if (normalized === "1024x1024") return "1:1";
    return "16:9";
}

export function klingPixelSize(size: string | undefined | null) {
    return normalizeKlingSize(size);
}
