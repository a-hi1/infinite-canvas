import { describe, expect, it } from "vitest";

import {
    grokResolutionPixelHeight,
    grokResolutionShortfallMessage,
    inferVideoResolutionLabel,
    isGrokVideoConfig,
    isGrokVideoModel,
    normalizeGrokResolution,
    videoResolutionDisplay,
} from "@/lib/grok-video";

describe("Grok video model routing", () => {
    it.each([
        ["grok-imagine-video", true],
        ["grok-imagine-video-1.5", true],
        ["grok-imagine-image", false],
        ["grok-imagine-edit", false],
        ["grok-voice-stt", false],
        ["grok", false],
    ])("classifies %s as video=%s regardless of host", (model, expected) => {
        expect(isGrokVideoModel(model)).toBe(expected);
        expect(isGrokVideoConfig({ model, videoModel: model, baseUrl: "https://api.x.ai/v1" })).toBe(expected);
    });
});

describe("video resolution display", () => {
    it("maps short side to p labels", () => {
        expect(inferVideoResolutionLabel(1920, 1080)).toBe("1080p");
        expect(inferVideoResolutionLabel(1080, 1920)).toBe("1080p");
        expect(inferVideoResolutionLabel(1280, 720)).toBe("720p");
        expect(inferVideoResolutionLabel(854, 480)).toBe("480p");
        expect(inferVideoResolutionLabel(400, 300)).toBe("400×300");
        expect(inferVideoResolutionLabel(0, 0)).toBe("");
    });

    it("marks mismatch when selected 1080p but file is 720p", () => {
        const display = videoResolutionDisplay("1080p", 1280, 720);
        expect(display.mismatched).toBe(true);
        expect(display.requestedLabel).toBe("1080p");
        expect(display.actualLabel).toBe("720p");
        expect(display.pixelLabel).toBe("1280×720");
    });

    it("is matched for true 1080p", () => {
        const display = videoResolutionDisplay("1080", 1920, 1080, "1080p");
        expect(display.mismatched).toBe(false);
        expect(display.actualLabel).toBe("1080p");
    });
});

describe("grokResolutionShortfallMessage", () => {
    it("normalizes UI bare numbers and high/low aliases", () => {
        expect(normalizeGrokResolution("1080")).toBe("1080p");
        expect(normalizeGrokResolution("high")).toBe("1080p");
        expect(grokResolutionPixelHeight("1080")).toBe(1080);
    });

    it("warns when requested 1080p but delivered ~480-class pixels", () => {
        const message = grokResolutionShortfallMessage("1080p", 736, 400);
        expect(message).toContain("1080p");
        expect(message).toContain("736");
        expect(message).toContain("400");
        expect(message).toContain("请求也按");
    });

    it("warns when requested 1080p but delivered 720p", () => {
        const message = grokResolutionShortfallMessage("1080", 1280, 720);
        expect(message).toContain("1080p");
        expect(message).toMatch(/1280|720/);
    });

    it("warns when create demoted from 1080p to 720p even if dims unknown", () => {
        const message = grokResolutionShortfallMessage("1080p", 0, 0, "720p");
        expect(message).toContain("1080p");
        expect(message).toContain("720p");
        expect(message).toContain("降档");
    });

    it("mentions create demotion when dims also short", () => {
        const message = grokResolutionShortfallMessage("1080p", 736, 400, "720p");
        expect(message).toContain("降档");
        expect(message).toContain("720p");
        expect(message).toContain("736");
    });

    it("accepts true 1080p landscape and portrait", () => {
        expect(grokResolutionShortfallMessage("1080p", 1920, 1080)).toBe("");
        expect(grokResolutionShortfallMessage("1080p", 1080, 1920)).toBe("");
        expect(grokResolutionShortfallMessage("1080p", 1912, 1080)).toBe("");
        // 创建也按 1080 成功且尺寸达标 → 不提示
        expect(grokResolutionShortfallMessage("1080p", 1920, 1080, "1080p")).toBe("");
    });

    it("does not warn when requested 720p and delivered 720p", () => {
        expect(grokResolutionShortfallMessage("720p", 1280, 720)).toBe("");
        expect(grokResolutionShortfallMessage("720", 720, 1280)).toBe("");
    });

    it("skips judgment when dimensions are missing and no demotion", () => {
        expect(grokResolutionShortfallMessage("1080p", 0, 0)).toBe("");
        expect(grokResolutionShortfallMessage("1080p")).toBe("");
    });
});
