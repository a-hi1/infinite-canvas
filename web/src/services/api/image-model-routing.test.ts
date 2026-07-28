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
    it("keeps the selected channel model first when duplicate names exist", () => {
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

        // 用户选择优先；中转 *-edit 仅列表命中时出现，且不抢首位
        expect(candidates[0]).toBe("grok-imagine-image-quality");
        expect(candidates).toContain("grok-imagine-image-edit-b");
        expect(candidates).not.toContain("grok-imagine-image-edit-a");
    });

    it("does not inject edit names when inventory only lists quality", () => {
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

        // 官方图生图与文生共用 quality/image；禁止凭空注入 *-edit
        expect(candidates[0]).toBe("grok-imagine-image-quality");
        expect(candidates).not.toContain("grok-imagine-image-edit");
    });

    it("never auto-switches model when references are present", () => {
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

        expect(resolved.switched).toBe(false);
        expect(resolved.modelValue).toBe("home::grok-imagine-image-quality");
        expect(resolved.from).toBe("grok-imagine-image-quality");
        expect(resolved.to).toBe("grok-imagine-image-quality");
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

    it("keeps an already selected edit model first without forcing others onto it", () => {
        const channel: ModelChannel = {
            id: "home",
            name: "Home Grok",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["grok-imagine-image-quality", "grok-imagine-image-edit"],
        };
        const config = withChannels([channel], "home::grok-imagine-image-edit");

        expect(listGrokImageEditModelCandidates(config, config.imageModel)[0]).toBe("grok-imagine-image-edit");
        expect(resolveImageModelForReferences(config, config.imageModel).switched).toBe(false);
    });

    it("prefers official image names from inventory after the user selection", () => {
        const channel: ModelChannel = {
            id: "home",
            name: "Home Grok",
            baseUrl: "https://www.codex2api.com/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["grok-imagine-image-quality", "grok-imagine-image", "grok-imagine-image-edit"],
        };
        const config = withChannels([channel], "home::grok-imagine-image-quality");

        const candidates = listGrokImageEditModelCandidates(config, config.imageModel);

        expect(candidates[0]).toBe("grok-imagine-image-quality");
        expect(candidates).toContain("grok-imagine-image");
        // edit 在列表中可以出现，但不抢用户选择的首位
        expect(candidates.indexOf("grok-imagine-image")).toBeLessThan(candidates.indexOf("grok-imagine-image-edit"));
    });
});
