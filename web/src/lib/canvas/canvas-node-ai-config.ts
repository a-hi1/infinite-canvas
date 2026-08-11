import { AGNES_VIDEO_SIZE, isAgnesVideoConfig, normalizeAgnesDuration } from "@/lib/agnes-video";
import { defaultConfig, modelMatchesAudioTask, modelMatchesCapability, type AiConfig } from "@/stores/use-config-store";
import type { CanvasGenerationMode, CanvasNodeData } from "@/types/canvas";

/**
 * Resolve the model for a canvas generation mode.
 * Prefer the node override when it still matches the mode capability; otherwise
 * fall back to the global default for that mode.
 */
export function resolveCanvasModeModel(config: AiConfig, currentModel: string | undefined, mode: CanvasGenerationMode) {
    const defaultModel = mode === "image" ? config.imageModel : mode === "video" ? config.videoModel : mode === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = mode === "image" ? defaultConfig.imageModel : mode === "video" ? defaultConfig.videoModel : mode === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    const currentMatchesMode = currentModel && (mode === "audio" ? modelMatchesAudioTask(currentModel, "tts") : modelMatchesCapability(currentModel, mode));
    const defaultMatchesMode = defaultModel && (mode === "audio" ? modelMatchesAudioTask(defaultModel, "tts") : modelMatchesCapability(defaultModel, mode));
    if (currentMatchesMode) return currentModel;
    if (defaultMatchesMode) return defaultModel;
    return fallbackModel || defaultModel || currentModel || config.model || defaultConfig.model;
}

/**
 * Merge global AI config with per-node metadata overrides.
 * `background` treats an explicit empty string as intentional (do not refill from global).
 * Pass `applyAgnesVideoDefaults` for generation paths that must normalize Agnes constraints.
 */
export function mergeCanvasNodeAiConfig(globalConfig: AiConfig, node: CanvasNodeData | undefined, mode: CanvasGenerationMode, options?: { applyAgnesVideoDefaults?: boolean }): AiConfig {
    const metadata = node?.metadata;
    const merged: AiConfig = {
        ...globalConfig,
        model: resolveCanvasModeModel(globalConfig, metadata?.model, mode),
        reasoningEffort: metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: metadata?.size || globalConfig.size || defaultConfig.size,
        background: metadata?.background !== undefined ? metadata.background : globalConfig.background || defaultConfig.background || "",
        videoSeconds: metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
    };

    if (!options?.applyAgnesVideoDefaults || mode !== "video" || !isAgnesVideoConfig(merged)) return merged;

    return {
        ...merged,
        size: AGNES_VIDEO_SIZE,
        videoSeconds: String(normalizeAgnesDuration(merged.videoSeconds)),
        videoGenerateAudio: "false",
        videoWatermark: "false",
    };
}
