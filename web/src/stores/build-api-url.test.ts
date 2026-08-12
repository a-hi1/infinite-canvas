import { describe, expect, it } from "vitest";
import { buildApiUrl } from "./use-config-store";

describe("buildApiUrl", () => {
    it("joins relative OpenAI paths under /v1", () => {
        expect(buildApiUrl("http://openai2api.com:3000", "/video/generations")).toBe("http://openai2api.com:3000/v1/video/generations");
        expect(buildApiUrl("http://openai2api.com:3000", "/videos")).toBe("http://openai2api.com:3000/v1/videos");
        expect(buildApiUrl("http://openai2api.com:3000", "/models")).toBe("http://openai2api.com:3000/v1/models");
        expect(buildApiUrl("http://openai2api.com:3000/v1", "/video/generations")).toBe("http://openai2api.com:3000/v1/video/generations");
    });

    it("keeps host-root vendor paths without /v1 prefix (Kling native)", () => {
        expect(buildApiUrl("http://openai2api.com:3000", "/kling/v1/videos/text2video")).toBe(
            "http://openai2api.com:3000/kling/v1/videos/text2video",
        );
        expect(buildApiUrl("http://openai2api.com:3000", "/kling/v1/videos/image2video")).toBe(
            "http://openai2api.com:3000/kling/v1/videos/image2video",
        );
        // base 已带 /v1 时也要剥掉，禁止 /v1/kling/...
        expect(buildApiUrl("http://openai2api.com:3000/v1", "/kling/v1/videos/text2video")).toBe(
            "http://openai2api.com:3000/kling/v1/videos/text2video",
        );
        expect(buildApiUrl("http://openai2api.com:3000/v1", "/kling/v1/videos/text2video")).not.toContain("/v1/kling/");
    });

    it("keeps absolute /v1 and /api paths on host root", () => {
        expect(buildApiUrl("http://example.com", "/v1/videos/abc/content")).toBe("http://example.com/v1/videos/abc/content");
        expect(buildApiUrl("http://example.com/v1", "/v1/videos/abc/content")).toBe("http://example.com/v1/videos/abc/content");
        expect(buildApiUrl("https://ark.cn-beijing.volces.com", "/api/plan/v3/contents/generations/tasks")).toBe(
            "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks",
        );
    });

    it("keeps relative Seedance contents path under existing plan base", () => {
        expect(buildApiUrl("https://ark.cn-beijing.volces.com/api/plan/v3", "/contents/generations/tasks")).toBe(
            "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks",
        );
    });
});
