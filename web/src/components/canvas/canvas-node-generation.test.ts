import { describe, expect, it } from "vitest";

import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

function node(id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}, title = id): CanvasNodeData {
    return {
        id,
        type,
        title,
        position: { x: 0, y: 0 },
        width: 200,
        height: 160,
        metadata,
    };
}

function edge(from: string, to: string): CanvasConnection {
    return { id: `${from}->${to}`, fromNodeId: from, toNodeId: to };
}

describe("buildNodeGenerationContext connected media", () => {
    const imageA = node("img-a", CanvasNodeType.Image, { content: "data:image/png;base64,aaa", mimeType: "image/png" });
    const imageB = node("img-b", CanvasNodeType.Image, { content: "data:image/png;base64,bbb", mimeType: "image/png" });
    const videoV = node("vid-v", CanvasNodeType.Video, {
        content: "blob:http://localhost/video",
        storageKey: "video:vid-v",
        mimeType: "video/mp4",
        durationMs: 4000,
    });
    const audioA = node("aud-a", CanvasNodeType.Audio, {
        content: "blob:http://localhost/audio",
        storageKey: "audio:aud-a",
        mimeType: "audio/mpeg",
        durationMs: 3000,
    });

    it("attaches all connected media when config has no @ tokens", () => {
        const config = node("cfg", CanvasNodeType.Config, { composerContent: "镜头推进" });
        const nodes = [config, imageA, imageB, videoV];
        const connections = [edge("img-a", "cfg"), edge("img-b", "cfg"), edge("vid-v", "cfg")];

        const context = buildNodeGenerationContext("cfg", nodes, connections, "镜头推进");
        expect(context.prompt).toBe("镜头推进");
        expect(context.referenceImages.map((item) => item.id)).toEqual(["img-a", "img-b"]);
        expect(context.referenceVideos.map((item) => item.id)).toEqual(["vid-v"]);
        expect(context.imageCount).toBe(2);
        expect(context.videoCount).toBe(1);
    });

    it("keeps unmentioned connected video/audio when prompt only @ mentions one image", () => {
        const config = node("cfg", CanvasNodeType.Config, {
            composerContent: "参考 @[node:img-a] 做运镜",
        });
        const nodes = [config, imageA, imageB, videoV, audioA];
        const connections = [edge("img-a", "cfg"), edge("img-b", "cfg"), edge("vid-v", "cfg"), edge("aud-a", "cfg")];

        const context = buildNodeGenerationContext("cfg", nodes, connections, "参考 @[node:img-a] 做运镜");
        expect(context.prompt).toContain("图片1");
        // Mentioned image first, then remaining connected images.
        expect(context.referenceImages.map((item) => item.id)).toEqual(["img-a", "img-b"]);
        expect(context.referenceVideos.map((item) => item.id)).toEqual(["vid-v"]);
        expect(context.referenceAudios.map((item) => item.id)).toEqual(["aud-a"]);
        expect(context.imageCount).toBe(2);
        expect(context.videoCount).toBe(1);
        expect(context.audioCount).toBe(1);
    });

    it("still merges plain connected inputs when source is not a config composer", () => {
        const videoNode = node("out", CanvasNodeType.Video, { prompt: "继续" });
        const nodes = [videoNode, imageA, videoV];
        const connections = [edge("img-a", "out"), edge("vid-v", "out")];
        const context = buildNodeGenerationContext("out", nodes, connections, "继续");
        expect(context.referenceImages.map((item) => item.id)).toEqual(["img-a"]);
        expect(context.referenceVideos.map((item) => item.id)).toEqual(["vid-v"]);
    });
});
