import { describe, expect, it } from "vitest";

import { inferGrokTtsLanguage, normalizeGrokVoiceId, resolveAudioHostProfile, usesNativeGrokVoiceApi } from "@/lib/audio-host-profile";

describe("audio host profiles", () => {
    it("uses native Grok voice routes only on codex2api and xAI", () => {
        expect(resolveAudioHostProfile("https://www.codex2api.com/v1")).toMatchObject({ kind: "codex2api", ttsPath: "/tts", sttPath: "/stt" });
        expect(resolveAudioHostProfile("https://api.x.ai/v1")).toMatchObject({ kind: "xai", ttsPath: "/tts", sttPath: "/stt" });
        expect(resolveAudioHostProfile("https://relay.example/v1")).toMatchObject({ kind: "openai-compatible", ttsPath: "/audio/speech", sttPath: "/audio/transcriptions" });
    });

    it("requires both an exact Grok voice task and native host", () => {
        expect(usesNativeGrokVoiceApi("https://www.codex2api.com/v1", "grok-voice-tts", "tts")).toBe(true);
        expect(usesNativeGrokVoiceApi("https://www.codex2api.com/v1", "grok-voice-stt", "stt")).toBe(true);
        expect(usesNativeGrokVoiceApi("https://www.codex2api.com/v1", "gpt-4o-mini-tts", "tts")).toBe(false);
        expect(usesNativeGrokVoiceApi("https://relay.example/v1", "grok-voice-tts", "tts")).toBe(false);
    });

    it("normalizes supported xAI voices and defaults unknown OpenAI voices", () => {
        expect(normalizeGrokVoiceId("eve")).toBe("Eve");
        expect(normalizeGrokVoiceId("alloy")).toBe("Ara");
    });

    it("infers supported language codes from the prompt", () => {
        expect(inferGrokTtsLanguage("你好")).toBe("zh");
        expect(inferGrokTtsLanguage("こんにちは")).toBe("ja");
        expect(inferGrokTtsLanguage("안녕하세요")).toBe("ko");
        expect(inferGrokTtsLanguage("hello")).toBe("en");
    });
});
