import { describe, expect, it } from "vitest";

import { workbenchImagePromptReferences, workbenchVideoPromptReferences } from "@/lib/workbench-prompt-references";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

function image(id: string, name = id, dataUrl = `data:image/png;base64,${id}`): ReferenceImage {
    return { id, name, type: "image/png", dataUrl };
}

function video(id: string, name = id): ReferenceVideo {
    return { id, name, type: "video/mp4", url: `blob:${id}` };
}

function audio(id: string, name = id): ReferenceAudio {
    return { id, name, type: "audio/mpeg", url: `blob:${id}` };
}

describe("workbench prompt references adapter", () => {
    it("returns empty list when no images", () => {
        expect(workbenchImagePromptReferences([])).toEqual([]);
    });

    it("maps image workbench refs to 图片N with preview from dataUrl", () => {
        const refs = workbenchImagePromptReferences([image("a", "face"), image("b", "bg"), image("c", "prop")]);
        expect(refs.map((item) => item.label)).toEqual(["图片1", "图片2", "图片3"]);
        expect(refs[0]).toMatchObject({
            id: "a",
            nodeId: "a",
            kind: "image",
            title: "face",
            previewUrl: "data:image/png;base64,a",
            active: true,
        });
        expect(refs[1].previewUrl).toBe("data:image/png;base64,b");
    });

    it("prefers dataUrl then url for image preview", () => {
        const withUrlOnly: ReferenceImage = { id: "x", name: "remote", type: "image/png", dataUrl: "", url: "https://example.com/x.png" };
        expect(workbenchImagePromptReferences([withUrlOnly])[0].previewUrl).toBe("https://example.com/x.png");
    });

    it("maps video workbench refs in image → video → audio order with independent indexes", () => {
        const refs = workbenchVideoPromptReferences([image("i1", "img-a"), image("i2", "img-b")], [video("v1", "clip")], [audio("a1", "voice")]);
        expect(refs.map((item) => ({ kind: item.kind, label: item.label, id: item.id }))).toEqual([
            { kind: "image", label: "图片1", id: "i1" },
            { kind: "image", label: "图片2", id: "i2" },
            { kind: "video", label: "视频1", id: "v1" },
            { kind: "audio", label: "音频1", id: "a1" },
        ]);
        expect(refs[2].previewUrl).toBe("blob:v1");
        expect(refs[3].text).toBe("voice");
        expect(refs.every((item) => item.active)).toBe(true);
    });

    it("recomputes labels from current index after reorder (not frozen by id)", () => {
        const a = image("a", "first");
        const b = image("b", "second");
        expect(workbenchImagePromptReferences([a, b]).map((item) => item.label)).toEqual(["图片1", "图片2"]);
        expect(workbenchImagePromptReferences([b, a]).map((item) => [item.id, item.label])).toEqual([
            ["b", "图片1"],
            ["a", "图片2"],
        ]);
    });
});
