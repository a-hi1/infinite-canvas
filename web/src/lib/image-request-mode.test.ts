import { describe, expect, it } from "vitest";

import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { describeImageRequestMode, enhanceImageUpstreamError } from "@/lib/image-request-mode";
import { defaultConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

function configWithChannel(channel: ModelChannel, model: string, modelScripts: AiConfig["modelScripts"] = {}): AiConfig {
    const modelValue = `${channel.id}::${model}`;
    return {
        ...defaultConfig,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
        channels: [channel],
        model: modelValue,
        imageModel: modelValue,
        models: [modelValue],
        imageModels: [modelValue],
        modelScripts,
    };
}

describe("describeImageRequestMode", () => {
    it("describes Grok reference edits as JSON requests", () => {
        const channel: ModelChannel = {
            id: "grok",
            name: "Grok relay",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-image-edit"],
        };
        const config = configWithChannel(channel, "grok-imagine-image-edit");

        const mode = describeImageRequestMode({
            config,
            model: config.imageModel,
            referenceCount: 3,
            generationCount: 1,
            autoSwitched: { from: "grok-imagine-image-quality", to: "grok-imagine-image-edit" },
        });

        expect(mode.kind).toBe("edit-grok-json");
        expect(mode.path).toBe("/images/edits");
        expect(mode.summary).toContain("Grok JSON");
        expect(mode.compatLabel).toContain("Grok / Grok2API");
        expect(mode.autoSwitched).toEqual({ from: "grok-imagine-image-quality", to: "grok-imagine-image-edit" });
    });

    it("keeps standard OpenAI edits on multipart", () => {
        const channel: ModelChannel = {
            id: "openai",
            name: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "openai",
            models: ["gpt-image-1"],
        };
        const config = configWithChannel(channel, "gpt-image-1");

        const mode = describeImageRequestMode({ config, model: config.imageModel, referenceCount: 1, generationCount: 2 });

        expect(mode.kind).toBe("edit-openai-multipart");
        expect(mode.path).toBe("/images/edits");
        expect(mode.tip).toContain("multipart");
    });

    it("makes fragile relay degradation risk explicit", () => {
        const channel: ModelChannel = {
            id: "relay",
            name: "Relay",
            baseUrl: "https://www.codex2api.com/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["gpt-image-2"],
        };
        const config = configWithChannel(channel, "gpt-image-2");

        const mode = describeImageRequestMode({ config, model: config.imageModel, referenceCount: 2, generationCount: 1 });

        expect(mode.kind).toBe("edit-fragile");
        expect(mode.path).toContain("generations");
        expect(mode.tip).toContain("降级纯文生图");
    });

    it("describes no-reference requests as text-to-image before edit profiles", () => {
        const channel: ModelChannel = {
            id: "grok",
            name: "Grok relay",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["grok-imagine-image"],
        };
        const config = configWithChannel(channel, "grok-imagine-image");

        const mode = describeImageRequestMode({ config, model: config.imageModel, referenceCount: 0, generationCount: 1 });

        expect(mode.kind).toBe("text-to-image");
        expect(mode.path).toBe("/images/generations");
        expect(mode.summary).not.toContain("图生图");
    });

    it("keeps no-reference Gemini requests on the Gemini path", () => {
        const channel: ModelChannel = {
            id: "gemini",
            name: "Gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            apiKey: "test-only",
            apiFormat: "gemini",
            compatProfile: "auto",
            models: ["gemini-2.5-flash-image"],
        };
        const config = configWithChannel(channel, "gemini-2.5-flash-image");

        const mode = describeImageRequestMode({ config, model: config.imageModel, referenceCount: 0, generationCount: 1 });

        expect(mode.kind).toBe("gemini-image");
    });

    it("keeps custom scripts above built-in edit strategies", () => {
        const channel: ModelChannel = {
            id: "grok",
            name: "Grok relay",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["grok-imagine-image-quality"],
        };
        const config = configWithChannel(channel, "grok-imagine-image-quality", {
            "grok::grok-imagine-image-quality": "return { images: [] };",
        });

        const mode = describeImageRequestMode({ config, model: config.imageModel, referenceCount: 0, generationCount: 1 });

        expect(mode.kind).toBe("script");
        expect(mode.path).toBe("自定义脚本");
    });
});

describe("buildImageReferencePromptText", () => {
    it("describes every reference supplied by the caller", () => {
        const channel: ModelChannel = {
            id: "grok",
            name: "Grok relay",
            baseUrl: "/lan-ai",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "grok-image",
            models: ["grok-imagine-image-edit"],
        };
        const config = configWithChannel(channel, "grok-imagine-image-edit");
        const references = Array.from({ length: 4 }, (_, index): ReferenceImage => ({
            id: String(index),
            name: `ref-${index + 1}.png`,
            type: "image/png",
            dataUrl: `data:image/png;base64,${index}`,
        }));

        const prompt = buildImageReferencePromptText("让主体同框", references, config);

        expect(prompt).toContain("图片1、图片2、图片3、图片4");
    });
});

describe("enhanceImageUpstreamError", () => {
    it("guides JSON-only edit users to the Grok profile", () => {
        const text = enhanceImageUpstreamError("Only application/json is supported; multipart/form-data is invalid", "edit", "图生图失败");

        expect(text).toContain("Grok / Grok2API 生图");
        expect(text).toContain("不要 multipart");
    });

    it("adds an actionable hint to opaque edit errors", () => {
        const text = enhanceImageUpstreamError("upstream returned status 400", "edit", "图生图失败");

        expect(text).toContain("确认模型支持参考图");
        expect(text).toContain("调整生图兼容预设");
    });
});
