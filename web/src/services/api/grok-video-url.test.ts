import { describe, expect, it } from "vitest";

import { readGrokVideoUrl, unwrapGrokVideoResponse } from "@/services/api/video";

describe("readGrokVideoUrl", () => {
    it("reads official done shape video.url", () => {
        const url = readGrokVideoUrl({
            model: "grok-imagine-video",
            progress: 100,
            status: "done",
            usage: {},
            video: {
                duration: 8,
                respect_moderation: false,
                url: "https://vidgen.x.ai/video/abc123.mp4",
            },
        });
        expect(url).toBe("https://vidgen.x.ai/video/abc123.mp4");
    });

    it("returns empty when video.url is empty string (late write)", () => {
        const url = readGrokVideoUrl({
            status: "done",
            progress: 100,
            video: {
                duration: 8,
                respect_moderation: true,
                url: "",
            },
        });
        expect(url).toBe("");
    });

    it("returns empty when video.url is missing", () => {
        const url = readGrokVideoUrl({
            status: "done",
            progress: 100,
            video: {
                duration: 8,
                respect_moderation: false,
            },
        });
        expect(url).toBe("");
    });

    it("accepts protocol-relative video.url", () => {
        const url = readGrokVideoUrl({
            status: "done",
            video: { url: "//cdn.x.ai/v/out.mp4" },
        });
        expect(url).toBe("https://cdn.x.ai/v/out.mp4");
    });

    it("accepts nested data.video.url envelopes", () => {
        const unwrapped = unwrapGrokVideoResponse({
            code: 0,
            data: {
                status: "done",
                progress: 100,
                video: { url: "https://cdn.example.com/out.mp4?sig=1" },
            },
        });
        expect(readGrokVideoUrl(unwrapped)).toBe("https://cdn.example.com/out.mp4?sig=1");
    });

    it("prefers nested video.url over empty top-level url", () => {
        const url = readGrokVideoUrl({
            status: "done",
            url: "",
            video: { url: "https://vidgen.x.ai/files/ok.mp4" },
        });
        expect(url).toBe("https://vidgen.x.ai/files/ok.mp4");
    });

    it("accepts loose CDN https without video keyword", () => {
        const url = readGrokVideoUrl({
            status: "done",
            video: { url: "https://files.example-cdn.net/a/b/c?token=xyz" },
        });
        expect(url).toBe("https://files.example-cdn.net/a/b/c?token=xyz");
    });
});
