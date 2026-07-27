import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestEdit } from "@/services/api/image";
import { defaultConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

vi.mock("axios", () => ({
    default: {
        post: vi.fn(),
        isAxiosError: vi.fn(() => false),
        isCancel: vi.fn(() => false),
    },
}));

vi.mock("@/lib/image-utils", () => ({
    compressImageDataUrl: vi.fn(async (value: string) => value),
    dataUrlToFile: vi.fn(),
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

describe("Grok image edit request routing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("window", globalThis);
        vi.mocked(axios.post).mockResolvedValue({ data: { data: [{ b64_json: "a".repeat(80) }] } });
    });

    it("posts the auto-selected edit model first when inventory only lists quality", async () => {
        await requestEdit(grokConfig(), "edit this", [
            {
                id: "reference",
                name: "reference.png",
                type: "image/png",
                dataUrl: "data:image/png;base64,reference",
            },
        ]);

        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({
            model: "grok-imagine-image-edit",
            image: { url: "data:image/png;base64,reference" },
        });
    });
});
