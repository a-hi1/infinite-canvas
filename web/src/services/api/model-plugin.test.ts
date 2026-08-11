import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { PLUGIN_TEMPLATES, runModelPlugin } from "@/services/api/model-plugin";

vi.mock("axios", () => ({
    default: {
        request: vi.fn(),
        isAxiosError: vi.fn((error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError)),
        isCancel: vi.fn(() => false),
    },
}));

function pluginConfig(overrides: Partial<AiConfig> = {}): AiConfig {
    return {
        ...defaultConfig,
        baseUrl: "http://openai2api.com:3000",
        apiKey: "test-only-key",
        model: "seedance2",
        videoModel: "seedance2",
        ...overrides,
    };
}

function requestMock() {
    return vi.mocked(axios.request);
}

async function runVideoScript(script: string, config = pluginConfig()) {
    return runModelPlugin({
        capability: "video",
        script,
        config,
        prompt: "cinematic test",
        params: { seconds: 6, size: "1280x720", ratio: "16:9" },
    });
}

describe("model plugin OpenAI video compatibility", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("fetch", vi.fn(() => {
            throw new Error("unexpected network call");
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("uses one /v1 for the relative OpenAI video template", async () => {
        requestMock()
            .mockResolvedValueOnce({ data: { id: "task-1" } })
            .mockResolvedValueOnce({ data: { id: "task-1", status: "completed", video_url: "https://cdn.example/task-1.mp4" } });

        const result = await runVideoScript(PLUGIN_TEMPLATES.video[0].script);

        expect(result).toEqual({ url: "https://cdn.example/task-1.mp4" });
        expect(requestMock()).toHaveBeenCalledTimes(2);
        expect(requestMock().mock.calls[0]?.[0]).toMatchObject({
            method: "post",
            url: "http://openai2api.com:3000/v1/videos",
            headers: { Authorization: "Bearer test-only-key", "Content-Type": "application/json" },
            data: { model: "seedance2", prompt: "cinematic test", seconds: 6, size: "1280x720" },
        });
    });

    it("does not duplicate /v1 when the configured base already contains it", async () => {
        requestMock()
            .mockResolvedValueOnce({ data: { id: "task-2" } })
            .mockResolvedValueOnce({ data: { id: "task-2", status: "completed", url: "https://cdn.example/task-2.mp4" } });

        const result = await runVideoScript(PLUGIN_TEMPLATES.video[0].script, pluginConfig({ baseUrl: "http://openai2api.com:3000/v1" }));

        expect(result).toEqual({ url: "https://cdn.example/task-2.mp4" });
        expect(requestMock().mock.calls[0]?.[0]).toMatchObject({ url: "http://openai2api.com:3000/v1/videos" });
        expect(String(requestMock().mock.calls[0]?.[0]?.url)).not.toContain("/v1/v1/");
    });

    it("keeps a legacy absolute script URL compatible with a versioned base", async () => {
        requestMock()
            .mockResolvedValueOnce({ data: { id: "task-3" } })
            .mockResolvedValueOnce({ data: { id: "task-3", status: "completed", result_url: "https://cdn.example/task-3.mp4" } });

        const result = await runVideoScript(
            `const task = await request({ method: "post", url: \`${"${baseUrl}"}/v1/videos\`, headers: { Authorization: \`Bearer \${apiKey}\` }, data: { model, prompt, seconds: params.seconds } });
return await poll(() => request({ method: "get", url: \`${"${baseUrl}"}/v1/videos/\${task.id}\`, headers: { Authorization: \`Bearer \${apiKey}\` } }), (state) => state.status === "completed" ? { url: state.result_url } : null, { intervalMs: 500 });`,
            pluginConfig({ baseUrl: "http://openai2api.com:3000/v1" }),
        );

        expect(result).toEqual({ url: "https://cdn.example/task-3.mp4" });
        expect(requestMock().mock.calls[0]?.[0]).toMatchObject({ url: "http://openai2api.com:3000/v1/videos" });
    });

    it("keeps unrelated absolute script URLs unchanged", async () => {
        requestMock().mockResolvedValueOnce({ data: { id: "external-task" } }).mockResolvedValueOnce({ data: { status: "completed", url: "https://cdn.example/external.mp4" } });

        const result = await runVideoScript(`const task = await request({ method: "post", url: "https://other.example/v1/videos", headers: { Authorization: \`Bearer \${apiKey}\` }, data: { model, prompt, seconds: params.seconds } });
return await poll(() => request({ method: "get", url: \"https://other.example/v1/videos/external-task\", headers: { Authorization: \`Bearer \${apiKey}\` } }), (state) => state.status === "completed" ? { url: state.url } : null, { intervalMs: 500 });`, pluginConfig({ baseUrl: "http://openai2api.com:3000/v1" }));

        expect(result).toEqual({ url: "https://cdn.example/external.mp4" });
        expect(requestMock().mock.calls[0]?.[0]).toMatchObject({ url: "https://other.example/v1/videos" });
    });
    it("uses the template for nested envelopes and stops on a failed task", async () => {
        requestMock()
            .mockResolvedValueOnce({ data: { data: { task_id: "nested-task" } } })
            .mockResolvedValueOnce({ data: { data: { status: "failed", error: { message: "upstream rejected seedance2" } } } });

        await expect(runVideoScript(PLUGIN_TEMPLATES.video[0].script)).rejects.toThrow("upstream rejected seedance2");
        expect(requestMock()).toHaveBeenCalledTimes(2);
    });

    it("explains the default-group seedance2 mismatch without retrying", async () => {
        const upstreamError = Object.assign(new Error("Request failed with status code 503"), {
            isAxiosError: true,
            response: {
                status: 503,
                data: { error: { code: "model_not_found", message: "No available channel for model seedance2 under group default (distributor)" } },
            },
        });
        requestMock().mockRejectedValueOnce(upstreamError);

        await expect(runVideoScript(`return await request({ method: "post", url: "/videos", headers: { Authorization: \`Bearer \${apiKey}\` }, data: { model, prompt, seconds: params.seconds } });`)).rejects.toThrow(
            "seedance2 under group default (distributor) (status=503)。请求已到达中转站",
        );
        expect(requestMock()).toHaveBeenCalledTimes(1);
    });

    it("sends reference images with the OpenAI video template", async () => {
        requestMock()
            .mockResolvedValueOnce({ data: { id: "task-img" } })
            .mockResolvedValueOnce({ data: { id: "task-img", status: "completed", video_url: "https://cdn.example/img.mp4" } });

        const result = await runModelPlugin({
            capability: "video",
            script: PLUGIN_TEMPLATES.video[0].script,
            config: pluginConfig(),
            prompt: "with refs",
            images: ["data:image/png;base64,aaa", "data:image/png;base64,bbb"],
            params: { seconds: 5, size: "1280x720", ratio: "16:9", generateAudio: true, watermark: false },
        });

        expect(result).toEqual({ url: "https://cdn.example/img.mp4" });
        expect(requestMock().mock.calls[0]?.[0]).toMatchObject({
            method: "post",
            url: "http://openai2api.com:3000/v1/videos",
            data: {
                model: "seedance2",
                prompt: "with refs",
                seconds: 5,
                size: "1280x720",
                images: ["data:image/png;base64,aaa", "data:image/png;base64,bbb"],
                first_frame: "data:image/png;base64,aaa",
                last_frame: "data:image/png;base64,bbb",
            },
        });
    });

    it("falls back to /videos/{id}/content when completed without a URL", async () => {
        const blob = new Blob(["video-bytes"], { type: "video/mp4" });
        requestMock()
            .mockResolvedValueOnce({ data: { id: "task-blob" } })
            .mockResolvedValueOnce({ data: { id: "task-blob", status: "completed" } })
            .mockResolvedValueOnce({ data: blob });

        const result = await runVideoScript(PLUGIN_TEMPLATES.video[0].script);
        expect(result).toBe(blob);
        expect(requestMock()).toHaveBeenCalledTimes(3);
        expect(requestMock().mock.calls[2]?.[0]).toMatchObject({
            method: "get",
            url: "http://openai2api.com:3000/v1/videos/task-blob/content",
            responseType: "blob",
        });
    });
});
