import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export const SEEDANCE_REFERENCE_LIMITS = {
    images: 9,
    videos: 3,
    audios: 3,
    imageMaxBytes: 30 * 1024 * 1024,
    videoMaxBytes: 50 * 1024 * 1024,
    audioMaxBytes: 15 * 1024 * 1024,
};

export const seedanceResolutionOptions = [
    { value: "480p", label: "480p" },
    { value: "720p", label: "720p" },
    { value: "1080p", label: "1080p" },
] as const;

export const seedanceRatioOptions = [
    { value: "16:9", label: "横屏" },
    { value: "9:16", label: "竖屏" },
    { value: "1:1", label: "方形" },
    { value: "4:3", label: "标准横屏" },
    { value: "3:4", label: "标准竖屏" },
    { value: "21:9", label: "宽银幕" },
    { value: "adaptive", label: "自适应" },
] as const;

export const seedanceDurationOptions = [-1, 4, 5, 6, 8, 10, 12, 15] as const;

const seedancePixels = {
    "480p": {
        "16:9": "864x496",
        "4:3": "752x560",
        "1:1": "640x640",
        "3:4": "560x752",
        "9:16": "496x864",
        "21:9": "992x432",
    },
    "720p": {
        "16:9": "1280x720",
        "4:3": "1112x834",
        "1:1": "960x960",
        "3:4": "834x1112",
        "9:16": "720x1280",
        "21:9": "1470x630",
    },
    "1080p": {
        "16:9": "1920x1080",
        "4:3": "1664x1248",
        "1:1": "1440x1440",
        "3:4": "1248x1664",
        "9:16": "1080x1920",
        "21:9": "2206x946",
    },
} as const;

export function isSeedanceVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return isSeedanceVideoModel(modelOptionName(requestConfig.model || requestConfig.videoModel)) || isArkPlanBaseUrl(requestConfig.baseUrl);
}

export function isSeedanceVideoModel(model: string) {
    const value = model.toLowerCase();
    return value.includes("seedance") || value.includes("doubao-seedance");
}

/**
 * openai2api 公开目录中的精确模型 `seedance2`：endpoint type = openai-video，
 * 创建路径应为 POST /v1/videos（不是旧 Comfy relay 的 /v1/video/generations）。
 * 其它 doubao-seedance-* 仍走 seedance 分组 / openai 兼容 relay。
 */
export function isSeedanceOpenAiVideoModel(model: string) {
    return modelOptionName(model).trim().toLowerCase() === "seedance2";
}

export function isSeedanceFastModel(model: string) {
    const value = model.toLowerCase();
    return isSeedanceVideoModel(value) && value.includes("fast");
}

/** Seedance 分辨率 + 比例 → OpenAI Video `size` 像素字符串（如 1280x720）。 */
export function seedancePixelSize(resolution: string, ratio: string) {
    const res = normalizeSeedanceResolution(resolution);
    const aspect = normalizeSeedanceRatio(ratio);
    const table = seedancePixels[res as keyof typeof seedancePixels];
    if (!table) return undefined;
    if (aspect === "adaptive") return table["16:9"];
    return table[aspect as keyof typeof table] || table["16:9"];
}

export function isArkPlanBaseUrl(baseUrl: string) {
    return baseUrl.toLowerCase().includes("ark.cn-beijing.volces.com/api/plan/v3") || baseUrl.toLowerCase().includes("/api/plan/v3");
}

export function normalizeSeedanceResolution(value: string, model = "") {
    const normalized = normalizeResolutionToken(value);
    if (isSeedanceFastModel(model) && normalized === "1080p") return "720p";
    return seedanceResolutionOptions.some((item) => item.value === normalized) ? normalized : "720p";
}

export function normalizeResolutionToken(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = String(value || "").replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

export function normalizeSeedanceDuration(value: string) {
    if (String(value).trim() === "-1") return -1;
    const seconds = Math.floor(Number(value) || 5);
    return Math.max(4, Math.min(15, seconds));
}

export function normalizeSeedanceRelayDuration(value: string) {
    const duration = normalizeSeedanceDuration(value);
    return duration === -1 ? 5 : duration;
}

export function normalizeSeedanceRatio(value: string) {
    if (!value || value === "auto" || value === "adaptive") return "adaptive";
    if (seedanceRatioOptions.some((item) => item.value === value)) return value;
    const match = value.match(/^(\d+)x(\d+)$/);
    if (!match) return "adaptive";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return "adaptive";
    const ratio = width / height;
    const options = [
        ["16:9", 16 / 9],
        ["4:3", 4 / 3],
        ["1:1", 1],
        ["3:4", 3 / 4],
        ["9:16", 9 / 16],
        ["21:9", 21 / 9],
    ] as const;
    return options.reduce((best, item) => (Math.abs(item[1] - ratio) < Math.abs(best[1] - ratio) ? item : best), options[0])[0];
}

export function seedancePixelLabel(resolution: string, ratio: string) {
    const normalizedResolution = normalizeSeedanceResolution(resolution) as keyof typeof seedancePixels;
    const normalizedRatio = normalizeSeedanceRatio(ratio) as keyof (typeof seedancePixels)[typeof normalizedResolution] | "adaptive";
    if (normalizedRatio === "adaptive") return "自动匹配";
    return seedancePixels[normalizedResolution][normalizedRatio] || "";
}

export function boolConfig(value: string | undefined, fallback: boolean) {
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
}

export function seedanceReferenceLabel(kind: "image" | "video" | "audio", index: number) {
    if (kind === "image") return `图片${index + 1}`;
    if (kind === "video") return `视频${index + 1}`;
    return `音频${index + 1}`;
}

/**
 * Workbench badge for Seedance OpenAI-compatible relays (openai2api / New API).
 * Comfy success contract: 2 images → first/last frame; 3+ → image + reference_images (not Agent Plan identity lock).
 */
export function seedanceRelayWorkbenchImageLabel(index: number, total: number) {
    if (total <= 1) return seedanceReferenceLabel("image", index);
    if (total === 2) {
        return index === 0 ? "图片1·首帧" : "图片2·尾帧";
    }
    if (index === 0) return "图片1·主参考";
    return `图片${index + 1}·补充`;
}

export function buildSeedancePromptText(prompt: string, images: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[]) {
    const labels = [
        ...images.map((_, index) => seedanceReferenceLabel("image", index)),
        ...videos.map((_, index) => seedanceReferenceLabel("video", index)),
        ...audios.map((_, index) => seedanceReferenceLabel("audio", index)),
    ];
    const text = prompt.trim();
    if (!labels.length) return text;
    return `参考素材编号：${labels.join("、")}。请按这些编号理解提示词中的图片、视频和音频引用。\n\n${text}`;
}

export function seedanceVideoReferenceError(videos: ReferenceVideo[]) {
    let totalDurationMs = 0;
    for (let index = 0; index < videos.length; index += 1) {
        const video = videos[index];
        const label = seedanceReferenceLabel("video", index);
        if (video.bytes && video.bytes > SEEDANCE_REFERENCE_LIMITS.videoMaxBytes) {
            const sizeMb = (video.bytes / (1024 * 1024)).toFixed(1);
            return `${label} 超过 50MB（当前约 ${sizeMb}MB），请压缩后再上传`;
        }
        if (video.durationMs) {
            if (video.durationMs < 2000 || video.durationMs > 15000) {
                const seconds = (video.durationMs / 1000).toFixed(1);
                return `${label} 时长需要在 2-15 秒之间（当前约 ${seconds}s）`;
            }
            totalDurationMs += video.durationMs;
        }
        // Seedance 参考视频约束是单边宽高 + 宽高比，不是输出档位像素总量。
        // 旧逻辑用 640x640～2206x946 输出表做像素总量拦截，会误杀常见 720x480 / 2K / 4K 素材。
        if (video.width && video.height) {
            const sizeLabel = `${video.width}x${video.height}`;
            if (video.width < 300 || video.width > 6000 || video.height < 300 || video.height > 6000) {
                return `${label} 宽高需要在 300-6000px 之间（当前 ${sizeLabel}）`;
            }
            const ratio = video.width / video.height;
            if (ratio < 0.4 || ratio > 2.5) {
                return `${label} 宽高比需要在 0.4-2.5 之间（当前 ${sizeLabel}，约 ${ratio.toFixed(2)}）`;
            }
        }
    }
    if (totalDurationMs > 15000) {
        const seconds = (totalDurationMs / 1000).toFixed(1);
        return `Seedance 参考视频总时长不能超过 15 秒（当前约 ${seconds}s）`;
    }
    return "";
}

export const seedanceVideoReferenceHint = "参考视频需为 mp4/mov，H.264/H.265，FPS 24-60；含真人人脸素材请使用火山授权 asset:// 素材。";
