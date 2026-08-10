import { describe, expect, it } from "vitest";

import { CANVAS_LOCATE_MAX_ZOOM, centerViewportOnNode, filterCanvasNavigationNodes, fitViewportScaleForNode, listCanvasNavigationNodes } from "@/lib/canvas/canvas-node-list";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function node(id: string, type = CanvasNodeType.Image, overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return {
        id,
        type,
        title: id,
        position: { x: 0, y: 0 },
        width: 100,
        height: 80,
        ...overrides,
    };
}

describe("listCanvasNavigationNodes", () => {
    it("includes regular nodes and hides children of collapsed image batches", () => {
        const nodes = [
            node("regular"),
            node("root", CanvasNodeType.Image, { metadata: { imageBatchExpanded: false, batchChildIds: ["child"] } }),
            node("child", CanvasNodeType.Image, { metadata: { batchRootId: "root" } }),
        ];

        expect(listCanvasNavigationNodes(nodes).map((item) => item.id)).toEqual(["regular", "root"]);
    });

    it("includes children of expanded batches and orphaned children", () => {
        const nodes = [
            node("root", CanvasNodeType.Image, { metadata: { imageBatchExpanded: true } }),
            node("child", CanvasNodeType.Image, { metadata: { batchRootId: "root" } }),
            node("orphan", CanvasNodeType.Image, { metadata: { batchRootId: "missing" } }),
        ];

        expect(listCanvasNavigationNodes(nodes).map((item) => item.id)).toEqual(["root", "child", "orphan"]);
    });
});

describe("filterCanvasNavigationNodes", () => {
    const nodes = [
        node("hero", CanvasNodeType.Image, { title: "主视觉", metadata: { prompt: "Coastal sunrise" } }),
        node("copy", CanvasNodeType.Text, { title: "说明文字", metadata: { content: "百年渔火纪念" } }),
        node("config", CanvasNodeType.Config, { title: "生成配置", metadata: { composerContent: " cinematic   lighting " } }),
    ];

    it("searches display titles, prompts, text content and normalized whitespace", () => {
        expect(filterCanvasNavigationNodes(nodes, " coastal  sunrise ").map((item) => item.id)).toEqual(["hero"]);
        expect(filterCanvasNavigationNodes(nodes, "渔火").map((item) => item.id)).toEqual(["copy"]);
        expect(filterCanvasNavigationNodes(nodes, "CINEMATIC LIGHTING").map((item) => item.id)).toEqual(["config"]);
    });

    it("combines type filtering with search", () => {
        expect(filterCanvasNavigationNodes(nodes, "生成", CanvasNodeType.Config).map((item) => item.id)).toEqual(["config"]);
        expect(filterCanvasNavigationNodes(nodes, "生成", CanvasNodeType.Image)).toEqual([]);
    });
});

describe("fitViewportScaleForNode", () => {
    it("caps locate zoom at 100% by default", () => {
        const tiny = node("tiny", CanvasNodeType.Image, { width: 40, height: 30 });
        expect(fitViewportScaleForNode(tiny, { width: 1200, height: 800 })).toBe(CANVAS_LOCATE_MAX_ZOOM);
        expect(CANVAS_LOCATE_MAX_ZOOM).toBe(1);
    });

    it("shrinks large nodes and respects left inset", () => {
        const large = node("large", CanvasNodeType.Image, { width: 2000, height: 1500 });
        const k = fitViewportScaleForNode(large, { width: 1200, height: 800 }, { leftInset: 300 });
        expect(k).toBeLessThan(1);
        expect(k).toBeGreaterThan(0.05);
        expect(k).toBeCloseTo(Math.min((900 * 0.6) / 2000, (800 * 0.6) / 1500), 5);
    });
});

describe("centerViewportOnNode", () => {
    it("centers positive and negative node coordinates while preserving zoom", () => {
        const target = node("target", CanvasNodeType.Video, {
            position: { x: -300, y: 120 },
            width: 200,
            height: 100,
        });

        expect(centerViewportOnNode(target, { x: 999, y: -999, k: 1.5 }, { width: 1000, height: 700 })).toEqual({
            x: 800,
            y: 95,
            k: 1.5,
        });
    });

    it("centers inside the visible area to the right of an open sidebar", () => {
        const target = node("target", CanvasNodeType.Image, {
            position: { x: 100, y: 50 },
            width: 200,
            height: 100,
        });

        expect(centerViewportOnNode(target, { x: 0, y: 0, k: 2 }, { width: 1200, height: 800 }, { left: 336 })).toEqual({
            x: 368,
            y: 200,
            k: 2,
        });
    });

    it("clamps invalid sidebar insets without producing non-finite coordinates", () => {
        const target = node("target", CanvasNodeType.Image);
        const negative = centerViewportOnNode(target, { x: 0, y: 0, k: 1 }, { width: 600, height: 400 }, { left: -200 });
        const oversized = centerViewportOnNode(target, { x: 0, y: 0, k: 1 }, { width: 600, height: 400 }, { left: 2000 });
        const invalid = centerViewportOnNode(target, { x: 0, y: 0, k: 1 }, { width: 600, height: 400 }, { left: Number.NaN });

        expect(negative).toEqual({ x: 250, y: 160, k: 1 });
        expect(invalid).toEqual(negative);
        expect(oversized).toEqual({ x: 549.5, y: 160, k: 1 });
        expect(Number.isFinite(oversized.x)).toBe(true);
    });
});
