import { describe, expect, it } from "vitest";

import { assetDisplayTitle, assetGenerationPrompt, assetTitleFromPrompt } from "./asset-display";

describe("asset-display", () => {
    it("builds title from prompt and keeps short prompts intact", () => {
        expect(assetTitleFromPrompt("五条悟", "生成结果 1")).toBe("五条悟");
        expect(assetTitleFromPrompt("  很长很长的提示词内容需要截断处理，确保列表可区分  ", "生成结果 1", 10)).toMatch(/…$/);
        expect(assetTitleFromPrompt("", "生成结果 1")).toBe("生成结果 1");
    });

    it("reads prompt from metadata", () => {
        expect(assetGenerationPrompt({ metadata: { prompt: "  孙悟空  " } })).toBe("孙悟空");
        expect(assetGenerationPrompt({ metadata: {} })).toBe("");
    });

    it("display title soft-replaces generic names when prompt exists", () => {
        expect(assetDisplayTitle({ title: "生成结果 1", metadata: { prompt: "黑神话悟空 定妆" } })).toBe("黑神话悟空 定妆");
        expect(assetDisplayTitle({ title: "我的角色", metadata: { prompt: "黑神话悟空 定妆" } })).toBe("我的角色");
        expect(assetDisplayTitle({ title: "生成结果 2", metadata: {} })).toBe("生成结果 2");
    });
});
