import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

export type ApiCallFormat = "openai" | "gemini";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

/**
 * 渠道生图/请求兼容预设。auto = 按 Base URL 推断（与历史硬编码行为一致）。
 * 换中转时优先改此项，避免再改代码。
 */
export type ChannelCompatProfile = "auto" | "openai" | "openai-slim" | "grok-image" | "relay-fragile";

export const CHANNEL_COMPAT_OPTIONS: Array<{ value: ChannelCompatProfile; label: string; hint: string }> = [
    { value: "auto", label: "自动（推荐）", hint: "按 Base URL 推断：/lan-ai→Grok 比例；openai2api/codex2api→精简中转；其它→标准 OpenAI" },
    { value: "openai", label: "标准 OpenAI", hint: "size / quality / background / output_format 完整字段" },
    { value: "openai-slim", label: "OpenAI 精简", hint: "少带 output_format 等扩展字段，适合挑剔中转" },
    { value: "grok-image", label: "Grok / Grok2API 生图", hint: "文生图 aspect_ratio+resolution；图生图 JSON /images/edits（非 multipart）" },
    { value: "relay-fragile", label: "脆弱中转（如 openai2api）", hint: "精简字段；图生图 edits 失败可旁路/降级" },
];

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    /** 缺省 / auto：与改预设前行为一致 */
    compatProfile?: ChannelCompatProfile;
    models: string[];
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    systemPrompt: string;
    /** Text Responses API reasoning effort; "auto" means omit the field. */
    reasoningEffort: ReasoningEffort;
    models: string[];
    imageModels: string[];
    videoModels: string[];
    textModels: string[];
    audioModels: string[];
    /**
     * Optional per-model call scripts keyed by `channelId::model` (or bare model name).
     * Empty / missing = system default request path. Kept as a side map so channel.models
     * can stay string[] without an upstream ChannelModel object migration.
     */
    modelScripts: Record<string, string>;
    quality: string;
    size: string;
    /** OpenAI-compatible image background; only "transparent" is forwarded upstream. */
    background: string;
    count: string;
    canvasImageCount: string;
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
export type ModelCapability = "image" | "video" | "text" | "audio";
const CHANNEL_MODEL_SEPARATOR = "::";
export const AI_PROXY_BASE_URL = "/ai-proxy";
/** Same-origin LAN OpenAI-compatible relay (nginx/vite → private IP). Avoids browser CORS. */
export const LAN_AI_BASE_URL = "/lan-ai";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
// Built-in relay for self-deploy / first-run convenience. API Key stays empty; users fill their own.
export const DEFAULT_RELAY_BASE_URL = "http://openai2api.com:3000";
const LEGACY_DEFAULT_RELAY_BASE_URLS = new Set([
    "https://www.codex2api.com",
    "https://www.codex2api.com/v1",
    OPENAI_BASE_URL.toLowerCase(),
    `${OPENAI_BASE_URL.toLowerCase()}/v1`,
]);
const DEFAULT_CHANNEL_ID = "default";
const DEFAULT_CHANNEL_NAME = "默认中转站";
const DEFAULT_RELAY_MODELS = ["gpt-image-2", "grok-imagine-video", "gpt-5.5", "gpt-4o-mini-tts"] as const;

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: DEFAULT_RELAY_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [
        {
            id: DEFAULT_CHANNEL_ID,
            name: DEFAULT_CHANNEL_NAME,
            baseUrl: DEFAULT_RELAY_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            models: [...DEFAULT_RELAY_MODELS],
        },
    ],
    model: `${DEFAULT_CHANNEL_ID}::gpt-image-2`,
    imageModel: `${DEFAULT_CHANNEL_ID}::gpt-image-2`,
    videoModel: `${DEFAULT_CHANNEL_ID}::grok-imagine-video`,
    textModel: `${DEFAULT_CHANNEL_ID}::gpt-5.5`,
    audioModel: `${DEFAULT_CHANNEL_ID}::gpt-4o-mini-tts`,
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "2",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: [`${DEFAULT_CHANNEL_ID}::gpt-image-2`, `${DEFAULT_CHANNEL_ID}::grok-imagine-video`, `${DEFAULT_CHANNEL_ID}::gpt-5.5`, `${DEFAULT_CHANNEL_ID}::gpt-4o-mini-tts`],
    imageModels: [`${DEFAULT_CHANNEL_ID}::gpt-image-2`],
    videoModels: [`${DEFAULT_CHANNEL_ID}::grok-imagine-video`],
    textModels: [`${DEFAULT_CHANNEL_ID}::gpt-5.5`],
    audioModels: [`${DEFAULT_CHANNEL_ID}::gpt-4o-mini-tts`],
    modelScripts: {},
    quality: "auto",
    size: "1:1",
    background: "",
    count: "1",
    canvasImageCount: "1",
};

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    url: "",
    username: "",
    password: "",
    directory: "infinite-canvas",
    lastSyncedAt: "",
};

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    isConfigOpen: boolean;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

function isVideoModelName(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return value.includes("seedance") || value.includes("agnes") || value.includes("video") || value.includes("sora") || value.includes("veo") || value.includes("kling") || value.includes("wan") || value.includes("hailuo");
}

function isImageModelName(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return !isVideoModelName(model) && !isAudioModelName(model) && (value.includes("seedream") || value.includes("gpt-image") || value.includes("image") || value.includes("dall-e") || value.includes("dalle") || value.includes("imagen") || value.includes("flux") || value.includes("sdxl") || value.includes("stable-diffusion") || value.includes("midjourney"));
}

function isAudioModelName(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return value.includes("audio") || value.includes("tts") || value.includes("speech") || value.includes("voice") || value.includes("music") || value.includes("sound");
}

function isTextModelName(model: string) {
    return !isImageModelName(model) && !isVideoModelName(model) && !isAudioModelName(model);
}

export function modelMatchesCapability(model: string, capability?: ModelCapability) {
    if (!capability) return true;
    if (capability === "image") return isImageModelName(model);
    if (capability === "video") return isVideoModelName(model);
    if (capability === "audio") return isAudioModelName(model);
    return isTextModelName(model);
}

export function filterModelsByCapability(models: string[], capability?: ModelCapability) {
    return capability ? models.filter((model) => modelMatchesCapability(model, capability)) : models;
}

/**
 * 下拉可选项直接来自各渠道已保存模型，再按名称推断能力。
 * imageModels/videoModels 等字段仍会同步写入，兼容导入导出与旧逻辑，但不再作为第二套手选清单。
 */
export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    const allModels = config.models?.length ? config.models : modelOptionsFromChannels(config.channels || []);
    if (!capability) return allModels;
    const derived = filterModelsByCapability(allModels, capability);
    if (derived.length) return derived;
    // 名称推断为空时回退到历史持久化列表，避免旧配置瞬间空白
    return config[modelListKey(capability)] || [];
}

function modelListKey(capability: ModelCapability) {
    return `${capability}Models` as "imageModels" | "videoModels" | "textModels" | "audioModels";
}

/** 渠道模型变更后，同步四类能力列表与默认模型（不手选可选项）。 */
export function deriveCapabilityModelLists(channels: ModelChannel[], current?: Partial<AiConfig>) {
    const models = modelOptionsFromChannels(channels);
    const imageModels = filterModelsByCapability(models, "image");
    const videoModels = filterModelsByCapability(models, "video");
    const textModels = filterModelsByCapability(models, "text");
    const audioModels = filterModelsByCapability(models, "audio");
    const pickDefault = (value: string | undefined, options: string[], fallback = "") => {
        const normalized = normalizeModelOptionValue(value, channels);
        if (normalized && options.includes(normalized)) return normalized;
        return options[0] || normalized || fallback;
    };
    return {
        models,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        imageModel: pickDefault(current?.imageModel || current?.model, imageModels),
        videoModel: pickDefault(current?.videoModel, videoModels, defaultConfig.videoModel),
        textModel: pickDefault(current?.textModel || current?.model, textModels),
        audioModel: pickDefault(current?.audioModel, audioModels, defaultConfig.audioModel),
    };
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    return Boolean(model.trim() && channel.baseUrl.trim() && (channel.apiKey.trim() || isSameOriginRelayBaseUrl(channel.baseUrl)));
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false) => set({ isConfigOpen: true, shouldPromptContinue }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: state.config, webdav: state.webdav }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const persistedWebdav = (persistedState.webdav || {}) as Partial<WebdavSyncConfig>;
                const config = { ...defaultConfig, ...persistedConfig };
                if (!Array.isArray(persistedConfig.channels)) config.channels = [];
                const channels = normalizeChannels(config);
                // 可选项始终由渠道模型推导，不再保留第二套手选 imageModels/videoModels 清单
                const derived = deriveCapabilityModelLists(channels, config);
                // Prune on load so deleted channels/models do not keep dead scripts in localStorage forever.
                const mergedConfig = pruneModelScripts({
                    ...config,
                    channelMode: "local",
                    apiFormat: normalizeApiFormat(config.apiFormat),
                    channels,
                    ...derived,
                    audioVoice: config.audioVoice || defaultConfig.audioVoice,
                    audioFormat: config.audioFormat || defaultConfig.audioFormat,
                    audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                    audioInstructions: config.audioInstructions || "",
                    reasoningEffort: config.reasoningEffort || defaultConfig.reasoningEffort,
                    videoSeconds: config.videoSeconds || defaultConfig.videoSeconds,
                    vquality: config.vquality || "720",
                    videoGenerateAudio: config.videoGenerateAudio || "true",
                    videoWatermark: config.videoWatermark || "false",
                    canvasImageCount: config.canvasImageCount || defaultConfig.canvasImageCount,
                    modelScripts: normalizeModelScripts(persistedConfig.modelScripts),
                });
                return {
                    ...current,
                    webdav: { ...defaultWebdavSyncConfig, ...persistedWebdav },
                    config: mergedConfig,
                };
            },
        },
    ),
);

/** Shared soft cap for local model-call scripts (store + runtime + editor). */
export const MODEL_SCRIPT_MAX_CHARS = 80_000;

function normalizeModelScripts(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const next: Record<string, string> = {};
    for (const [key, script] of Object.entries(value as Record<string, unknown>)) {
        const modelKey = key.trim();
        const text = typeof script === "string" ? script.trim() : "";
        if (!modelKey || !text) continue;
        // Persist only bounded scripts; oversized values are dropped on load to protect local storage.
        if (text.length > MODEL_SCRIPT_MAX_CHARS) continue;
        next[modelKey] = text;
    }
    return next;
}

/**
 * User-authored model call script for a model option; empty means system default path.
 * Prefer channel-qualified keys (`channelId::model`). Bare-name keys are legacy only and
 * never apply across a different channel when the request already carries channelId::model.
 */
export function resolveModelScript(config: AiConfig, value: string) {
    const scripts = config.modelScripts || {};
    const key = (value || "").trim();
    if (!key) return "";
    const direct = scripts[key]?.trim();
    if (direct) return direct;

    const decoded = decodeChannelModel(key);
    if (decoded) {
        // Qualified model: do not fall back to bare name (avoids cross-channel script reuse).
        return "";
    }

    // Bare model name: legacy bare key first; otherwise only the script for the same channel
    // that resolveModelChannel would use for the real request (not "any single qualified match").
    const bare = scripts[key]?.trim();
    if (bare) return bare;
    const channel = resolveModelChannel(config, key);
    if (!channel?.id) return "";
    return scripts[encodeChannelModel(channel.id, key)]?.trim() || "";
}

export function setModelScript(config: AiConfig, modelValue: string, script: string): AiConfig {
    const raw = (modelValue || "").trim();
    if (!raw) return config;
    // Prefer channel-qualified storage so later lookups stay channel-safe.
    const key = normalizeModelOptionValue(raw, config.channels) || raw;
    const nextScripts = { ...(config.modelScripts || {}) };
    const text = script.trim();
    if (text) {
        if (text.length > MODEL_SCRIPT_MAX_CHARS) {
            throw new Error(`模型调用脚本过长（最多 ${MODEL_SCRIPT_MAX_CHARS} 字符）`);
        }
        nextScripts[key] = text;
        // Drop legacy bare duplicate when upgrading to channel-qualified key.
        const name = modelOptionName(key);
        if (name && name !== key && nextScripts[name] === text) delete nextScripts[name];
    } else {
        delete nextScripts[key];
        const name = modelOptionName(key);
        if (name && name !== key) delete nextScripts[name];
    }
    return { ...config, modelScripts: nextScripts };
}

/** Exact channel-qualified keys and bare model names still present in config. */
export function knownModelScriptKeys(config: AiConfig) {
    const exact = new Set<string>();
    const bare = new Set<string>();
    for (const channel of config.channels || []) {
        for (const model of channel.models || []) {
            const name = model.trim();
            if (!name) continue;
            exact.add(encodeChannelModel(channel.id, name));
            bare.add(name);
        }
    }
    for (const value of [...(config.models || []), config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel, ...(config.imageModels || []), ...(config.videoModels || []), ...(config.textModels || []), ...(config.audioModels || [])]) {
        const key = (value || "").trim();
        if (!key) continue;
        exact.add(key);
        bare.add(modelOptionName(key));
        const decoded = decodeChannelModel(key);
        if (decoded) exact.add(encodeChannelModel(decoded.channelId, decoded.model));
    }
    return { exact, bare };
}

/**
 * Remove scripts whose model/channel no longer exists.
 * Channel-qualified keys (`A::gpt`) are dropped when channel A is gone even if bare `gpt` still exists on channel B.
 */
export function pruneModelScripts(config: AiConfig): AiConfig {
    const scripts = config.modelScripts || {};
    const { exact, bare } = knownModelScriptKeys(config);
    let changed = false;
    const next: Record<string, string> = {};
    for (const [key, script] of Object.entries(scripts)) {
        const text = script?.trim() || "";
        if (!text) {
            changed = true;
            continue;
        }
        const keep = isChannelModelValue(key) ? exact.has(key) : bare.has(key) || exact.has(key);
        if (keep) next[key] = text;
        else changed = true;
    }
    return changed ? { ...config, modelScripts: next } : config;
}

export function listConfiguredModelScripts(config: AiConfig) {
    return Object.entries(config.modelScripts || {})
        .filter(([, script]) => Boolean(script?.trim()))
        .map(([key, script]) => ({ key, script: script.trim(), label: modelOptionLabel(config, key) }))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

function normalizeModelList(models: string[], channels: ModelChannel[]) {
    const allModelOptions = channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model)));
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)))
        .map((model) => normalizeModelOptionValue(model, channels))
        .filter((model) => !allModelOptions.length || allModelOptions.includes(model) || !isChannelModelValue(model));
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    const isDefaultChannel = channel?.id?.trim() === DEFAULT_CHANNEL_ID;
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || (isDefaultChannel ? DEFAULT_CHANNEL_NAME : "新渠道"),
        baseUrl: channel?.baseUrl?.trim() || (isDefaultChannel ? DEFAULT_RELAY_BASE_URL : defaultBaseUrlForApiFormat(apiFormat)),
        apiKey: channel?.apiKey || "",
        apiFormat,
        compatProfile: normalizeCompatProfile(channel?.compatProfile),
        models: uniqueRawModels(channel?.models || (isDefaultChannel ? [...DEFAULT_RELAY_MODELS] : [])),
    };
}

export function normalizeCompatProfile(value: unknown): ChannelCompatProfile {
    if (value === "openai" || value === "openai-slim" || value === "grok-image" || value === "relay-fragile" || value === "auto") return value;
    return "auto";
}

/** 解析生效中的兼容预设（auto → 按 Base URL 推断，行为与历史硬编码一致）。 */
export function resolveChannelCompatProfile(baseUrl: string, profile?: ChannelCompatProfile | null): Exclude<ChannelCompatProfile, "auto"> {
    const explicit = normalizeCompatProfile(profile);
    if (explicit !== "auto") return explicit;
    const value = (baseUrl || "").trim().toLowerCase();
    if (value === LAN_AI_BASE_URL || value.startsWith(`${LAN_AI_BASE_URL}/`) || value.includes("/lan-ai")) return "grok-image";
    try {
        const path = new URL(value.startsWith("http") ? value : `http://local.invalid${value.startsWith("/") ? value : `/${value}`}`).pathname.replace(/\/+$/, "");
        if (path === LAN_AI_BASE_URL || path.startsWith(`${LAN_AI_BASE_URL}/`)) return "grok-image";
    } catch {
        /* ignore */
    }
    if (value.includes("codex2api") || value.includes("chatgpt2api") || value.includes("openai2api.com")) return "relay-fragile";
    return "openai";
}

export type ImageCompatStrategy = {
    profile: Exclude<ChannelCompatProfile, "auto">;
    /** 文生图尺寸字段策略 */
    sizeMode: "openai-size" | "grok-aspect" | "omit";
    includeQuality: boolean;
    includeOutputFormat: boolean;
    includeBackground: boolean;
    /** 400/连接失败时是否瘦身重试 */
    retrySlimOnError: boolean;
    /** 图生图 edits 失败后是否走 fragile 旁路 */
    editFallbackFragile: boolean;
};

export function getImageCompatStrategy(baseUrl: string, profile?: ChannelCompatProfile | null): ImageCompatStrategy {
    const resolved = resolveChannelCompatProfile(baseUrl, profile);
    switch (resolved) {
        case "grok-image":
            return {
                profile: resolved,
                sizeMode: "grok-aspect",
                includeQuality: false,
                includeOutputFormat: false,
                includeBackground: false,
                retrySlimOnError: true,
                editFallbackFragile: false,
            };
        case "relay-fragile":
            return {
                profile: resolved,
                sizeMode: "openai-size",
                includeQuality: true,
                includeOutputFormat: false,
                includeBackground: true,
                retrySlimOnError: true,
                editFallbackFragile: true,
            };
        case "openai-slim":
            return {
                profile: resolved,
                sizeMode: "openai-size",
                includeQuality: true,
                includeOutputFormat: false,
                includeBackground: true,
                retrySlimOnError: true,
                editFallbackFragile: false,
            };
        case "openai":
        default:
            return {
                profile: "openai",
                sizeMode: "openai-size",
                includeQuality: true,
                includeOutputFormat: true,
                includeBackground: true,
                retrySlimOnError: false,
                editFallbackFragile: false,
            };
    }
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${decoded.model}（${channel.name}）` : decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.includes(decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.includes(model)) || channels[0];
    return channel && channel.models.includes(model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.includes(model));
    return matched || config.channels[0] || createModelChannel({ id: DEFAULT_CHANNEL_ID, name: DEFAULT_CHANNEL_NAME, baseUrl: config.baseUrl || DEFAULT_RELAY_BASE_URL, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName) });
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
    };
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) =>
        createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? DEFAULT_CHANNEL_ID : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? DEFAULT_CHANNEL_NAME : `渠道 ${index + 1}`),
            models: uniqueRawModels(channel.models || []),
        }),
    );
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: DEFAULT_CHANNEL_ID,
                name: DEFAULT_CHANNEL_NAME,
                baseUrl: config.baseUrl || DEFAULT_RELAY_BASE_URL,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: uniqueRawModels([
                    ...(config.models || []),
                    config.model,
                    config.imageModel,
                    config.videoModel,
                    config.textModel,
                    config.audioModel,
                    ...DEFAULT_RELAY_MODELS,
                ]),
            }),
        );
    }
    return channels.map((channel) => {
        // Soft-migrate the built-in default channel from older stock URLs to the project relay.
        // Only rewrite when it still looks like the untouched stock default, never overwrite user customizations.
        if (channel.id === DEFAULT_CHANNEL_ID) {
            const baseUrl = channel.baseUrl.trim().replace(/\/+$/, "").toLowerCase();
            const isStockDefaultBase = !baseUrl || LEGACY_DEFAULT_RELAY_BASE_URLS.has(baseUrl);
            const nameLooksStock = !channel.name.trim() || channel.name.trim() === "默认渠道" || channel.name.trim() === DEFAULT_CHANNEL_NAME;
            if (isStockDefaultBase && nameLooksStock) {
                return {
                    ...channel,
                    name: DEFAULT_CHANNEL_NAME,
                    baseUrl: DEFAULT_RELAY_BASE_URL,
                    models: uniqueRawModels(channel.models.length ? channel.models : [...DEFAULT_RELAY_MODELS]),
                };
            }
        }
        return { ...channel, models: uniqueRawModels(channel.models) };
    });
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    return apiFormat === "gemini" ? GEMINI_BASE_URL : DEFAULT_RELAY_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" ? "gemini" : "openai";
}

function uniqueRawModels(models: string[]) {
    return Array.from(new Set((models || []).map((model) => modelOptionName(model).trim()).filter(Boolean)));
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function buildApiUrl(baseUrl: string, path: string) {
    let normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

export function isAiProxyBaseUrl(baseUrl: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
    if (normalizedBaseUrl === AI_PROXY_BASE_URL || normalizedBaseUrl.startsWith(`${AI_PROXY_BASE_URL}/`)) return true;
    try {
        const path = new URL(normalizedBaseUrl).pathname.replace(/\/+$/, "");
        return path === AI_PROXY_BASE_URL || path.startsWith(`${AI_PROXY_BASE_URL}/`);
    } catch {
        return false;
    }
}

/** Same-origin path that nginx/vite forwards to a LAN OpenAI-compatible server. */
export function isLanAiBaseUrl(baseUrl: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
    if (normalizedBaseUrl === LAN_AI_BASE_URL || normalizedBaseUrl.startsWith(`${LAN_AI_BASE_URL}/`)) return true;
    try {
        const path = new URL(normalizedBaseUrl).pathname.replace(/\/+$/, "");
        return path === LAN_AI_BASE_URL || path.startsWith(`${LAN_AI_BASE_URL}/`);
    } catch {
        return false;
    }
}

/** Browser may leave API Key empty for same-origin server/LAN relays. */
export function isSameOriginRelayBaseUrl(baseUrl: string) {
    return isAiProxyBaseUrl(baseUrl) || isLanAiBaseUrl(baseUrl);
}

function normalizeArkPlanBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        const lowerPath = path.toLowerCase();
        const arkPlanIndex = lowerPath.indexOf("/api/plan/v3");
        if (arkPlanIndex < 0) return baseUrl;
        const end = arkPlanIndex + "/api/plan/v3".length;
        if (lowerPath.length !== end && lowerPath[end] !== "/") return baseUrl;
        url.pathname = path.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return baseUrl;
    }
}
