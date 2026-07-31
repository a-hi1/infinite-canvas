import { describe, expect, it } from "vitest";

import { clampImageConfigToCapability, clampVideoConfigToCapability, resolveImageCapability, resolveVideoCapability } from "@/lib/model-capability";
import type { AiConfig } from "@/stores/use-config-store";

function baseConfig(overrides: Partial<AiConfig> = {}): AiConfig {
    return {
        channelMode: "local",
        apiFormat: "openai",
        channels: [
            {
                id: "default",
                name: "默认",
                baseUrl: "https://www.codex2api.com",
                apiKey: "x",
                apiFormat: "openai",
                models: ["gpt-image-2", "grok-imagine-video", "sora-2", "veo-3.1", "seedance-1-0-pro", "agnes-video-v2.0", "grok-imagine-image"],
            },
        ],
        model: "default::gpt-image-2",
        imageModel: "default::gpt-image-2",
        videoModel: "default::grok-imagine-video",
        textModel: "default::gpt-5.5",
        audioModel: "default::gpt-4o-mini-tts",
        audioVoice: "alloy",
        audioFormat: "mp3",
        audioSpeed: "1",
        audioInstructions: "",
        videoSeconds: "8",
        vquality: "720",
        videoGenerateAudio: "true",
        videoWatermark: "false",
        systemPrompt: "",
        models: [],
        imageModels: [],
        videoModels: [],
        textModels: [],
        audioModels: [],
        modelScripts: {},
        quality: "auto",
        size: "16:9",
        background: "",
        count: "1",
        canvasImageCount: "1",
        ...overrides,
    } as AiConfig;
}

describe("resolveVideoCapability", () => {
    it("exposes real Grok ratio/seconds/resolution pills only", () => {
        const cap = resolveVideoCapability(baseConfig({ model: "default::grok-imagine-video", videoModel: "default::grok-imagine-video" }));
        expect(cap.provider).toBe("grok");
        expect(cap.ratios.map((item) => item.value)).toEqual(["16:9", "9:16", "1:1", "4:3", "3:4"]);
        expect(cap.seconds.map((item) => item.value)).toEqual(["4", "6", "8", "10", "12", "15"]);
        expect(cap.resolutions.map((item) => item.value)).toEqual(["480", "720", "1080"]);
        expect(cap.card.fields.some((field) => field.label === "工作模式")).toBe(true);
        expect(cap.card.fields.some((field) => field.label === "不支持")).toBe(true);
    });

    it("clamps Sora-2 size to 720p landscape/portrait only", () => {
        const config = baseConfig({ model: "default::sora-2", videoModel: "default::sora-2", size: "1792x1024", videoSeconds: "10" });
        const clamped = clampVideoConfigToCapability(config);
        expect(clamped.size).toBe("1280x720");
        expect(clamped.videoSeconds).toBe("8");
        const cap = resolveVideoCapability(config);
        expect(cap.seconds.map((item) => item.value)).toEqual(["4", "8", "12"]);
        expect(cap.ratios.every((item) => item.value === "1280x720" || item.value === "720x1280")).toBe(true);
    });

    it("disables 1080p for Seedance fast", () => {
        const cap = resolveVideoCapability(baseConfig({ model: "default::seedance-1-0-pro-fast", videoModel: "default::seedance-1-0-pro-fast" }));
        expect(cap.provider).toBe("seedance");
        const ultra = cap.resolutions.find((item) => item.value === "1080p");
        expect(ultra?.disabled).toBe(true);
        const clamped = clampVideoConfigToCapability(baseConfig({ model: "default::seedance-1-0-pro-fast", videoModel: "default::seedance-1-0-pro-fast", vquality: "1080p" }));
        expect(clamped.vquality).toBe("720p");
    });

    it("locks Agnes to fixed size and 2/5s", () => {
        const cap = resolveVideoCapability(baseConfig({ model: "default::agnes-video-v2.0", videoModel: "default::agnes-video-v2.0", baseUrl: "https://agnes.example" }));
        // detection also works by model name
        const byName = resolveVideoCapability(baseConfig({ model: "agnes-video-v2.0", videoModel: "agnes-video-v2.0" }));
        expect(byName.provider).toBe("agnes");
        expect(byName.seconds.map((item) => item.value)).toEqual(["2", "5"]);
        const clamped = clampVideoConfigToCapability(baseConfig({ model: "agnes-video-v2.0", videoModel: "agnes-video-v2.0", videoSeconds: "12", size: "9:16" }));
        expect(clamped.size).toBe("1152x768");
        expect(clamped.videoSeconds).toBe("2");
        void cap;
    });

    it("exposes Veo 4/6/8 seconds", () => {
        const cap = resolveVideoCapability(baseConfig({ model: "default::veo-3.1", videoModel: "default::veo-3.1" }));
        expect(cap.provider).toBe("veo");
        expect(cap.seconds.map((item) => item.value)).toEqual(["4", "6", "8"]);
    });
});

describe("resolveImageCapability", () => {
    it("uses Grok aspect ratios without fake 4k size pills", () => {
        const cap = resolveImageCapability(baseConfig({ model: "default::grok-imagine-image", imageModel: "default::grok-imagine-image" }));
        expect(cap.provider).toBe("grok");
        expect(cap.aspects.map((item) => item.value)).toContain("9:16");
        expect(cap.aspects.map((item) => item.value)).not.toContain("3840x2160");
        expect(cap.transparentBackground).toBe(false);
        expect(cap.card.fields.some((field) => field.label === "输出规格")).toBe(true);
    });

    it("keeps OpenAI quality pills and transparent background", () => {
        const cap = resolveImageCapability(baseConfig({ model: "default::gpt-image-2", imageModel: "default::gpt-image-2" }));
        expect(cap.provider).toBe("openai");
        expect(cap.qualities.map((item) => item.value)).toEqual(["auto", "high", "medium", "low"]);
        expect(cap.transparentBackground).toBe(true);
    });

    it("clamps image count and drops transparent when unsupported", () => {
        const clamped = clampImageConfigToCapability(
            baseConfig({
                model: "default::grok-imagine-image",
                imageModel: "default::grok-imagine-image",
                count: "99",
                background: "transparent",
                size: "3840x2160",
            }),
        );
        expect(Number(clamped.count)).toBeLessThanOrEqual(10);
        expect(clamped.background).toBe("");
        // 非允许像素会回退到 Grok 比例列表首项
        expect(clamped.size).toBeTruthy();
    });
});
