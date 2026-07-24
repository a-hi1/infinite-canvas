import { describe, expect, it } from "vitest";

import { resolveVideoModelForReferences } from "@/services/api/video";
import { defaultConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

function withChannels(channels: ModelChannel[], videoModel: string): AiConfig {
    return {
        ...defaultConfig,
        channels,
        baseUrl: channels[0]?.baseUrl || defaultConfig.baseUrl,
        apiKey: channels[0]?.apiKey || "",
        models: channels.flatMap((channel) => channel.models.map((model) => `${channel.id}::${model}`)),
        videoModels: channels.flatMap((channel) => channel.models.map((model) => `${channel.id}::${model}`)),
        model: videoModel,
        videoModel,
    };
}

describe("Grok video model routing", () => {
    it("keeps channel qualification when auto-switching to a real I2V model", () => {
        const channel: ModelChannel = {
            id: "home",
            name: "Home Grok",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-image-quality", "grok-imagine-video", "grok-imagine-video-1.5"],
        };
        const config = withChannels([channel], "home::grok-imagine-image-quality");

        const resolved = resolveVideoModelForReferences(config, config.videoModel);

        expect(resolved.switched).toBe(true);
        expect(resolved.modelValue).toBe("home::grok-imagine-video-1.5");
        expect(resolved.from).toBe("grok-imagine-image-quality");
        expect(resolved.to).toBe("grok-imagine-video-1.5");
    });

    it("uses only the selected channel inventory when duplicate video model names exist", () => {
        const channelA: ModelChannel = {
            id: "a",
            name: "A",
            baseUrl: "https://a.example/v1",
            apiKey: "a-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-image-quality", "grok-video-a"],
        };
        const channelB: ModelChannel = {
            id: "b",
            name: "B",
            baseUrl: "https://b.example/v1",
            apiKey: "b-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-image-quality", "grok-video-b"],
        };
        const config = withChannels([channelA, channelB], "b::grok-imagine-image-quality");

        const resolved = resolveVideoModelForReferences(config, config.videoModel);

        expect(resolved.switched).toBe(true);
        expect(resolved.modelValue).toBe("b::grok-video-b");
        expect(resolved.to).toBe("grok-video-b");
        expect(resolved.modelValue).not.toContain("grok-video-a");
    });

    it("does not invent a missing video model when the selected channel has no I2V entry", () => {
        const channel: ModelChannel = {
            id: "relay",
            name: "Relay",
            baseUrl: "https://www.codex2api.com/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-image-quality"],
        };
        const config = withChannels([channel], "relay::grok-imagine-image-quality");

        const resolved = resolveVideoModelForReferences(config, config.videoModel);

        expect(resolved.switched).toBe(false);
        expect(resolved.modelValue).toBe("relay::grok-imagine-image-quality");
    });
});
