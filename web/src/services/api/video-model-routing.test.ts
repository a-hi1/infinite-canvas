import { describe, expect, it } from "vitest";

import {
    buildGrokEditPayloadCandidates,
    buildGrokPayloadCandidates,
    grokCreatePathCandidates,
    grokEditPathCandidates,
    grokPollPathTemplates,
    grokResolutionCandidates,
    isGrokRateLimitError,
    isRetryableGrokPayloadError,
    payloadKeepsAllGrokVideoReferences,
    readGrokTaskId,
    resolveVideoModelForReferences,
    unwrapGrokVideoResponse,
} from "@/services/api/video";
import { grokEditVideoReferenceError, GROK_EDIT_REFERENCE_LIMITS } from "@/lib/grok-video";
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
        // 内网 New API + Grok：只走 /video/generations（可兜底 /videos），跳过不存在的 /videos/generations
        expect(grokCreatePathCandidates(newApi, 0, "home::grok-imagine-video")[0]).toBe("/video/generations");
        expect(grokCreatePathCandidates(newApi, 2, "home::grok-imagine-video")).toEqual(["/video/generations", "/videos"]);
        expect(grokCreatePathCandidates(newApi, 2, "home::grok-imagine-video")).not.toContain("/videos/generations");
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

    it("puts user aspect_ratio and duration first for pure-text and multi-ref Grok candidates", async () => {
        const channel: ModelChannel = {
            id: "relay",
            name: "codex2api",
            baseUrl: "https://www.codex2api.com/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-video"],
        };
        const config = {
            ...withChannels([channel], "relay::grok-imagine-video"),
            videoSeconds: "12",
            size: "9:16",
            vquality: "720p",
        };

        const textCandidates = await buildGrokPayloadCandidates(config, config.videoModel, "竖屏吃饭", []);
        expect(textCandidates[0]).toMatchObject({ duration: 12, aspect_ratio: "9:16" });
        expect(textCandidates.some((payload) => payload.aspect_ratio === "9:16" && payload.duration === 12)).toBe(true);
        // 无比例的兜底仍可存在，但不能抢在用户参数之前
        const firstBareDuration = textCandidates.findIndex((payload) => payload.duration === 12 && payload.aspect_ratio == null && payload.size == null);
        const firstWithRatio = textCandidates.findIndex((payload) => payload.aspect_ratio === "9:16");
        expect(firstWithRatio).toBe(0);
        if (firstBareDuration >= 0) expect(firstBareDuration).toBeGreaterThan(firstWithRatio);

        const references = ["a", "b"].map((id) => ({
            id,
            name: `${id}.png`,
            type: "image/png",
            dataUrl: `https://example.com/${id}.png`,
        }));
        const multiCandidates = await buildGrokPayloadCandidates(config, config.videoModel, "双图竖屏", references);
        expect(multiCandidates.length).toBeGreaterThan(0);
        expect(multiCandidates.every((payload) => payload.duration === 12 || payload.seconds === "12" || payload.seconds === 12)).toBe(true);
        expect(multiCandidates.some((payload) => payload.aspect_ratio === "9:16" && payload.duration === 12)).toBe(true);
        // 不再静默截断到 8s
        expect(multiCandidates.every((payload) => payload.duration !== 8)).toBe(true);
    });

    it("prefers 720p before 1080p for I2V on fragile relays so reference images are not dropped", async () => {
        expect(grokResolutionCandidates("1080p", 1, "https://www.codex2api.com/v1")).toEqual(["720p", "1080p", "480p"]);
        expect(grokResolutionCandidates("1080p", 0, "https://www.codex2api.com/v1")[0]).toBe("1080p");
        expect(grokResolutionCandidates("1080p", 1, "https://api.x.ai/v1")[0]).toBe("1080p");
        expect(grokResolutionCandidates("720p", 2, "https://www.codex2api.com/v1")[0]).toBe("720p");

        const channel: ModelChannel = {
            id: "relay",
            name: "codex2api",
            baseUrl: "https://www.codex2api.com/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-video"],
        };
        const config = {
            ...withChannels([channel], "relay::grok-imagine-video"),
            videoSeconds: "8",
            size: "16:9",
            vquality: "1080p",
        };
        const references = [
            {
                id: "a",
                name: "a.png",
                type: "image/png",
                dataUrl: "https://example.com/a.png",
            },
        ];
        const candidates = await buildGrokPayloadCandidates(config, config.videoModel, "跟图走", references);
        // 单图 I2V 最小 body 优先，无 resolution；带分辨率的候选里 720p 须早于 1080p
        const firstWithResolution = candidates.find((payload) => payload.resolution && (payload.image || payload.image_url || payload.images || payload.reference_images));
        expect(firstWithResolution).toBeTruthy();
        expect(firstWithResolution?.resolution).toBe("720p");
        expect(candidates.some((payload) => payload.resolution === "1080p" && (payload.image || payload.image_url || payload.images || payload.reference_images))).toBe(true);

        const textCandidates = await buildGrokPayloadCandidates(config, config.videoModel, "纯文生", []);
        expect(textCandidates[0]?.resolution).toBe("1080p");
    });

    it("puts minimal single-image body first so full-field 400 can fall back", async () => {
        const channel: ModelChannel = {
            id: "relay",
            name: "codex2api",
            baseUrl: "https://www.codex2api.com/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-video-1.5", "grok-imagine-video"],
        };
        const config = {
            ...withChannels([channel], "relay::grok-imagine-video-1.5"),
            videoSeconds: "4",
            size: "16:9",
            vquality: "720p",
        };
        const references = [
            {
                id: "a",
                name: "a.jpg",
                type: "image/jpeg",
                dataUrl: "https://example.com/a.jpg",
            },
        ];
        const longPrompt = "静态电影定格画面，".repeat(120); // >900 chars
        expect(longPrompt.trim().length).toBeGreaterThanOrEqual(900);

        const longCandidates = await buildGrokPayloadCandidates(config, config.videoModel, longPrompt, references);
        expect(longCandidates.length).toBeGreaterThan(1);
        // 首包：最小成功面（有 image + duration，无 aspect_ratio/resolution）
        expect(longCandidates[0]).toMatchObject({ duration: 4 });
        expect(longCandidates[0].image || longCandidates[0].image_url).toBeTruthy();
        expect(longCandidates[0].aspect_ratio).toBeUndefined();
        expect(longCandidates[0].resolution).toBeUndefined();
        // 仍保留带比例/分辨率的候选
        expect(longCandidates.some((payload) => payload.aspect_ratio === "16:9" && payload.duration === 4 && payload.resolution === "720p")).toBe(true);
        // 不静默丢掉参考图
        expect(longCandidates.every((payload) => payload.image || payload.image_url || payload.images || payload.reference_images)).toBe(true);

        // 短提示词单图同样最小 body 优先（对齐同事可用路径）；比例/分辨率在后续候选
        const shortCandidates = await buildGrokPayloadCandidates(config, config.videoModel, "短提示词跟图", references);
        expect(shortCandidates[0]).toMatchObject({ duration: 4 });
        expect(shortCandidates[0].aspect_ratio).toBeUndefined();
        expect(shortCandidates[0].resolution).toBeUndefined();
        expect(shortCandidates.some((payload) => payload.aspect_ratio === "16:9" && payload.resolution === "720p" && payload.duration === 4)).toBe(true);
    });

    it("treats HTTP 200 embedded xAI 400 as create failure and retries next payload", () => {
        expect(() =>
            unwrapGrokVideoResponse({
                error: { message: "xAI upstream returned status 400", type: "invalid_request_error" },
            } as never),
        ).toThrow(/xAI upstream returned status 400/);

        // 已有 request_id 的失败任务不能当创建错误抛（轮询态）
        expect(
            unwrapGrokVideoResponse({
                request_id: "req_1",
                status: "failed",
                error: { message: "generation failed" },
            } as never),
        ).toMatchObject({ request_id: "req_1" });

        expect(isRetryableGrokPayloadError(new Error("xAI upstream returned status 400"))).toBe(true);
        expect(isRetryableGrokPayloadError(new Error("Grok 视频接口没有返回 request_id"))).toBe(true);
        expect(isRetryableGrokPayloadError(new Error("鉴权失败，请检查 API Key"))).toBe(false);

        // 限流禁止换 body 刷额度
        expect(isGrokRateLimitError(new Error("Upstream rate limit exceeded, please retry later"))).toBe(true);
        expect(isRetryableGrokPayloadError(new Error("Upstream rate limit exceeded, please retry later"))).toBe(false);
        expect(() =>
            unwrapGrokVideoResponse({
                error: { message: "Upstream rate limit exceeded, please retry later", type: "rate_limit_error" },
            } as never),
        ).toThrow(/rate limit/i);
    });

    it("ladders multi-ref resolution before field-style variants so full-ref 720p is not sliced away", async () => {
        const channel: ModelChannel = {
            id: "relay",
            name: "codex2api",
            baseUrl: "https://www.codex2api.com/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-video", "grok-imagine-video-1.5"],
        };
        const config = {
            ...withChannels([channel], "relay::grok-imagine-video"),
            videoSeconds: "8",
            size: "16:9",
            vquality: "1080p",
        };
        const references = ["a", "b"].map((id) => ({
            id,
            name: `${id}.png`,
            type: "image/png",
            dataUrl: `https://example.com/${id}.png`,
        }));
        const candidates = await buildGrokPayloadCandidates(config, config.videoModel, "双图跟图", references);
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates.every((payload) => payloadKeepsAllGrokVideoReferences(payload, 2))).toBe(true);

        const fullRef720Index = candidates.findIndex(
            (payload) =>
                payload.resolution === "720p" &&
                Array.isArray(payload.reference_images) &&
                (payload.reference_images as unknown[]).length === 2,
        );
        expect(fullRef720Index).toBeGreaterThanOrEqual(0);
        expect(fullRef720Index).toBeLessThan(4);

        // 完整对象 1080p 也应在字段风格变体之前出现
        const fullRef1080Index = candidates.findIndex(
            (payload) =>
                payload.resolution === "1080p" &&
                Array.isArray(payload.reference_images) &&
                (payload.reference_images as unknown[]).length === 2,
        );
        const firstFieldStyleIndex = candidates.findIndex(
            (payload) => Array.isArray(payload.images) || Array.isArray(payload.image_urls) || (Array.isArray(payload.reference_images) && typeof (payload.reference_images as unknown[])[0] === "string"),
        );
        if (fullRef1080Index >= 0 && firstFieldStyleIndex >= 0) {
            expect(fullRef1080Index).toBeLessThan(firstFieldStyleIndex);
        }

        expect(grokCreatePathCandidates(config, 2, config.videoModel)).not.toContain("/videos/edits");
        expect(grokCreatePathCandidates(config, 2, config.videoModel)[0]).toBe("/videos/generations");
    });

    it("puts aspect_ratio first on Grok edit candidates too", async () => {
        const channel: ModelChannel = {
            id: "relay",
            name: "codex2api",
            baseUrl: "https://www.codex2api.com/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-video"],
        };
        const config = {
            ...withChannels([channel], "relay::grok-imagine-video"),
            videoSeconds: "10",
            size: "9:16",
            vquality: "720p",
        };
        const video = {
            id: "v1",
            name: "clip.mp4",
            type: "video/mp4",
            url: "https://cdn.example.com/clip.mp4",
            bytes: 1024 * 1024,
            durationMs: 4000,
        };
        const candidates = await buildGrokEditPayloadCandidates(config, config.videoModel, "改成竖屏夜晚", video);
        const jsonCandidates = candidates.filter((item): item is Record<string, unknown> => !(item instanceof FormData));
        expect(jsonCandidates[0]).toMatchObject({ duration: 10, aspect_ratio: "9:16" });
    });

    it("uses only /videos/edits for Grok single-video edit path candidates", () => {
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
        expect(grokEditPathCandidates(codex)).toEqual(["/videos/edits"]);
        expect(grokEditPathCandidates(codex)).not.toContain("/videos/generations");
        expect(grokEditPathCandidates(codex)).not.toContain("/video/generations");

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
        expect(grokEditPathCandidates(newApi)).toEqual(["/videos/edits"]);
        expect(grokCreatePathCandidates(newApi, 0, "home::grok-imagine-video")).not.toContain("/videos/edits");
    });

    it("validates Grok edit video references: single short clip only", () => {
        expect(grokEditVideoReferenceError([])).toMatch(/需要上传/);
        expect(
            grokEditVideoReferenceError([
                { id: "1", name: "a.mp4", type: "video/mp4", url: "https://example.com/a.mp4", bytes: 1024, durationMs: 5000 },
                { id: "2", name: "b.mp4", type: "video/mp4", url: "https://example.com/b.mp4", bytes: 1024, durationMs: 5000 },
            ]),
        ).toMatch(/只支持 1/);
        expect(
            grokEditVideoReferenceError([
                {
                    id: "1",
                    name: "big.mp4",
                    type: "video/mp4",
                    url: "https://example.com/big.mp4",
                    bytes: GROK_EDIT_REFERENCE_LIMITS.videoMaxBytes + 1,
                    durationMs: 5000,
                },
            ]),
        ).toMatch(/100MB/);
        expect(
            grokEditVideoReferenceError([
                { id: "1", name: "ok.mp4", type: "video/mp4", url: "https://example.com/ok.mp4", bytes: 1024, durationMs: 5000 },
            ]),
        ).toBe("");
    });

    it("builds Grok edit payloads with a single video URL field and never multi-image fields", async () => {
        const channel: ModelChannel = {
            id: "relay",
            name: "codex2api",
            baseUrl: "https://www.codex2api.com/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-video"],
        };
        const config = {
            ...withChannels([channel], "relay::grok-imagine-video"),
            videoSeconds: "8",
            size: "16:9",
            vquality: "720p",
        };
        const video = {
            id: "v1",
            name: "clip.mp4",
            type: "video/mp4",
            url: "https://cdn.example.com/clip.mp4",
            bytes: 1024 * 1024,
            durationMs: 4000,
        };
        const candidates = await buildGrokEditPayloadCandidates(config, config.videoModel, "把画面改成夜晚", video);
        // codex2api: JSON only — multipart would 415
        expect(candidates.every((item) => !(item instanceof FormData))).toBe(true);
        const jsonCandidates = candidates.filter((item): item is Record<string, unknown> => !(item instanceof FormData));
        expect(jsonCandidates.length).toBeGreaterThan(0);
        expect(
            jsonCandidates.some((payload) => {
                const v = payload.video;
                return (typeof v === "object" && v && (v as { url?: string }).url === video.url) || payload.video_url === video.url;
            }),
        ).toBe(true);
        for (const payload of jsonCandidates) {
            expect(payload).not.toHaveProperty("reference_images");
            expect(payload).not.toHaveProperty("image_urls");
            expect(Array.isArray(payload.images)).toBe(false);
        }
    });

    it("puts JSON edit candidates before any multipart on non-codex relays", async () => {
        const channel: ModelChannel = {
            id: "other",
            name: "Other Relay",
            baseUrl: "https://relay.example.com/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["grok-imagine-video"],
        };
        const config = {
            ...withChannels([channel], "other::grok-imagine-video"),
            videoSeconds: "6",
            size: "16:9",
            vquality: "720p",
        };
        const video = {
            id: "v1",
            name: "clip.mp4",
            type: "video/mp4",
            url: "https://cdn.example.com/clip.mp4",
            bytes: 1024 * 1024,
            durationMs: 4000,
        };
        const candidates = await buildGrokEditPayloadCandidates(config, config.videoModel, "改成白天", video);
        const firstFormIndex = candidates.findIndex((item) => item instanceof FormData);
        const firstJsonIndex = candidates.findIndex((item) => !(item instanceof FormData));
        expect(firstJsonIndex).toBe(0);
        if (firstFormIndex >= 0) expect(firstFormIndex).toBeGreaterThan(firstJsonIndex);
    });

    it("prefers official GET /videos/{id} poll path on codex2api and skips missing generations/{id}", () => {
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
        const templates = grokPollPathTemplates(codex);
        expect(templates[0]).toBe("/videos/{id}");
        expect(templates).toContain("/videos/generations?request_id={id}");
        expect(templates).not.toContain("/videos/generations/{id}");
        expect(templates).not.toContain("/videos/edits/{id}");
    });

    it("reads Grok task id from nested request_id fields", () => {
        expect(readGrokTaskId({ request_id: "req_a" })).toBe("req_a");
        expect(readGrokTaskId({ data: { request_id: "req_b" } })).toBe("req_b");
        expect(readGrokTaskId({ result: { id: "job_c" } })).toBe("job_c");
        expect(readGrokTaskId({ data: { task: { task_id: "task_d" } } })).toBe("task_d");
        expect(readGrokTaskId({})).toBe("");
    });
});
