import { describe, expect, it } from "vitest";

import { readGrokVideoUrl, resolveGrokRelativeMediaUrl, rewriteChannelVideoContentUrl, unwrapGrokVideoResponse } from "@/services/api/video";

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

    it("resolves relative content path against channel baseUrl (codex2api shape, len≈55)", () => {
        const relative = "/v1/videos/a9668b7a-f30a-9515-985f-f8dd9d5ab7ef/content";
        expect(relative.length).toBe(55);
        const url = readGrokVideoUrl(
            {
                model: "grok-imagine-video",
                progress: 100,
                status: "done",
                video: {
                    duration: 8,
                    respect_moderation: true,
                    url: relative,
                },
            },
            "https://www.codex2api.com",
        );
        expect(url).toBe("https://www.codex2api.com/v1/videos/a9668b7a-f30a-9515-985f-f8dd9d5ab7ef/content");
    });

    it("resolves relative content path when baseUrl already ends with /v1", () => {
        const url = readGrokVideoUrl(
            {
                status: "done",
                video: { url: "/v1/videos/abc-123/content" },
            },
            "https://www.codex2api.com/v1",
        );
        expect(url).toBe("https://www.codex2api.com/v1/videos/abc-123/content");
        expect(url).not.toContain("/v1/v1/");
    });

    it("returns empty for relative path without baseUrl (legacy callers)", () => {
        const url = readGrokVideoUrl({
            status: "done",
            video: { url: "/v1/videos/abc-123/content" },
        });
        expect(url).toBe("");
    });
});

describe("resolveGrokRelativeMediaUrl", () => {
    it("joins path-relative content URLs to channel origin", () => {
        expect(resolveGrokRelativeMediaUrl("/v1/videos/task-1/content", "https://www.codex2api.com")).toBe(
            "https://www.codex2api.com/v1/videos/task-1/content",
        );
    });

    it("keeps absolute https unchanged", () => {
        expect(resolveGrokRelativeMediaUrl("https://vidgen.x.ai/v/a.mp4", "https://www.codex2api.com")).toBe(
            "https://vidgen.x.ai/v/a.mp4",
        );
    });

    it("maps same-origin /ai-proxy base to proxy prefix + path", () => {
        const resolved = resolveGrokRelativeMediaUrl("/v1/videos/task-1/content", "/ai-proxy");
        expect(resolved.includes("/ai-proxy/v1/videos/task-1/content")).toBe(true);
    });

    it("resolves openai2api relative content against :3000 base", () => {
        expect(resolveGrokRelativeMediaUrl("/v1/videos/task-oa/content", "http://openai2api.com:3000")).toBe(
            "http://openai2api.com:3000/v1/videos/task-oa/content",
        );
    });
});

describe("rewriteChannelVideoContentUrl", () => {
    it("rewrites New API ServerAddress content URL missing channel port", () => {
        const rewritten = rewriteChannelVideoContentUrl("http://openai2api.com/v1/videos/task-1/content", {
            baseUrl: "http://openai2api.com:3000",
            apiKey: "test-only",
        } as never);
        expect(rewritten).toBe("http://openai2api.com:3000/v1/videos/task-1/content");
    });

    it("rewrites relative content path against openai2api channel base", () => {
        const rewritten = rewriteChannelVideoContentUrl("/v1/videos/task-2/content", {
            baseUrl: "http://openai2api.com:3000/v1",
            apiKey: "test-only",
        } as never);
        expect(rewritten).toBe("http://openai2api.com:3000/v1/videos/task-2/content");
    });

    it("does not rewrite public vidgen CDN", () => {
        expect(
            rewriteChannelVideoContentUrl("https://vidgen.x.ai/video/abc.mp4", {
                baseUrl: "http://openai2api.com:3000",
                apiKey: "test-only",
            } as never),
        ).toBe("");
    });

    it("rewrites absolute content on wrong ServerAddress host to channel origin", () => {
        const rewritten = rewriteChannelVideoContentUrl("https://wrong-host.example/v1/videos/task-3/content", {
            baseUrl: "http://openai2api.com:3000",
            apiKey: "test-only",
        } as never);
        expect(rewritten).toBe("http://openai2api.com:3000/v1/videos/task-3/content");
    });
});
