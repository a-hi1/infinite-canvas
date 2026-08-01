import { AGNES_VIDEO_MODE_GUIDE, formatVideoModeGuide } from "@/lib/video-mode-guide";
import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export const AGNES_VIDEO_SIZE = "1152x768";
export const AGNES_VIDEO_WIDTH = 1152;
export const AGNES_VIDEO_HEIGHT = 768;
export const AGNES_VIDEO_FRAME_RATE = 24;
export const agnesDurationOptions = [2, 5] as const;

export function isAgnesVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return isAgnesVideoModel(modelOptionName(requestConfig.model || requestConfig.videoModel)) || isAgnesBaseUrl(requestConfig.baseUrl);
}

export function isAgnesVideoModel(model: string) {
    return model.toLowerCase().includes("agnes");
}

export function isAgnesBaseUrl(baseUrl: string) {
    return baseUrl.toLowerCase().includes("agnes");
}

export function normalizeAgnesDuration(value: string) {
    const seconds = Math.floor(Number(value) || 2);
    return seconds === 5 ? 5 : 2;
}

export function agnesFrameCount(durationSeconds: number) {
    return Math.max(25, Math.round(durationSeconds * AGNES_VIDEO_FRAME_RATE) + 1);
}

export const agnesVideoTextOnlyError = "Agnes Video 仅支持纯文本生视频，请移除参考图、参考视频和参考音频";

export function agnesVideoRequestError(_config: AiConfig, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = []) {
    if (references.length || videoReferences.length || audioReferences.length) return agnesVideoTextOnlyError;
    return "";
}

/** Compact guide for the video workbench banner. */
export const agnesVideoModeGuide = AGNES_VIDEO_MODE_GUIDE;

/** Single-line fallback for callers that still expect a string. */
export const agnesVideoModeHint = formatVideoModeGuide(AGNES_VIDEO_MODE_GUIDE);
