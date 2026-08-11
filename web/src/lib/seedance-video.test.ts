import { describe, expect, it } from "vitest";
import {
    isSeedanceOpenAiVideoModel,
    seedancePixelSize,
    seedanceRelayWorkbenchImageLabel,
    seedanceVideoReferenceError,
} from "./seedance-video";
import type { ReferenceVideo } from "@/types/media";

function video(partial: Partial<ReferenceVideo> & Pick<ReferenceVideo, "id">): ReferenceVideo {
    return {
        name: partial.name || "clip.mp4",
        type: partial.type || "video/mp4",
        url: partial.url || "blob:test",
        ...partial,
    };
}

describe("seedanceVideoReferenceError", () => {
    it("accepts common 720x480 / 1080p / 4K clips that the old pixel-total check rejected", () => {
        expect(seedanceVideoReferenceError([video({ id: "a", width: 720, height: 480, durationMs: 4000 })])).toBe("");
        expect(seedanceVideoReferenceError([video({ id: "b", width: 1920, height: 1080, durationMs: 5000 })])).toBe("");
        expect(seedanceVideoReferenceError([video({ id: "c", width: 3840, height: 2160, durationMs: 3000 })])).toBe("");
    });

    it("still rejects extreme single-side dimensions and aspect ratios", () => {
        expect(seedanceVideoReferenceError([video({ id: "d", width: 200, height: 200 })])).toContain("300-6000");
        expect(seedanceVideoReferenceError([video({ id: "e", width: 7000, height: 1000 })])).toContain("300-6000");
        expect(seedanceVideoReferenceError([video({ id: "f", width: 1920, height: 400 })])).toContain("宽高比");
    });

    it("still rejects duration and file size limits", () => {
        expect(seedanceVideoReferenceError([video({ id: "g", durationMs: 1000 })])).toContain("2-15");
        expect(seedanceVideoReferenceError([video({ id: "h", durationMs: 8000 }), video({ id: "i", durationMs: 8000 })])).toContain("总时长");
        expect(seedanceVideoReferenceError([video({ id: "j", bytes: 60 * 1024 * 1024 })])).toContain("50MB");
    });

    it("does not invent a pixel-total error for output-table sizes", () => {
        // 2206x946 is an output preset; reference videos may be larger/smaller by total pixels.
        expect(seedanceVideoReferenceError([video({ id: "k", width: 2206, height: 946, durationMs: 4000 })])).toBe("");
        expect(seedanceVideoReferenceError([video({ id: "l", width: 640, height: 360, durationMs: 4000 })])).toBe("");
    });
});

describe("seedanceRelayWorkbenchImageLabel", () => {
    it("marks first/last for 2 images and main/supplement for 3+ on openai2api", () => {
        expect(seedanceRelayWorkbenchImageLabel(0, 1)).toBe("图片1");
        expect(seedanceRelayWorkbenchImageLabel(0, 2)).toBe("图片1·首帧");
        expect(seedanceRelayWorkbenchImageLabel(1, 2)).toBe("图片2·尾帧");
        expect(seedanceRelayWorkbenchImageLabel(0, 3)).toBe("图片1·主参考");
        expect(seedanceRelayWorkbenchImageLabel(1, 3)).toBe("图片2·补充");
        expect(seedanceRelayWorkbenchImageLabel(2, 3)).toBe("图片3·补充");
    });
});

describe("seedance2 OpenAI Video helpers", () => {
    it("only treats exact seedance2 as openai-video", () => {
        expect(isSeedanceOpenAiVideoModel("seedance2")).toBe(true);
        expect(isSeedanceOpenAiVideoModel("relay::seedance2")).toBe(true);
        expect(isSeedanceOpenAiVideoModel("doubao-seedance-2-0-260128")).toBe(false);
        expect(isSeedanceOpenAiVideoModel("seedance2-fast")).toBe(false);
    });

    it("maps resolution and ratio to OpenAI Video pixel size", () => {
        expect(seedancePixelSize("1080p", "16:9")).toBe("1920x1080");
        expect(seedancePixelSize("720p", "9:16")).toBe("720x1280");
        expect(seedancePixelSize("480p", "adaptive")).toBe("864x496");
    });
});
