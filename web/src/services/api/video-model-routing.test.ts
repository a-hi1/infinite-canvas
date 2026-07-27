import { describe, expect, it } from "vitest";

import { buildGrokPayloadCandidates, grokCreatePathCandidates, payloadKeepsAllGrokVideoReferences, resolveVideoModelForReferences } from "@/services/api/video";
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

    it("builds only full multi-reference candidates and covers fallback models fairly", async () => {
        const channel: ModelChannel = {
            id: "home",
            name: "Home Grok",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-video-1.5", "grok-imagine-video"],
        };
        const config = withChannels([channel], "home::grok-imagine-video");
        const references = ["a", "b", "c"].map((id) => ({
            id,
            name: `${id}.png`,
            type: "image/png",
            dataUrl: `https://example.com/${id}.png`,
        }));

        const candidates = await buildGrokPayloadCandidates(config, config.videoModel, "prompt", references);

        expect(candidates.length).toBeLessThanOrEqual(18);
        expect(candidates.every((payload) => payloadKeepsAllGrokVideoReferences(payload, references.length))).toBe(true);
        expect(new Set(candidates.map((payload) => payload.model))).toEqual(new Set(["grok-imagine-video-1.5", "grok-imagine-video"]));
        for (const model of ["grok-imagine-video-1.5", "grok-imagine-video"]) {
            const modelPayloads = candidates.filter((payload) => payload.model === model);
            expect(modelPayloads.some((payload) => Array.isArray(payload.reference_images))).toBe(true);
            expect(modelPayloads.some((payload) => Array.isArray(payload.images))).toBe(true);
            expect(modelPayloads.some((payload) => Array.isArray(payload.image_urls))).toBe(true);
        }
    });

    it("rejects more than seven references instead of truncating them", async () => {
        const channel: ModelChannel = {
            id: "home",
            name: "Home Grok",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-video"],
        };
        const config = withChannels([channel], "home::grok-imagine-video");
        const references = Array.from({ length: 8 }, (_, index) => ({
            id: String(index),
            name: `${index}.png`,
            type: "image/png",
            dataUrl: `https://example.com/${index}.png`,
        }));

        await expect(buildGrokPayloadCandidates(config, config.videoModel, "prompt", references)).rejects.toThrow("最多支持 7 张");
    });

    it("rejects multi-ref payloads that only keep the first image", () => {
        expect(payloadKeepsAllGrokVideoReferences({ model: "g", prompt: "p", image: { url: "a" }, duration: 8 }, 2)).toBe(false);
        expect(
            payloadKeepsAllGrokVideoReferences(
                {
                    model: "g",
                    prompt: "p",
                    reference_images: [{ url: "a" }, { url: "b" }],
                    duration: 8,
                },
                2,
            ),
        ).toBe(true);
        expect(payloadKeepsAllGrokVideoReferences({ model: "g", prompt: "p", images: ["a", "b"], duration: 8 }, 2)).toBe(true);
        expect(payloadKeepsAllGrokVideoReferences({ model: "g", prompt: "p", image_urls: ["a"], duration: 8 }, 2)).toBe(false);
    });

    it("prefers OpenAI /videos path for generic New API hosts and generations for xAI/codex2api", () => {
        const newApi = withChannels(
            [
                {
                    id: "home",
                    name: "Home NewAPI",
                    baseUrl: "http://192.168.6.78:3000/v1",
                    apiKey: "test-only",
                    apiFormat: "openai",
                    compatProfile: "auto",
                    models: ["grok-imagine-video"],
                },
            ],
            "home::grok-imagine-video",
        );
        // New API + Grok：优先 /video/generations，避免 OpenAI /videos 触发 invalid api platform:48
        expect(grokCreatePathCandidates(newApi, 0, "home::grok-imagine-video")[0]).toBe("/video/generations");
        expect(grokCreatePathCandidates(newApi, 2, "home::grok-imagine-video")).toEqual(
            expect.arrayContaining(["/video/generations", "/videos/generations", "/videos"]),
        );
        expect(grokCreatePathCandidates(newApi, 2, "home::grok-imagine-video")).not.toContain("/videos/edits");

        const codex = withChannels(
            [
                {
                    id: "relay",
                    name: "codex2api",
                    baseUrl: "https://www.codex2api.com/v1",
                    apiKey: "test-only",
                    apiFormat: "openai",
                    compatProfile: "auto",
                    models: ["grok-imagine-video"],
                },
            ],
            "relay::grok-imagine-video",
        );
        expect(grokCreatePathCandidates(codex, 0, "relay::grok-imagine-video")[0]).toBe("/videos/generations");
        expect(grokCreatePathCandidates(codex, 0, "relay::grok-imagine-video")).not.toContain("/videos");
        // 多图参考仍是 generation，禁止 edits / 不存在的 /videos
        expect(grokCreatePathCandidates(codex, 2, "relay::grok-imagine-video")).toEqual(["/videos/generations"]);
        expect(grokCreatePathCandidates(codex, 2, "relay::grok-imagine-video")).not.toContain("/videos/edits");
        expect(grokCreatePathCandidates(codex, 2, "relay::grok-imagine-video")).not.toContain("/videos");
    });

    it("includes OpenAI-compatible seconds/size fields for pure-text Grok candidates", async () => {
        const channel: ModelChannel = {
            id: "home",
            name: "Home NewAPI",
            baseUrl: "http://192.168.6.78:3000/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-video"],
        };
        const config = {
            ...withChannels([channel], "home::grok-imagine-video"),
            videoSeconds: "8",
            size: "16:9",
            vquality: "720p",
        };
        const candidates = await buildGrokPayloadCandidates(config, config.videoModel, "吃饭", []);
        expect(candidates.some((payload) => payload.duration === 8)).toBe(true);
        expect(candidates.some((payload) => payload.seconds === "8" || payload.seconds === 8)).toBe(true);
        expect(candidates.some((payload) => payload.size === "1280x720")).toBe(true);
    });
});
