import { describe, expect, it } from "vitest";

import {
    buildOptimizeSystemPrompt,
    detectPromptOptimizeIntent,
    describeOptimizeIntent,
    resolvePromptOptimizeIntent,
} from "@/lib/prompt-optimize-skills";

describe("prompt optimize skills", () => {
    it("detects character scene prop and storyboard intents", () => {
        expect(detectPromptOptimizeIntent("女主半身肖像，定妆")).toBe("character");
        expect(detectPromptOptimizeIntent("海边渔港夜景，远景")).toBe("scene");
        expect(detectPromptOptimizeIntent("生锈铁锚道具特写")).toBe("prop");
        expect(detectPromptOptimizeIntent("镜头缓缓推进，中景运镜")).toBe("storyboard");
        expect(detectPromptOptimizeIntent("温暖一点")).toBe("generic");
    });

    it("respects preferred intent over auto detection", () => {
        expect(resolvePromptOptimizeIntent("女主肖像", "scene")).toBe("scene");
        expect(resolvePromptOptimizeIntent("女主肖像", "auto")).toBe("character");
    });

    it("builds image system prompt with character skill and output contract", () => {
        const system = buildOptimizeSystemPrompt({
            mode: "image",
            prompt: "角色四视图设定，渔民老人",
            contextNotes: ["保持真实皮肤质感"],
        });
        expect(system).toContain("人物/角色生产手册");
        expect(system).toContain("四视图");
        expect(system).toContain("输出契约");
        expect(system).toContain("保持真实皮肤质感");
        expect(system).not.toContain("90年代日式动画");
        expect(system).not.toContain("江洪渔港");
    });

    it("builds video system prompt with motion skill", () => {
        const system = buildOptimizeSystemPrompt({
            mode: "video",
            prompt: "女孩回头微笑",
        });
        expect(system).toContain("视频生产手册");
        expect(system).toContain("连续运动");
        expect(system).toContain("人物/角色生产手册");
        expect(detectPromptOptimizeIntent("女孩回头微笑")).toBe("character");
    });

    it("keeps text and audio free from visual production manuals", () => {
        const textSystem = buildOptimizeSystemPrompt({ mode: "text", prompt: "写一段旁白" });
        const audioSystem = buildOptimizeSystemPrompt({ mode: "audio", prompt: "温柔女声" });
        expect(textSystem).toContain("文本生成手册");
        expect(textSystem).not.toContain("人物/角色生产手册");
        expect(audioSystem).toContain("音频/旁白手册");
        expect(audioSystem).not.toContain("场景生产手册");
    });

    it("labels intents for UI copy", () => {
        expect(describeOptimizeIntent("character")).toContain("人物");
        expect(describeOptimizeIntent("generic")).toContain("通用");
    });
});
