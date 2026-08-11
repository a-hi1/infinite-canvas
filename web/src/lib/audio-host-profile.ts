import { normalizeAudioVoiceForProvider } from "@/lib/audio-generation";
import { isGrokModelTask } from "@/lib/grok-model-profile";
import { isCodex2apiBaseUrl, isXaiBaseUrl } from "@/lib/grok-video";

export type AudioHostKind = "codex2api" | "xai" | "openai-compatible";
export type GrokAudioTask = "tts" | "stt";

export type AudioHostProfile = {
    kind: AudioHostKind;
    ttsPath: string;
    sttPath: string;
    nativeGrokVoice: boolean;
};

export function resolveAudioHostProfile(baseUrl: string): AudioHostProfile {
    if (isCodex2apiBaseUrl(baseUrl)) {
        return { kind: "codex2api", ttsPath: "/tts", sttPath: "/stt", nativeGrokVoice: true };
    }
    if (isXaiBaseUrl(baseUrl)) {
        return { kind: "xai", ttsPath: "/tts", sttPath: "/stt", nativeGrokVoice: true };
    }
    return {
        kind: "openai-compatible",
        ttsPath: "/audio/speech",
        sttPath: "/audio/transcriptions",
        nativeGrokVoice: false,
    };
}

export function usesNativeGrokVoiceApi(baseUrl: string, model: string, task: GrokAudioTask) {
    const host = resolveAudioHostProfile(baseUrl);
    return host.nativeGrokVoice && isGrokModelTask(model, task);
}

export function normalizeGrokVoiceId(value: string) {
    return normalizeAudioVoiceForProvider("xai", value);
}

export function inferGrokTtsLanguage(text: string) {
    if (/[぀-ヿ]/u.test(text)) return "ja";
    if (/[가-힯]/u.test(text)) return "ko";
    if (/[㐀-鿿]/u.test(text)) return "zh";
    return "en";
}
