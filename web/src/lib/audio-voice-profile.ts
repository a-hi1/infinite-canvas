import { audioVoiceOptionsForProvider, isMiniMaxAudioModel, normalizeAudioVoiceForProvider, type AudioVoiceProvider } from "@/lib/audio-generation";
import { usesNativeGrokVoiceApi } from "@/lib/audio-host-profile";
import { resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";

export type AudioVoiceProfile = {
    provider: AudioVoiceProvider;
    providerLabel: string;
    options: ReturnType<typeof audioVoiceOptionsForProvider>;
    voice: string;
};

export function resolveAudioVoiceProfile(config: AiConfig, selectedModel = config.model || config.audioModel): AudioVoiceProfile {
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const scripted = Boolean(resolveModelScript(config, selectedModel));
    const provider: AudioVoiceProvider = scripted
        ? "openai"
        : isMiniMaxAudioModel(requestConfig.baseUrl, requestConfig.model)
          ? "minimax"
          : usesNativeGrokVoiceApi(requestConfig.baseUrl, requestConfig.model, "tts")
            ? "xai"
            : "openai";

    return {
        provider,
        providerLabel: provider === "xai" ? "xAI Grok" : provider === "minimax" ? "MiniMax" : "OpenAI 兼容",
        options: audioVoiceOptionsForProvider(provider),
        voice: normalizeAudioVoiceForProvider(provider, config.audioVoice),
    };
}
