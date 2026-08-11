import { describe, expect, it } from "vitest";

import { GROK_MODEL_PROFILES, grokModelName, isGrokModelTask, resolveGrokModelProfile } from "@/lib/grok-model-profile";
import { deriveCapabilityModelLists, defaultConfig, modelMatchesCapability, modelMatchesAudioTask, selectableModelsByAudioTask, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";

const expected = {
    text: ["grok", "grok-build", "grok-4.5", "grok-composer", "grok-web-search"],
    image: ["grok-imagine-image", "grok-imagine-image-quality", "grok-imagine-edit"],
    video: ["grok-imagine-video", "grok-imagine-video-1.5", "grok-imagine-video-1.5-preview"],
    audio: ["grok-voice-stt", "grok-voice-tts", "grok-voice-latest"],
} as const;

describe("Grok model profiles", () => {
    it("defines the exact 14 relay models once", () => {
        expect(GROK_MODEL_PROFILES).toHaveLength(14);
        expect(new Set(GROK_MODEL_PROFILES.map((profile) => profile.model)).size).toBe(14);
    });

    it.each(Object.entries(expected).flatMap(([capability, models]) => models.map((model) => [model, capability] as const)))(
        "classifies %s as %s",
        (model, capability) => {
            const typedCapability = capability as ModelCapability;
            expect(resolveGrokModelProfile(model)?.capability).toBe(typedCapability);
            expect(modelMatchesCapability(model, typedCapability)).toBe(true);
            for (const other of ["text", "image", "video", "audio"] as const) {
                if (other !== typedCapability) expect(modelMatchesCapability(model, other)).toBe(false);
            }
        },
    );

    it("separates TTS, STT, and generic voice tasks", () => {
        expect(modelMatchesAudioTask("relay::grok-voice-tts", "tts")).toBe(true);
        expect(modelMatchesAudioTask("relay::grok-voice-tts", "stt")).toBe(false);
        expect(modelMatchesAudioTask("relay::grok-voice-stt", "stt")).toBe(true);
        expect(modelMatchesAudioTask("relay::grok-voice-stt", "tts")).toBe(false);
        expect(modelMatchesAudioTask("relay::grok-voice-latest", "tts")).toBe(false);
        expect(modelMatchesAudioTask("relay::grok-voice-latest", "stt")).toBe(false);

        const channel: ModelChannel = {
            id: "relay",
            name: "Grok relay",
            baseUrl: "https://relay.example/v1",
            apiKey: "test",
            apiFormat: "openai",
            models: ["grok-voice-stt", "grok-voice-tts", "grok-voice-latest"],
        };
        const config = { ...defaultConfig, channels: [channel], models: ["relay::grok-voice-stt", "relay::grok-voice-tts", "relay::grok-voice-latest"] };
        expect(selectableModelsByAudioTask(config, "tts")).toEqual(["relay::grok-voice-tts"]);
        expect(selectableModelsByAudioTask(config, "stt")).toEqual(["relay::grok-voice-stt"]);
    });
    it("normalizes channel-qualified names", () => {
        expect(grokModelName("relay::grok-imagine-edit")).toBe("grok-imagine-edit");
        expect(resolveGrokModelProfile("relay::grok-imagine-edit")?.task).toBe("image-edit");
        expect(isGrokModelTask("relay::grok-voice-stt", "stt")).toBe(true);
    });

    it("derives stable capability lists for the whole relay inventory", () => {
        const channel: ModelChannel = {
            id: "relay",
            name: "Grok relay",
            baseUrl: "https://relay.example/v1",
            apiKey: "test",
            apiFormat: "openai",
            models: GROK_MODEL_PROFILES.map((profile) => profile.model),
        };
        const derived = deriveCapabilityModelLists([channel]);
        for (const capability of ["text", "image", "video", "audio"] as const) {
            expect(derived[`${capability}Models`]).toEqual(expected[capability].map((model) => `relay::${model}`));
        }
    });
});
