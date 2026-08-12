import { describe, expect, it } from "vitest";

import {
    isKlingVideoConfig,
    isKlingVideoModel,
    klingAspectRatioFromSize,
    klingModeFromQuality,
    normalizeKlingDuration,
    normalizeKlingMode,
    normalizeKlingSize,
} from "@/lib/kling-video";

describe("kling-video detection", () => {
    it.each([
        ["kling-v3", true],
        ["Kling-3.0-turbo", true],
        ["Kling-v3-omni", true],
        ["kling-video-o1", true],
        ["channel::kling-v3", true],
        ["可灵::Kling-3.0-turbo", true],
        ["grok-imagine-video", false],
        ["seedance2", false],
        ["sora-2", false],
        ["gpt-4o", false],
    ])("isKlingVideoModel(%s) → %s", (model, expected) => {
        expect(isKlingVideoModel(model)).toBe(expected);
    });

    it("isKlingVideoConfig reads model/videoModel", () => {
        expect(isKlingVideoConfig({ model: "kling-v3", videoModel: "kling-v3", baseUrl: "http://openai2api.com:3000" })).toBe(true);
        expect(isKlingVideoConfig({ model: "grok-imagine-video", videoModel: "grok-imagine-video", baseUrl: "http://openai2api.com:3000" })).toBe(false);
    });
});

describe("kling-video normalizers", () => {
    it("normalizes duration to 5 or 10", () => {
        expect(normalizeKlingDuration("")).toBe(5);
        expect(normalizeKlingDuration("5")).toBe(5);
        expect(normalizeKlingDuration("4")).toBe(5);
        expect(normalizeKlingDuration("8")).toBe(10);
        expect(normalizeKlingDuration("10")).toBe(10);
        expect(normalizeKlingDuration("15")).toBe(10);
        expect(normalizeKlingDuration(5)).toBe(5);
    });

    it("maps quality / mode", () => {
        expect(klingModeFromQuality("720")).toBe("std");
        expect(klingModeFromQuality("high")).toBe("pro");
        expect(klingModeFromQuality("1080p")).toBe("pro");
        expect(normalizeKlingMode("pro")).toBe("pro");
        expect(normalizeKlingMode("std")).toBe("std");
    });

    it("maps size to pixel + aspect", () => {
        expect(normalizeKlingSize("16:9")).toBe("1280x720");
        expect(normalizeKlingSize("9:16")).toBe("720x1280");
        expect(normalizeKlingSize("1:1")).toBe("1024x1024");
        expect(normalizeKlingSize("1920x1080")).toBe("1280x720");
        expect(normalizeKlingSize("1080x1920")).toBe("720x1280");
        expect(klingAspectRatioFromSize("1280x720")).toBe("16:9");
        expect(klingAspectRatioFromSize("720x1280")).toBe("9:16");
        expect(klingAspectRatioFromSize("1024x1024")).toBe("1:1");
    });
});
