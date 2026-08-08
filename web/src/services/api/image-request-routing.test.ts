import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestEdit, requestGeneration } from "@/services/api/image";
import { defaultConfig, getImageCompatStrategy, resolveChannelCompatProfile, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

vi.mock("axios", () => ({
    default: {
        post: vi.fn(),
        isAxiosError: vi.fn(() => false),
        isCancel: vi.fn(() => false),
    },
}));

vi.mock("@/lib/image-utils", () => ({
    compressImageDataUrl: vi.fn(async (value: string) => value),
    dataUrlToFile: vi.fn(() => new Blob(["image"], { type: "image/png" })),
}));

function grokConfig(): AiConfig {
    const channel: ModelChannel = {
        id: "home",
        name: "Home Grok",
        baseUrl: "/lan-ai",
        apiKey: "test-only",
        apiFormat: "openai",
        compatProfile: "grok-image",
        models: ["grok-imagine-image-quality"],
    };
    return {
        ...defaultConfig,
        channels: [channel],
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        models: ["home::grok-imagine-image-quality"],
        imageModels: ["home::grok-imagine-image-quality"],
        model: "home::grok-imagine-image-quality",
        imageModel: "home::grok-imagine-image-quality",
        count: "1",
    };
}

function openai2apiImageConfig(): AiConfig {
    const channel: ModelChannel = {
        id: "public",
        name: "openai2api",
        baseUrl: "http://openai2api.com:3000",
        apiKey: "test-only",
        apiFormat: "openai",
        compatProfile: "auto",
        models: ["gpt-image-1"],
    };
    return {
        ...defaultConfig,
        channels: [channel],
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        models: ["public::gpt-image-1"],
        imageModels: ["public::gpt-image-1"],
        model: "public::gpt-image-1",
        imageModel: "public::gpt-image-1",
        count: "1",
    };
}

describe("openai2api GPT image routing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("window", globalThis);
        vi.mocked(axios.post).mockResolvedValue({ data: { data: [{ b64_json: "a".repeat(80) }] } });
    });

    it("auto-detects openai2api as a fragile relay image profile", () => {
        expect(resolveChannelCompatProfile("http://openai2api.com:3000", "auto")).toBe("relay-fragile");
        expect(getImageCompatStrategy("http://openai2api.com:3000", "auto")).toMatchObject({
            retrySlimOnError: true,
            editFallbackFragile: true,
            includeOutputFormat: false,
        });
    });

    it("generates through /images/generations without strict output_format", async () => {
        await requestGeneration(openai2apiImageConfig(), "draw this");
        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain("/images/generations");
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({ model: "gpt-image-1", prompt: "draw this", n: 1 });
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).not.toHaveProperty("output_format");
    });

    it("keeps every image in multi-reference fallback candidates", async () => {
        const editFailure = Object.assign(new Error("unsupported multipart"), {
            isAxiosError: true,
            response: { status: 415, data: { error: { message: "unsupported multipart" } } },
        });
        vi.mocked(axios.isAxiosError).mockImplementation((value) => Boolean((value as { isAxiosError?: boolean })?.isAxiosError));
        vi.mocked(axios.post)
            .mockRejectedValueOnce(editFailure)
            .mockResolvedValueOnce({ data: { data: [{ b64_json: "a".repeat(80) }] } });

        await requestEdit(openai2apiImageConfig(), "combine both", [
            { id: "one", name: "one.png", type: "image/png", dataUrl: "data:image/png;base64,one" },
            { id: "two", name: "two.png", type: "image/png", dataUrl: "data:image/png;base64,two" },
        ]);

        expect(axios.post).toHaveBeenCalledTimes(2);
        expect(vi.mocked(axios.post).mock.calls[1]?.[0]).toContain("/images/generations");
        expect(vi.mocked(axios.post).mock.calls[1]?.[1]).toMatchObject({
            images: ["data:image/png;base64,one", "data:image/png;base64,two"],
        });
        expect(vi.mocked(axios.post).mock.calls[1]?.[1]).not.toHaveProperty("image");
    });
});

describe("Grok image edit request routing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("window", globalThis);
        vi.mocked(axios.post).mockResolvedValue({ data: { data: [{ b64_json: "a".repeat(80) }] } });
    });

    it("posts the user-selected image model first and never auto-jumps to *-edit", async () => {
        await requestEdit(grokConfig(), "edit this", [
            {
                id: "reference",
                name: "reference.png",
                type: "image/png",
                dataUrl: "data:image/png;base64,reference",
            },
        ]);

        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain("/images/edits");
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({
            model: "grok-imagine-image-quality",
            image: { url: "data:image/png;base64,reference" },
        });
        expect(JSON.stringify(vi.mocked(axios.post).mock.calls[0]?.[1])).not.toContain("grok-imagine-image-edit");
    });
});
