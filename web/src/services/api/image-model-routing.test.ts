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

    it("prefers listed edit models and still injects edit names when inventory has only quality", () => {
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

        // 列表没有 *edit* 时仍注入 edit 候选，保证画布「编辑已有图」会自动切 edit
        expect(candidates[0]).toBe("grok-imagine-image-edit");
        expect(candidates).toContain("grok-imagine-image-quality");
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

    it("does not switch a non-Grok model just because it uses /lan-ai", () => {
        const channel: ModelChannel = {
            id: "lan",
            name: "LAN relay",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["flux-kontext"],
        };
        const config = withChannels([channel], "lan::flux-kontext");

        expect(listGrokImageEditModelCandidates(config, config.imageModel)).toEqual(["flux-kontext"]);
        expect(resolveImageModelForReferences(config, config.imageModel)).toEqual({
            modelValue: "lan::flux-kontext",
            switched: false,
            from: "flux-kontext",
            to: "flux-kontext",
        });
    });

    it("keeps an already resolved unlisted edit model first", () => {
        const channel: ModelChannel = {
            id: "home",
            name: "Home Grok",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["grok-imagine-image-quality"],
        };
        const config = withChannels([channel], "home::grok-imagine-image-edit");

        expect(listGrokImageEditModelCandidates(config, config.imageModel)[0]).toBe("grok-imagine-image-edit");
    });

    it("auto-switches quality to edit even when the channel inventory only lists quality", () => {
        const channel: ModelChannel = {
            id: "home",
            name: "Home Grok",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["grok-imagine-image-quality", "grok-imagine-image"],
        };
        const config = withChannels([channel], "home::grok-imagine-image-quality");

        const resolved = resolveImageModelForReferences(config, config.imageModel);

        expect(resolved.switched).toBe(true);
        expect(resolved.from).toBe("grok-imagine-image-quality");
        expect(resolved.to).toBe("grok-imagine-image-edit");
        expect(resolved.modelValue).toBe("home::grok-imagine-image-edit");
    });
});
