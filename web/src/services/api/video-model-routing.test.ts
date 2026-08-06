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
    unwrapOpenAiVideoResponseForTest,
    videoPollBudget,
    videoPluginParamsForTest,
    seedanceRelayPayloadForTest,
    seedanceCreatePathForTest,
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

describe("custom video-script params", () => {
    it("passes seconds as a number for Seedance-compatible JSON bodies", () => {
        const params = videoPluginParamsForTest({ ...defaultConfig, videoSeconds: "4", vquality: "1080", size: "16:9" });
        expect(params.seconds).toBe(4);
        expect(typeof params.seconds).toBe("number");
        expect(params.resolution).toBe("1080p");
        expect(params.ratio).toBe("16:9");
        expect(params.generateAudio).toBe(true);
    });
});

describe("native Seedance relay payload", () => {
    it("routes the OpenAI2API base URL to video/generations", () => {
        expect(seedanceCreatePathForTest({ ...defaultConfig, baseUrl: "http://openai2api.com:3000" })).toBe("/video/generations");
    });

    it("keeps Agent Plan on contents/generations/tasks", () => {
        expect(seedanceCreatePathForTest({ ...defaultConfig, baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3" })).toBe("/contents/generations/tasks");
    });

    it("uses the OpenAI-compatible body contract with numeric duration", () => {
        const payload = seedanceRelayPayloadForTest(
            { ...defaultConfig, videoSeconds: "4", vquality: "1080", size: "16:9", videoGenerateAudio: "true" },
            "sora::seedance2",
            "释放虚式茈",
        );
        expect(payload).toEqual({
            model: "seedance2",
            prompt: "释放虚式茈",
            duration: 4,
            resolution: "1080p",
            ratio: "16:9",
            generate_audio: true,
        });
        expect(typeof payload.duration).toBe("number");
    });

    it("keeps duration numeric for the relay payload when the UI stores seconds as text", () => {
        const payload = seedanceRelayPayloadForTest({ ...defaultConfig, videoSeconds: "5" }, "seedance2", "test");
        expect(payload.duration).toBe(5);
        expect(typeof payload.duration).toBe("number");
    });
});

describe("Grok video model routing", () => {
    it("keeps channel qualification when auto-switching from image model to base video (not 1.5 first)", () => {
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
        // 从图片模型切视频：基础 video 优先，1.5 不抢位
        expect(resolved.modelValue).toBe("home::grok-imagine-video");
        expect(resolved.from).toBe("grok-imagine-image-quality");
        expect(resolved.to).toBe("grok-imagine-video");
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

    it("auto-switches Veo to same-channel i2v when references are present", () => {
        const channel: ModelChannel = {
            id: "sora",
            name: "Sora Relay",
            baseUrl: "https://relay.example/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["sora-2", "veo-3.1", "veo-3.1-i2v", "veo-3.1-fast"],
        };
        const config = withChannels([channel], "sora::veo-3.1");
        const resolved = resolveVideoModelForReferences(config, config.videoModel);
        expect(resolved.switched).toBe(true);
        expect(resolved.modelValue).toBe("sora::veo-3.1-i2v");
        expect(resolved.to).toBe("veo-3.1-i2v");
    });

    it("keeps Veo i2v and Sora model selection unchanged", () => {
        const channel: ModelChannel = {
            id: "sora",
            name: "Sora Relay",
            baseUrl: "https://relay.example/v1",
            apiKey: "test-only",
            apiFormat: "openai",
            compatProfile: "auto",
            models: ["sora-2", "veo-3.1", "veo-3.1-i2v"],
        };
        const i2v = resolveVideoModelForReferences(withChannels([channel], "sora::veo-3.1-i2v"), "sora::veo-3.1-i2v");
        expect(i2v.switched).toBe(false);
        expect(i2v.modelValue).toBe("sora::veo-3.1-i2v");

        const sora = resolveVideoModelForReferences(withChannels([channel], "sora::sora-2"), "sora::sora-2");
        expect(sora.switched).toBe(false);
        expect(sora.modelValue).toBe("sora::sora-2");
    });

    it("builds only full multi-reference candidates and puts user selection before 1.5 fallback", async () => {
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
        // 用户选 video：第一个 payload 必须是 video，1.5 仅兜底
        expect(candidates[0]?.model).toBe("grok-imagine-video");
        const first15 = candidates.findIndex((payload) => payload.model === "grok-imagine-video-1.5");
        const firstUser = candidates.findIndex((payload) => payload.model === "grok-imagine-video");
        expect(firstUser).toBe(0);
        if (first15 >= 0) expect(first15).toBeGreaterThan(firstUser);
        for (const model of ["grok-imagine-video", "grok-imagine-video-1.5"]) {
            const modelPayloads = candidates.filter((payload) => payload.model === model);
            if (!modelPayloads.length) continue;
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

    it("prefers selected 1080p first for I2V and T2V (user spec before demotion)", async () => {
        expect(grokResolutionCandidates("1080p", 1, "https://www.codex2api.com/v1")).toEqual(["1080p", "720p", "480p"]);
        expect(grokResolutionCandidates("1080p", 0, "https://www.codex2api.com/v1")[0]).toBe("1080p");
        expect(grokResolutionCandidates("1080p", 1, "https://api.x.ai/v1")[0]).toBe("1080p");
        expect(grokResolutionCandidates("720p", 2, "https://www.codex2api.com/v1")).toEqual(["720p", "480p"]);
        // 只降不升：选 480 不得再试 720
        expect(grokResolutionCandidates("480p", 1, "https://www.codex2api.com/v1")).toEqual(["480p"]);

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
        // 单图 I2V：首包必须是完整用户规格，禁止无分辨率/降档抢先
        expect(candidates[0]).toMatchObject({ duration: 8, aspect_ratio: "16:9", resolution: "1080p" });
        expect(candidates[0].image || candidates[0].image_url || candidates[0].images || candidates[0].reference_images).toBeTruthy();
        // 用户规格字段变体都走完后，才允许 720p 降档
        const first1080 = candidates.findIndex((payload) => payload.resolution === "1080p");
        const first720 = candidates.findIndex((payload) => payload.resolution === "720p");
        const firstBare = candidates.findIndex((payload) => !payload.resolution && !payload.aspect_ratio && (payload.image || payload.image_url));
        expect(first1080).toBe(0);
        if (first720 >= 0) expect(first720).toBeGreaterThan(first1080);
        if (firstBare >= 0) expect(firstBare).toBeGreaterThan(first1080);
        // 所有 1080 候选应排在任何 720 之前
        const last1080 = candidates.reduce((last, payload, index) => (payload.resolution === "1080p" ? index : last), -1);
        if (first720 >= 0) expect(last1080).toBeLessThan(first720);

        const textCandidates = await buildGrokPayloadCandidates(config, config.videoModel, "纯文生", []);
        expect(textCandidates[0]).toMatchObject({ duration: 8, aspect_ratio: "16:9", resolution: "1080p" });
        // 文生不得硬塞 720p 到用户 1080 之前
        const textFirst720 = textCandidates.findIndex((payload) => payload.resolution === "720p");
        const textLast1080 = textCandidates.reduce((last, payload, index) => (payload.resolution === "1080p" ? index : last), -1);
        if (textFirst720 >= 0) expect(textLast1080).toBeLessThan(textFirst720);
    });

    it("puts full single-image user-spec body first and keeps demotion/minimal as fallback only", async () => {
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
        // 首包：完整用户规格（清晰度 + 比例 + 时长）
        expect(longCandidates[0]).toMatchObject({ duration: 4, aspect_ratio: "16:9", resolution: "720p" });
        expect(longCandidates[0].image || longCandidates[0].image_url).toBeTruthy();
        // 仍保留无分辨率/最小 body 兜底，且在用户规格之后
        const firstBare = longCandidates.findIndex((payload) => payload.duration === 4 && !payload.resolution && !payload.aspect_ratio && (payload.image || payload.image_url));
        expect(firstBare).toBeGreaterThan(0);
        // 不静默丢掉参考图
        expect(longCandidates.every((payload) => payload.image || payload.image_url || payload.images || payload.reference_images)).toBe(true);

        // 短提示词单图同样：用户规格优先，最小 body 兜底
        const shortCandidates = await buildGrokPayloadCandidates(config, config.videoModel, "短提示词跟图", references);
        expect(shortCandidates[0]).toMatchObject({ duration: 4, aspect_ratio: "16:9", resolution: "720p" });
        expect(shortCandidates.some((payload) => payload.aspect_ratio === "16:9" && payload.resolution === "720p" && payload.duration === 4)).toBe(true);
        expect(shortCandidates.some((payload) => !payload.resolution && !payload.aspect_ratio && (payload.image || payload.image_url))).toBe(true);
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

    it("ladders multi-ref resolution with user selection first so full-ref 1080p is not sliced away", async () => {
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

        const fullRef1080Index = candidates.findIndex(
            (payload) =>
                payload.resolution === "1080p" &&
                Array.isArray(payload.reference_images) &&
                (payload.reference_images as unknown[]).length === 2 &&
                typeof (payload.reference_images as unknown[])[0] === "object",
        );
        expect(fullRef1080Index).toBe(0);

        const fullRef720Index = candidates.findIndex(
            (payload) =>
                payload.resolution === "720p" &&
                Array.isArray(payload.reference_images) &&
                (payload.reference_images as unknown[]).length === 2 &&
                typeof (payload.reference_images as unknown[])[0] === "object",
        );
        // 用户 1080 规格（含字段变体）必须全部排在 720 降档之前
        const last1080 = candidates.reduce((last, payload, index) => (payload.resolution === "1080p" ? index : last), -1);
        expect(fullRef720Index).toBeGreaterThanOrEqual(0);
        expect(last1080).toBeLessThan(fullRef720Index);
        expect(fullRef720Index).toBeGreaterThan(fullRef1080Index);

        // 完整对象 1080p 应在字段风格变体之前出现
        const firstFieldStyleIndex = candidates.findIndex(
            (payload) => Array.isArray(payload.images) || Array.isArray(payload.image_urls) || (Array.isArray(payload.reference_images) && typeof (payload.reference_images as unknown[])[0] === "string"),
        );
        if (firstFieldStyleIndex >= 0) {
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
        // 首包必须完整用户规格：时长 + 比例 + 清晰度
        expect(jsonCandidates[0]).toMatchObject({ duration: 10, aspect_ratio: "9:16", resolution: "720p" });
        const firstWithResolution = jsonCandidates.findIndex((payload) => payload.resolution === "720p");
        const firstWithoutResolution = jsonCandidates.findIndex((payload) => payload.resolution == null);
        expect(firstWithResolution).toBe(0);
        if (firstWithoutResolution >= 0) expect(firstWithoutResolution).toBeGreaterThan(firstWithResolution);
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

describe("Sora/Veo poll unwrap + budget (timeout fix)", () => {
    it("merges nested data layers so status/video_url are not lost when outer only has id", () => {
        // 对齐 veo-sora 脚本：state.data.data.status / video_url
        const video = unwrapOpenAiVideoResponseForTest({
            code: 0,
            data: {
                id: "task_outer",
                data: {
                    status: "completed",
                    video_url: "https://cdn.example.com/out.mp4",
                },
            },
        });
        expect(video.id).toBe("task_outer");
        expect(video.status).toBe("completed");
        expect(video.video_url).toBe("https://cdn.example.com/out.mp4");
    });

    it("allows poll responses without id when fallbackId is provided", () => {
        const video = unwrapOpenAiVideoResponseForTest(
            { code: "success", data: { status: "succeeded", url: "https://cdn.example.com/a.mp4" } },
            { allowMissingId: true, fallbackId: "created_id_1" },
        );
        expect(video.id).toBe("created_id_1");
        expect(video.status).toBe("succeeded");
        expect(video.url || video.video_url).toBe("https://cdn.example.com/a.mp4");
    });

    it("treats progress 100 as completed status signal", () => {
        const video = unwrapOpenAiVideoResponseForTest({
            id: "p1",
            progress: 100,
            result_url: "https://cdn.example.com/p.mp4",
        });
        expect(video.status).toBe("completed");
        expect(video.result_url || video.video_url || video.url).toContain("cdn.example.com");
    });

    it("gives Sora/Veo ~15min budget and keeps Grok shorter cadence", () => {
        const sora = videoPollBudget({ provider: "openai", model: "sora-2", requestModel: "sora-2" });
        expect(sora.isSoraVeo).toBe(true);
        expect(sora.maxAttempts).toBe(300);
        expect(sora.delayMs).toBe(3000);

        const veo = videoPollBudget({ provider: "openai", model: "channel::veo-3.1", requestModel: "veo-3.1" });
        expect(veo.isSoraVeo).toBe(true);
        expect(veo.maxAttempts).toBeGreaterThanOrEqual(200);

        const grok = videoPollBudget({ provider: "grok", model: "grok-imagine-video" });
        expect(grok.isSoraVeo).toBe(false);
        expect(grok.maxAttempts).toBe(120);
        expect(grok.delayMs).toBe(5000);

        const generic = videoPollBudget({ provider: "openai", model: "some-other-video" });
        expect(generic.isSoraVeo).toBe(false);
        expect(generic.maxAttempts).toBe(120);
    });
});
