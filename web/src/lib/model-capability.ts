/**
 * 工作台 / 画布参数面板用的「真实可选能力」注册表。
 * 只汇总现有 normalize / 请求路径已支持的选项，禁止发明虚假档位。
 */
import { AGNES_VIDEO_SIZE, agnesDurationOptions, isAgnesVideoConfig } from "@/lib/agnes-video";
import { isGrokVideoConfig, normalizeGrokAspectRatio, normalizeGrokDuration, normalizeGrokResolution } from "@/lib/grok-video";
import {
    isSora2ProModel,
    isSoraOrVeoVideoConfig,
    isSoraVideoConfig,
    isVeoVideoConfig,
    normalizeSoraSeconds,
    normalizeSoraSize,
    normalizeVeoSeconds,
    normalizeVeoSize,
    soraSizeOptionsForModel,
    SORA_SECONDS_OPTIONS,
    VEO_SECONDS_OPTIONS,
    VEO_SIZE_OPTIONS,
    soraVeoReferenceImageLimit,
} from "@/lib/openai-compatible-video";
import {
    isSeedanceFastModel,
    isSeedanceVideoConfig,
    normalizeSeedanceDuration,
    normalizeSeedanceRatio,
    normalizeSeedanceResolution,
    seedanceDurationOptions,
    seedanceRatioOptions,
    seedanceResolutionOptions,
} from "@/lib/seedance-video";
import { BYOK_IMAGE_REFERENCE_LIMIT } from "@/lib/image-reference-limits";
import {
    getImageCompatStrategy,
    modelOptionName,
    resolveModelChannel,
    resolveModelRequestConfig,
    resolveModelScript,
    type AiConfig,
} from "@/stores/use-config-store";

export type SpecField = { label: string; value: string };

export type ModelSpecCardData = {
    title: string;
    fields: SpecField[];
    note?: string;
};

export type PillOption = {
    value: string;
    label: string;
    /** 可选副标题，如像素 */
    hint?: string;
    disabled?: boolean;
    disabledReason?: string;
};

export type VideoCapabilityProfile = {
    provider: "grok" | "seedance" | "agnes" | "sora" | "veo" | "generic";
    modelLabel: string;
    ratios: PillOption[];
    seconds: PillOption[];
    resolutions: PillOption[];
    /** 是否允许自由输入秒数（仅 Grok/Seedance 区间内） */
    customSeconds?: { min: number; max: number };
    /** 是否展示自定义清晰度输入 */
    customResolution?: boolean;
    /** 是否展示自定义像素宽高 */
    customSize?: boolean;
    sizePresets?: PillOption[];
    audio?: boolean;
    watermark?: boolean;
    normalize: {
        size: (value: string) => string;
        seconds: (value: string) => string;
        resolution: (value: string) => string;
    };
    card: ModelSpecCardData;
};

export type ImageCapabilityProfile = {
    provider: "grok" | "gemini" | "openai" | "script" | "generic";
    modelLabel: string;
    qualities: PillOption[];
    aspects: PillOption[];
    /** 是否支持透明背景（仅 OpenAI 兼容路径转发） */
    transparentBackground: boolean;
    /** 是否展示自定义像素宽高 */
    customSize: boolean;
    maxCount: number;
    card: ModelSpecCardData;
};

const GROK_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const GROK_VIDEO_SECONDS = [4, 6, 8, 10, 12, 15] as const;
const GROK_VIDEO_RESOLUTIONS = ["480", "720", "1080"] as const;

const GROK_IMAGE_ASPECTS = [
    { value: "1:1", label: "1:1" },
    { value: "16:9", label: "16:9" },
    { value: "9:16", label: "9:16" },
    { value: "4:3", label: "4:3" },
    { value: "3:4", label: "3:4" },
    { value: "3:2", label: "3:2" },
    { value: "2:3", label: "2:3" },
    { value: "auto", label: "跟随 / auto" },
] as const;

const OPENAI_IMAGE_ASPECTS = [
    { value: "1:1", label: "1:1", width: 1024, height: 1024 },
    { value: "3:2", label: "3:2", width: 1536, height: 1024 },
    { value: "2:3", label: "2:3", width: 1024, height: 1536 },
    { value: "4:3", label: "4:3", width: 1360, height: 1024 },
    { value: "3:4", label: "3:4", width: 1024, height: 1360 },
    { value: "16:9", label: "16:9", width: 1824, height: 1024 },
    { value: "9:16", label: "9:16", width: 1024, height: 1824 },
    { value: "1:1-2k", label: "1:1(2k)", size: "2048x2048", width: 2048, height: 2048 },
    { value: "16:9-2k", label: "16:9(2k)", size: "2048x1152", width: 2048, height: 1152 },
    { value: "9:16-2k", label: "9:16(2k)", size: "1152x2048", width: 1152, height: 2048 },
    { value: "16:9-4k", label: "16:9(4k)", size: "3840x2160", width: 3840, height: 2160 },
    { value: "9:16-4k", label: "9:16(4k)", size: "2160x3840", width: 2160, height: 3840 },
    { value: "auto", label: "auto", width: 0, height: 0 },
] as const;

const OPENAI_IMAGE_QUALITIES = [
    { value: "auto", label: "自动" },
    { value: "high", label: "高" },
    { value: "medium", label: "中" },
    { value: "low", label: "低" },
] as const;

const GEMINI_IMAGE_ASPECTS = [
    { value: "1:1", label: "1:1" },
    { value: "16:9", label: "16:9" },
    { value: "9:16", label: "9:16" },
    { value: "4:3", label: "4:3" },
    { value: "3:4", label: "3:4" },
    { value: "3:2", label: "3:2" },
    { value: "2:3", label: "2:3" },
    { value: "21:9", label: "21:9" },
    { value: "auto", label: "auto" },
] as const;

function modelLabelOf(config: AiConfig) {
    return modelOptionName(config.model || config.videoModel || config.imageModel || "") || "未选模型";
}

function isGrokImageModelName(model: string) {
    const n = modelOptionName(model).toLowerCase();
    if (n.includes("video")) return false;
    return (n.includes("grok") && (n.includes("imagine") || n.includes("image"))) || n.includes("imagine-image");
}

function isGeminiImageConfig(config: AiConfig) {
    const channel = resolveModelChannel(config, config.model || config.imageModel || "");
    return channel.apiFormat === "gemini";
}

export function resolveVideoCapability(config: AiConfig): VideoCapabilityProfile {
    const modelName = modelOptionName(config.model || config.videoModel || "");
    const label = modelLabelOf(config);

    if (isAgnesVideoConfig(config)) {
        return {
            provider: "agnes",
            modelLabel: label,
            ratios: [{ value: AGNES_VIDEO_SIZE, label: "Agnes 横屏", hint: AGNES_VIDEO_SIZE }],
            seconds: agnesDurationOptions.map((value) => ({ value: String(value), label: `${value}s` })),
            resolutions: [],
            normalize: {
                size: () => AGNES_VIDEO_SIZE,
                seconds: (value) => String(value === "5" ? 5 : 2),
                resolution: (value) => value || "720",
            },
            card: {
                title: label,
                fields: [
                    { label: "工作模式", value: "仅文生视频（T2V）" },
                    { label: "输入规格", value: "纯文本提示词；不支持参考图 / 视频 / 音频" },
                    { label: "输出规格", value: `固定 ${AGNES_VIDEO_SIZE} · 可选 ${agnesDurationOptions.join("s / ")}s · 24fps` },
                    { label: "返回格式", value: "任务创建 + 轮询取视频 URL" },
                    { label: "不支持", value: "图生视频、参考素材、自定义比例/清晰度" },
                ],
            },
        };
    }

    if (isSeedanceVideoConfig(config)) {
        const fast = isSeedanceFastModel(modelName);
        return {
            provider: "seedance",
            modelLabel: label,
            ratios: seedanceRatioOptions.map((item) => ({
                value: item.value,
                label: item.value === "adaptive" ? "跟随原图" : item.label,
                hint: item.value === "adaptive" ? "adaptive" : item.value,
            })),
            seconds: seedanceDurationOptions.map((value) => ({
                value: String(value),
                label: value === -1 ? "智能" : `${value}s`,
            })),
            resolutions: seedanceResolutionOptions.map((item) => ({
                value: item.value,
                label: item.label,
                disabled: fast && item.value === "1080p",
                disabledReason: "fast 模型不支持 1080p，会自动用 720p",
            })),
            customSeconds: { min: -1, max: 15 },
            audio: true,
            watermark: true,
            normalize: {
                size: (value) => normalizeSeedanceRatio(value),
                seconds: (value) => String(normalizeSeedanceDuration(value)),
                resolution: (value) => normalizeSeedanceResolution(value, modelName),
            },
            card: {
                title: label,
                fields: [
                    { label: "工作模式", value: "文生 / 多模态参考（图≤9 · 视频≤3 · 音频≤3）" },
                    { label: "输入规格", value: "提示词 + 可选图/视频/音频；参考视频 2–15s、单条≤50MB" },
                    {
                        label: "输出规格",
                        value: fast
                            ? "分辨率 480p/720p（fast 无 1080p）· 时长 4–15s 或智能 · 可选声音/水印"
                            : "分辨率 480p/720p/1080p · 时长 4–15s 或智能 · 可选声音/水印",
                    },
                    { label: "返回格式", value: "火山/Seedance Agent Plan 任务轮询" },
                    { label: "不支持", value: fast ? "fast 模型 1080p；超限参考素材" : "超限参考素材、非 Seedance 路径字段" },
                ],
            },
        };
    }

    if (isGrokVideoConfig(config)) {
        return {
            provider: "grok",
            modelLabel: label,
            ratios: GROK_VIDEO_RATIOS.map((value) => ({ value, label: value })),
            seconds: GROK_VIDEO_SECONDS.map((value) => ({ value: String(value), label: `${value}s` })),
            resolutions: GROK_VIDEO_RESOLUTIONS.map((value) => ({ value, label: `${value}p` })),
            customSeconds: { min: 1, max: 15 },
            normalize: {
                size: (value) => normalizeGrokAspectRatio(value),
                seconds: (value) => String(normalizeGrokDuration(value)),
                resolution: (value) => normalizeGrokResolution(value).replace(/p$/i, ""),
            },
            card: {
                title: label,
                fields: [
                    { label: "工作模式", value: "文生 · 多图 generation · 单视频 edits" },
                    { label: "输入规格", value: "参考图 ≤7 张 · 参考视频 1 条（1–15s / 建议≤40MB）" },
                    { label: "输出规格", value: "比例 5 种 · 480/720/1080p · 1–15s" },
                    { label: "返回格式", value: "异步任务 + 轮询" },
                    { label: "不支持", value: "图+视频混用 · 多条参考视频" },
                ],
                note: "规格原样进首个请求；失败才降档。结果偏低会提示，不虚标。",
            },
        };
    }

    if (isSoraOrVeoVideoConfig(config)) {
        const sora = isSoraVideoConfig(config);
        const sizeOptions = sora ? soraSizeOptionsForModel(modelName) : VEO_SIZE_OPTIONS;
        const secondOptions = sora ? SORA_SECONDS_OPTIONS : VEO_SECONDS_OPTIONS;
        const refLimit = soraVeoReferenceImageLimit(modelName);
        return {
            provider: sora ? "sora" : "veo",
            modelLabel: label,
            ratios: sizeOptions.map((item) => ({
                value: item.value,
                label: item.label,
                hint: item.value,
            })),
            seconds: secondOptions.map((value) => ({ value: String(value), label: `${value}s` })),
            resolutions: [],
            normalize: {
                size: (value) => (sora ? normalizeSoraSize(value, modelName) : normalizeVeoSize(value)),
                seconds: (value) => (sora ? normalizeSoraSeconds(value) : normalizeVeoSeconds(value)),
                resolution: (value) => value || "720",
            },
            card: {
                title: label,
                fields: [
                    {
                        label: "工作模式",
                        value: sora ? "文生 · 1 张首帧图生" : `文生 · 图生最多 ${refLimit} 张`,
                    },
                    {
                        label: "输入规格",
                        value: sora ? "本地可读首帧 1 张" : `本地可读参考图 ≤${refLimit} 张`,
                    },
                    {
                        label: "输出规格",
                        value: sora
                            ? isSora2ProModel(modelName)
                                ? "4/8/12s · 720p 横竖 + 高清尺寸"
                                : "4/8/12s · 仅 1280×720 / 720×1280"
                            : "4/6/8s · 横/竖/方",
                    },
                    { label: "返回格式", value: "异步任务 + 轮询" },
                    {
                        label: "不支持",
                        value: sora ? "多参考图 · 参考视频/音频" : "参考视频/音频 · 远程不可读图",
                    },
                ],
                note: sora ? "部分中转只认 azure-sora，会自动回退。" : "优先本地可读参考图。",
            },
        };
    }

    // 通用 OpenAI 兼容视频
    return {
        provider: "generic",
        modelLabel: label,
        ratios: [
            { value: "1280x720", label: "横屏", hint: "1280x720" },
            { value: "720x1280", label: "竖屏", hint: "720x1280" },
            { value: "1024x1024", label: "方形", hint: "1024x1024" },
            { value: "1792x1024", label: "宽屏", hint: "1792x1024" },
            { value: "1024x1792", label: "长图", hint: "1024x1792" },
            { value: "auto", label: "auto" },
        ],
        seconds: [6, 10, 12, 16, 20].map((value) => ({ value: String(value), label: `${value}s` })),
        resolutions: [
            { value: "720", label: "720p" },
            { value: "480", label: "480p" },
        ],
        customSeconds: { min: 1, max: 20 },
        customResolution: true,
        customSize: true,
        normalize: {
            size: (value) => {
                if (value === "auto") return "auto";
                if (/^\d+x\d+$/.test(value || "")) return value;
                return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
            },
            seconds: (value) => {
                const n = Math.floor(Number(value) || 6);
                return String(Math.max(1, Math.min(20, n)));
            },
            resolution: (value) => {
                if (value === "480p" || value === "low") return "480";
                if (value === "720p" || value === "auto" || value === "high" || value === "medium") return "720";
                return String(value || "720").replace(/p$/i, "") || "720";
            },
        },
        card: {
            title: label || "通用视频模型",
            fields: [
                { label: "工作模式", value: "OpenAI 兼容文生视频（渠道实现差异大）" },
                { label: "输入规格", value: "提示词；参考图/视频是否可用取决于上游" },
                { label: "输出规格", value: "常见 480p/720p · 像素尺寸预设 · 秒数约 1–20s" },
                { label: "返回格式", value: "OpenAI Videos 风格创建 + 轮询" },
                { label: "不支持", value: "不保证 Grok/Seedance/Sora 专有字段；请优先选已适配模型" },
            ],
        },
    };
}

export function resolveImageCapability(config: AiConfig, options?: { maxCount?: number }): ImageCapabilityProfile {
    const model = config.model || config.imageModel || "";
    const label = modelOptionName(model) || "未选模型";
    const maxCount = options?.maxCount ?? 10;
    const requestConfig = resolveModelRequestConfig(config, model);
    const channel = resolveModelChannel(config, model);
    const script = resolveModelScript(config, model);
    const strategy = getImageCompatStrategy(channel.baseUrl, channel.compatProfile);

    if (script) {
        return {
            provider: "script",
            modelLabel: label,
            qualities: [...OPENAI_IMAGE_QUALITIES],
            aspects: OPENAI_IMAGE_ASPECTS.map((item) => ({
                value: "size" in item && item.size ? item.size : item.value,
                label: item.label,
            })),
            transparentBackground: true,
            customSize: true,
            maxCount,
            card: {
                title: label,
                fields: [
                    { label: "工作模式", value: "自定义调用脚本（完全以脚本为准）" },
                    { label: "输入规格", value: `提示词 + 参考图最多 ${BYOK_IMAGE_REFERENCE_LIMIT} 张（脚本自行消费）` },
                    { label: "输出规格", value: "由脚本返回的图片列表决定" },
                    { label: "返回格式", value: "脚本 runModelPlugin 约定" },
                    { label: "不支持", value: "系统默认 Grok/OpenAI/Gemini 路径字段可能被脚本忽略" },
                ],
                note: "下方质量/比例仍会写入 config，是否生效取决于脚本是否读取 params。",
            },
        };
    }

    if (isGeminiImageConfig(config)) {
        return {
            provider: "gemini",
            modelLabel: label,
            qualities: [
                { value: "low", label: "1K" },
                { value: "medium", label: "2K" },
                { value: "high", label: "4K" },
                { value: "auto", label: "自动" },
            ],
            aspects: GEMINI_IMAGE_ASPECTS.map((item) => ({ value: item.value, label: item.label })),
            transparentBackground: false,
            customSize: true,
            maxCount,
            card: {
                title: label,
                fields: [
                    { label: "工作模式", value: "Gemini 文生图 / 图生图（参考图，无蒙版）" },
                    { label: "输入规格", value: "提示词 + 可选参考图；比例映射到 Gemini aspectRatio" },
                    { label: "输出规格", value: "质量档约 1K/2K/4K；支持 1:1、16:9、9:16、21:9 等" },
                    { label: "返回格式", value: "Gemini generateContent 图片 part" },
                    { label: "不支持", value: "background=transparent、OpenAI size 像素直传语义" },
                ],
            },
        };
    }

    if (isGrokImageModelName(model) || strategy.sizeMode === "grok-aspect") {
        return {
            provider: "grok",
            modelLabel: label,
            qualities: [
                { value: "auto", label: "1K / 自动" },
                { value: "low", label: "1K" },
                { value: "medium", label: "1K+" },
                { value: "high", label: "2K" },
            ],
            aspects: GROK_IMAGE_ASPECTS.map((item) => ({ value: item.value, label: item.label })),
            transparentBackground: false,
            customSize: false,
            maxCount,
            card: {
                title: label,
                fields: [
                    { label: "工作模式", value: "文生 / 图生 / 多参考编辑（与文生共用模型名，靠是否带图区分）" },
                    {
                        label: "输入规格",
                        value: `提示词；参考图最多 ${BYOK_IMAGE_REFERENCE_LIMIT} 张（Grok JSON images，禁止静默只发第一张）`,
                    },
                    {
                        label: "输出规格",
                        value: "比例 1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3 · 分辨率约 1k/2k",
                    },
                    { label: "返回格式", value: "OpenAI 兼容 /images/generations 或 Grok JSON /images/edits" },
                    {
                        label: "不支持",
                        value: "透明背景字段；官方无 *-edit 模型名（中转别名仅列表存在时可选）",
                    },
                ],
                note: "高质量档映射为 2k；2k/4k 尺寸选项也会强制 2k 分辨率请求。",
            },
        };
    }

    const includeQuality = strategy.includeQuality !== false;
    const includeBackground = strategy.includeBackground !== false;
    return {
        provider: "openai",
        modelLabel: label || "OpenAI 兼容生图",
        qualities: includeQuality
            ? [...OPENAI_IMAGE_QUALITIES]
            : [{ value: "auto", label: "自动（上游可能忽略）" }],
        aspects: OPENAI_IMAGE_ASPECTS.map((item) => ({
            value: "size" in item && item.size ? item.size : item.value,
            label: item.label,
        })),
        transparentBackground: includeBackground,
        customSize: true,
        maxCount,
        card: {
            title: label || "OpenAI 兼容生图",
            fields: [
                { label: "工作模式", value: "文生 /images/generations · 图生 /images/edits（multipart）" },
                {
                    label: "输入规格",
                    value: `提示词；参考图最多 ${BYOK_IMAGE_REFERENCE_LIMIT} 张；可选蒙版；尺寸 auto / 比例 / 像素`,
                },
                {
                    label: "输出规格",
                    value: includeQuality
                        ? "质量 auto/高/中/低 · 常见 1K–4K 档像素 · 可选透明背景"
                        : "尺寸字段按渠道兼容预设发送；质量可能被省略",
                },
                { label: "返回格式", value: "b64_json 或 URL（远程 URL 可能受 CORS 影响落盘）" },
                {
                    label: "不支持",
                    value: strategy.profile === "relay-fragile"
                        ? "部分脆弱中转不支持 edits/多参考；失败会可读降级为文生图"
                        : "依赖上游是否支持 quality / background / edits",
                },
            ],
            note: `当前渠道：${channel.name || channel.baseUrl || "未命名"} · Base ${requestConfig.baseUrl || channel.baseUrl || "—"}`,
        },
    };
}

/** 把当前 config 夹到该模型真实可选范围（切换模型后调用，避免假选项残留）。 */
export function clampVideoConfigToCapability(config: AiConfig): Partial<Pick<AiConfig, "size" | "videoSeconds" | "vquality" | "videoGenerateAudio" | "videoWatermark">> {
    const cap = resolveVideoCapability(config);
    const next: Partial<Pick<AiConfig, "size" | "videoSeconds" | "vquality" | "videoGenerateAudio" | "videoWatermark">> = {
        size: cap.normalize.size(config.size || ""),
        videoSeconds: cap.normalize.seconds(config.videoSeconds || ""),
        vquality: cap.normalize.resolution(config.vquality || ""),
    };
    if (cap.provider === "agnes") {
        next.videoGenerateAudio = "false";
        next.videoWatermark = "false";
    }
    return next;
}

export function clampImageConfigToCapability(config: AiConfig): Partial<Pick<AiConfig, "quality" | "size" | "background" | "count">> {
    const cap = resolveImageCapability(config);
    const qualityValues = new Set(cap.qualities.map((item) => item.value));
    const quality = qualityValues.has(config.quality || "") ? config.quality : cap.qualities[0]?.value || "auto";

    const aspectValues = new Set(cap.aspects.map((item) => item.value));
    let size = config.size || "auto";
    if (!aspectValues.has(size) && !/^\d+x\d+$/.test(size)) {
        // 尝试用比例前缀匹配（如 16:9-2k → 16:9）
        const ratioPrefix = size.includes(":") ? size.split("-")[0] : "";
        const matched = cap.aspects.find((item) => item.value === ratioPrefix || item.value.startsWith(`${ratioPrefix}`));
        size = matched?.value || cap.aspects[0]?.value || "auto";
    }

    const count = Math.max(1, Math.min(cap.maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const background = cap.transparentBackground && config.background === "transparent" ? "transparent" : "";

    return { quality, size, count: String(count), background };
}
