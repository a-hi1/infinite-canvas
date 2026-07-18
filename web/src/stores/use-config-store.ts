import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

export type ApiCallFormat = "openai" | "gemini";

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
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
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
// Built-in relay for self-deploy / first-run convenience. API Key stays empty; users fill their own.
export const DEFAULT_RELAY_BASE_URL = "https://www.codex2api.com";
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

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config[modelListKey(capability)];
}

function modelListKey(capability: ModelCapability) {
    return `${capability}Models` as "imageModels" | "videoModels" | "textModels" | "audioModels";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    return Boolean(model.trim() && channel.baseUrl.trim() && (channel.apiKey.trim() || isAiProxyBaseUrl(channel.baseUrl)));
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
                const models = modelOptionsFromChannels(channels);
                return {
                    ...current,
                    webdav: { ...defaultWebdavSyncConfig, ...persistedWebdav },
                    config: {
                        ...config,
                        channelMode: "local",
                        apiFormat: normalizeApiFormat(config.apiFormat),
                        channels,
                        models,
                        imageModel: normalizeModelOptionValue(config.imageModel || config.model, channels),
                        videoModel: normalizeModelOptionValue(config.videoModel || "grok-imagine-video", channels),
                        textModel: normalizeModelOptionValue(config.textModel || config.model, channels),
                        audioModel: normalizeModelOptionValue(config.audioModel || defaultConfig.audioModel, channels),
                        audioVoice: config.audioVoice || defaultConfig.audioVoice,
                        audioFormat: config.audioFormat || defaultConfig.audioFormat,
                        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                        audioInstructions: config.audioInstructions || "",
                        videoSeconds: config.videoSeconds || defaultConfig.videoSeconds,
                        vquality: config.vquality || "720",
                        videoGenerateAudio: config.videoGenerateAudio || "true",
                        videoWatermark: config.videoWatermark || "false",
                        canvasImageCount: config.canvasImageCount || defaultConfig.canvasImageCount,
                        imageModels: Array.isArray(persistedConfig.imageModels) ? normalizeModelList(config.imageModels, channels) : filterModelsByCapability(models, "image"),
                        videoModels: Array.isArray(persistedConfig.videoModels) ? normalizeModelList(config.videoModels, channels) : filterModelsByCapability(models, "video"),
                        textModels: Array.isArray(persistedConfig.textModels) ? normalizeModelList(config.textModels, channels) : filterModelsByCapability(models, "text"),
                        audioModels: Array.isArray(persistedConfig.audioModels) ? normalizeModelList(config.audioModels, channels) : filterModelsByCapability(models, "audio"),
                        modelScripts: normalizeModelScripts(persistedConfig.modelScripts),
                    },
                };
            },
        },
    ),
);

function normalizeModelScripts(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const next: Record<string, string> = {};
    for (const [key, script] of Object.entries(value as Record<string, unknown>)) {
        const modelKey = key.trim();
        const text = typeof script === "string" ? script.trim() : "";
        if (!modelKey || !text) continue;
        next[modelKey] = text;
    }
    return next;
}

/** User-authored model call script for a model option; empty means system default path. */
export function resolveModelScript(config: AiConfig, value: string) {
    const scripts = config.modelScripts || {};
    const direct = scripts[value]?.trim();
    if (direct) return direct;
    const name = modelOptionName(value);
    if (name && name !== value) {
        const byName = scripts[name]?.trim();
        if (byName) return byName;
    }
    return "";
}

export function setModelScript(config: AiConfig, modelValue: string, script: string): AiConfig {
    const key = (modelValue || "").trim();
    if (!key) return config;
    const nextScripts = { ...(config.modelScripts || {}) };
    const text = script.trim();
    if (text) nextScripts[key] = text;
    else delete nextScripts[key];
    return { ...config, modelScripts: nextScripts };
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
        models: uniqueRawModels(channel?.models || (isDefaultChannel ? [...DEFAULT_RELAY_MODELS] : [])),
    };
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
        // Soft-migrate the built-in default channel from OpenAI official URL to the project relay.
        // Only rewrite when it still looks like the untouched stock default, never overwrite user customizations.
        if (channel.id === DEFAULT_CHANNEL_ID) {
            const baseUrl = channel.baseUrl.trim().replace(/\/+$/, "").toLowerCase();
            const isStockOpenAiDefault = !baseUrl || baseUrl === OPENAI_BASE_URL.toLowerCase() || baseUrl === `${OPENAI_BASE_URL.toLowerCase()}/v1`;
            const nameLooksStock = !channel.name.trim() || channel.name.trim() === "默认渠道" || channel.name.trim() === DEFAULT_CHANNEL_NAME;
            if (isStockOpenAiDefault && nameLooksStock) {
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
