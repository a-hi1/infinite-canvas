import { describe, expect, it } from "vitest";

import { resolveAudioVoiceProfile } from "@/lib/audio-voice-profile";
import { defaultConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

function configFor(model: string, baseUrl: string, audioVoice: string): AiConfig {
    const channel: ModelChannel = {
        id: "audio",
        name: "Audio",
        baseUrl,
        apiKey: "test-only",
        apiFormat: "openai",
        models: [model],
    };
    const selectedModel = `audio::${model}`;
    return {
        ...defaultConfig,
        channels: [channel],
        models: [selectedModel],
        audioModels: [selectedModel],
        model: selectedModel,
        audioModel: selectedModel,
        audioVoice,
    };
}

describe("audio voice profiles", () => {
    it("shows xAI voices for native Grok TTS and preserves a compatible selection", () => {
        const profile = resolveAudioVoiceProfile(configFor("grok-voice-tts", "https://www.codex2api.com/v1", "Eve"));
        expect(profile.provider).toBe("xai");
        expect(profile.options.map((item) => item.value)).toEqual(["Eve", "Ara", "Rex", "Sal", "Leo"]);
        expect(profile.voice).toBe("Eve");
    });

    it("replaces an incompatible OpenAI voice with the visible xAI default", () => {
        expect(resolveAudioVoiceProfile(configFor("grok-voice-tts", "https://api.x.ai/v1", "alloy")).voice).toBe("Ara");
    });

    it("keeps OpenAI-compatible relays on OpenAI voices", () => {
        const profile = resolveAudioVoiceProfile(configFor("grok-voice-tts", "https://relay.example/v1", "Eve"));
        expect(profile.provider).toBe("openai");
        expect(profile.voice).toBe("alloy");
        expect(profile.options.some((item) => item.value === "Eve")).toBe(false);
    });

    it("shows MiniMax voices for MiniMax speech models", () => {
        const profile = resolveAudioVoiceProfile(configFor("speech-02-hd", "https://api.minimaxi.com/v1", "alloy"));
        expect(profile.provider).toBe("minimax");
        expect(profile.voice).toBe("male-qn-qingse");
        expect(profile.options.some((item) => item.value === "female-yujie")).toBe(true);
    });
});
