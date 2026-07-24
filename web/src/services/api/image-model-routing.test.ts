import { describe, expect, it } from "vitest";

import { listGrokImageEditModelCandidates, resolveImageModelForReferences } from "@/services/api/image";
import { defaultConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

function withChannels(channels: ModelChannel[], imageModel: string): AiConfig {
    return {
        ...defaultConfig,
        channels,
        baseUrl: channels[0]?.baseUrl || defaultConfig.baseUrl,
        apiKey: channels[0]?.apiKey || "",
        models: channels.flatMap((channel) => channel.models.map((model) => `${channel.id}::${model}`)),
        imageModels: channels.flatMap((channel) => channel.models.map((model) => `${channel.id}::${model}`)),
        model: imageModel,
        imageModel,
    };
}

describe("Grok image edit model routing", () => {
    it("uses the selected channel inventory when duplicate model names exist", () => {
        const channelA: ModelChannel = {
            id: "a",
            name: "A",
            baseUrl: "https://a.example/v1",
            apiKey: "a-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["grok-imagine-image-quality", "grok-imagine-image-edit-a"],
        };
        const channelB: ModelChannel = {
            id: "b",
            name: "B",
            baseUrl: "https://b.example/v1",
            apiKey: "b-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["grok-imagine-image-quality", "grok-imagine-image-edit-b"],
        };
        const config = withChannels([channelA, channelB], "b::grok-imagine-image-quality");

        const candidates = listGrokImageEditModelCandidates(config, config.imageModel);

        expect(candidates[0]).toBe("grok-imagine-image-edit-b");
        expect(candidates).not.toContain("grok-imagine-image-edit-a");
    });

    it("does not inject nonexistent edit model names when inventory is populated", () => {
        const channel: ModelChannel = {
            id: "grok",
            name: "Grok",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["grok-imagine-image-quality"],
        };
        const config = withChannels([channel], "grok::grok-imagine-image-quality");

        const candidates = listGrokImageEditModelCandidates(config, config.imageModel);

        expect(candidates).toEqual(["grok-imagine-image-quality"]);
    });

    it("keeps channel qualification when auto-switching to a real edit model", () => {
        const channel: ModelChannel = {
            id: "home",
            name: "Home Grok",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["grok-imagine-image-quality", "grok-imagine-image-edit"],
        };
        const config = withChannels([channel], "home::grok-imagine-image-quality");

        const resolved = resolveImageModelForReferences(config, config.imageModel);

        expect(resolved.switched).toBe(true);
        expect(resolved.modelValue).toBe("home::grok-imagine-image-edit");
    });
});
