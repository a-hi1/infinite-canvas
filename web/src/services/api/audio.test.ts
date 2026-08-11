import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestAudioGeneration, requestAudioTranscription } from "@/services/api/audio";
import { defaultConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

vi.mock("axios", () => ({
    default: {
        post: vi.fn(),
        isAxiosError: vi.fn(() => false),
        isCancel: vi.fn(() => false),
    },
}));

const getMediaBlob = vi.hoisted(() => vi.fn());
vi.mock("@/services/file-storage", () => ({
    getMediaBlob,
    uploadMediaFile: vi.fn(),
}));

function audioConfig(model: string, baseUrl = "https://relay.example/v1"): AiConfig {
    const channel: ModelChannel = {
        id: "relay",
        name: "Grok relay",
        baseUrl,
        apiKey: "test-only",
        apiFormat: "openai",
        models: [model],
    };
    const qualified = `relay::${model}`;
    return {
        ...defaultConfig,
        channels: [channel],
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        models: [qualified],
        audioModels: [qualified],
        model: qualified,
        audioModel: qualified,
        transcriptionModel: qualified,
    };
}

describe("Grok audio model routing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(axios.post).mockResolvedValue({ data: new Blob(["audio"], { type: "audio/mpeg" }) });
    });

    it("uses the native xAI TTS route and payload on codex2api", async () => {
        await requestAudioGeneration(audioConfig("grok-voice-tts", "https://www.codex2api.com/v1"), "你好世界");

        expect(axios.post).toHaveBeenCalledTimes(1);
        const [url, body, options] = vi.mocked(axios.post).mock.calls[0] || [];
        expect(url).toBe("https://www.codex2api.com/v1/tts");
        expect(body).toEqual({ text: "你好世界", language: "zh", voice_id: "Ara" });
        expect(body).not.toHaveProperty("model");
        expect(body).not.toHaveProperty("input");
        expect(options).toMatchObject({ responseType: "blob", headers: { Authorization: "Bearer test-only", Accept: "audio/*, application/json" } });
    });

    it("sends the selected xAI voice instead of silently replacing it", async () => {
        const config = audioConfig("grok-voice-tts", "https://www.codex2api.com/v1");
        config.audioVoice = "Eve";

        await requestAudioGeneration(config, "hello");

        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({ voice_id: "Eve" });
    });

    it("uses the native xAI STT route and upstream model on codex2api", async () => {
        getMediaBlob.mockResolvedValue(new Blob(["wav"], { type: "audio/wav" }));
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { text: "native transcript" } });

        await expect(requestAudioTranscription(audioConfig("grok-voice-stt", "https://www.codex2api.com/v1"), "audio:test")).resolves.toBe("native transcript");
        const [url, body, options] = vi.mocked(axios.post).mock.calls[0] || [];
        expect(url).toBe("https://www.codex2api.com/v1/stt");
        expect(body).toBeInstanceOf(FormData);
        expect((body as FormData).get("model")).toBe("grok-stt");
        expect((body as FormData).get("language")).toBe("auto");
        expect((body as FormData).get("response_format")).toBeNull();
        expect(options).toMatchObject({ headers: { Authorization: "Bearer test-only", Accept: "application/json" } });
    });

    it("sends TTS models to /audio/speech", async () => {
        await requestAudioGeneration(audioConfig("grok-voice-tts"), "hello");
        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain("/audio/speech");
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({ model: "grok-voice-tts", input: "hello" });
    });

    it("rejects STT and generic voice models before a TTS request", async () => {
        await expect(requestAudioGeneration(audioConfig("grok-voice-stt"), "hello")).rejects.toThrow("不是语音合成模型");
        await expect(requestAudioGeneration(audioConfig("grok-voice-latest"), "hello")).rejects.toThrow("不是语音合成模型");
        expect(axios.post).not.toHaveBeenCalled();
    });

    it("reports a missing TTS route instead of hiding the relay capability error", async () => {
        vi.mocked(axios.isAxiosError).mockImplementation((value) => Boolean((value as { isAxiosError?: boolean })?.isAxiosError));
        const routeMissing = Object.assign(new Error("Not Found"), {
            isAxiosError: true,
            response: { status: 404, data: "Not Found" },
        });
        vi.mocked(axios.post).mockRejectedValueOnce(routeMissing);

        await expect(requestAudioGeneration(audioConfig("grok-voice-tts"), "hello")).rejects.toThrow("当前渠道未提供 /audio/speech 端点");
    });

    it("reports a missing STT route instead of probing another protocol", async () => {
        vi.mocked(axios.isAxiosError).mockImplementation((value) => Boolean((value as { isAxiosError?: boolean })?.isAxiosError));
        const routeMissing = Object.assign(new Error("Not Found"), {
            isAxiosError: true,
            response: { status: 404, data: "Not Found" },
        });
        getMediaBlob.mockResolvedValue(new Blob(["wav"], { type: "audio/wav" }));
        vi.mocked(axios.post).mockRejectedValueOnce(routeMissing);

        await expect(requestAudioTranscription(audioConfig("grok-voice-stt"), "audio:test")).rejects.toThrow("当前渠道未提供 /audio/transcriptions 端点");
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it("uploads a local blob as multipart form data and parses JSON text", async () => {
        const blob = new Blob(["wav"], { type: "audio/wav" });
        getMediaBlob.mockResolvedValue(blob);
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { text: "  hello world  " } });

        const text = await requestAudioTranscription(audioConfig("grok-voice-stt"), "audio:test");
        expect(text).toBe("hello world");
        expect(axios.post).toHaveBeenCalledTimes(1);
        const [url, body, options] = vi.mocked(axios.post).mock.calls[0] || [];
        expect(url).toContain("/audio/transcriptions");
        expect(body).toBeInstanceOf(FormData);
        expect((body as FormData).get("model")).toBe("grok-voice-stt");
        expect((body as FormData).get("response_format")).toBe("json");
        expect((body as FormData).get("file")).toBeInstanceOf(Blob);
        expect(options).toMatchObject({ headers: { Authorization: "Bearer test-only" } });
    });

    it("accepts a plain text transcription response", async () => {
        getMediaBlob.mockResolvedValue(new Blob(["audio"], { type: "audio/mpeg" }));
        vi.mocked(axios.post).mockResolvedValueOnce({ data: "plain transcript" });

        await expect(requestAudioTranscription(audioConfig("grok-voice-stt"), "audio:test")).resolves.toBe("plain transcript");
    });
});
