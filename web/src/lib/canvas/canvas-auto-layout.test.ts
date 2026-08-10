import { describe, expect, it } from "vitest";

import { applyLayoutPositions, layoutCanvasNodes } from "@/lib/canvas/canvas-auto-layout";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

function node(id: string, type: CanvasNodeType, overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
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

describe("layoutCanvasNodes", () => {
    it("layers connected nodes left to right", () => {
        const nodes = [
            node("a", CanvasNodeType.Image, { position: { x: 500, y: 10 } }),
            node("b", CanvasNodeType.Image, { position: { x: 10, y: 200 } }),
            node("c", CanvasNodeType.Image, { position: { x: 10, y: 400 } }),
        ];
        const connections: CanvasConnection[] = [
            { id: "1", fromNodeId: "a", toNodeId: "b" },
            { id: "2", fromNodeId: "b", toNodeId: "c" },
        ];

        const positions = layoutCanvasNodes(nodes, connections);
        expect(positions.get("a")!.x).toBeLessThan(positions.get("b")!.x);
        expect(positions.get("b")!.x).toBeLessThan(positions.get("c")!.x);
    });

    it("keeps group children relative when moving the group unit", () => {
        const nodes = [
            node("g", CanvasNodeType.Group, { position: { x: 0, y: 0 }, width: 300, height: 200 }),
            node("child", CanvasNodeType.Image, {
                position: { x: 40, y: 50 },
                metadata: { groupId: "g" },
            }),
            node("other", CanvasNodeType.Image, { position: { x: 800, y: 0 } }),
        ];
        const connections: CanvasConnection[] = [{ id: "1", fromNodeId: "g", toNodeId: "other" }];

        const positions = layoutCanvasNodes(nodes, connections);
        const dx = positions.get("g")!.x - 0;
        const dy = positions.get("g")!.y - 0;
        expect(positions.get("child")).toEqual({ x: 40 + dx, y: 50 + dy });
    });

    it("moves batch children with their root and preserves relative offset", () => {
        const nodes = [
            node("root", CanvasNodeType.Image, {
                position: { x: 0, y: 0 },
                metadata: { isBatchRoot: true, batchChildIds: ["c1"], imageBatchExpanded: false },
            }),
            node("c1", CanvasNodeType.Image, {
                position: { x: 34, y: 14 },
                metadata: { batchRootId: "root" },
            }),
            node("next", CanvasNodeType.Image, { position: { x: 600, y: 0 } }),
        ];
        const connections: CanvasConnection[] = [{ id: "1", fromNodeId: "root", toNodeId: "next" }];

        const positions = layoutCanvasNodes(nodes, connections);
        const dx = positions.get("root")!.x - 0;
        const dy = positions.get("root")!.y - 0;
        expect(positions.get("c1")).toEqual({ x: 34 + dx, y: 14 + dy });
        expect(positions.get("next")!.x).toBeGreaterThan(positions.get("root")!.x);
    });

    it("only rearranges selected units when selectedIds is non-empty", () => {
        const nodes = [
            node("keep", CanvasNodeType.Image, { position: { x: 10, y: 10 } }),
            node("a", CanvasNodeType.Image, { position: { x: 300, y: 10 } }),
            node("b", CanvasNodeType.Image, { position: { x: 10, y: 300 } }),
        ];
        const connections: CanvasConnection[] = [{ id: "1", fromNodeId: "a", toNodeId: "b" }];

        const positions = layoutCanvasNodes(nodes, connections, { selectedIds: ["a", "b"] });
        expect(positions.has("keep")).toBe(false);
        expect(positions.has("a")).toBe(true);
        expect(positions.has("b")).toBe(true);
        expect(positions.get("a")!.x).toBeLessThan(positions.get("b")!.x);
    });

    it("aligns successor vertically near predecessor for straighter edges", () => {
        // Fan-in: two sources far apart → one sink; sink should sit near mid of sources after layout.
        const nodes = [
            node("s1", CanvasNodeType.Image, { position: { x: 0, y: 0 }, height: 100 }),
            node("s2", CanvasNodeType.Image, { position: { x: 0, y: 400 }, height: 100 }),
            node("t", CanvasNodeType.Image, { position: { x: 500, y: 900 }, height: 100 }),
        ];
        const connections: CanvasConnection[] = [
            { id: "1", fromNodeId: "s1", toNodeId: "t" },
            { id: "2", fromNodeId: "s2", toNodeId: "t" },
        ];

        const positions = layoutCanvasNodes(nodes, connections);
        const s1c = positions.get("s1")!.y + 50;
        const s2c = positions.get("s2")!.y + 50;
        const tc = positions.get("t")!.y + 50;
        const mid = (s1c + s2c) / 2;
        // Target center should be close to midpoint of sources (within a node height).
        expect(Math.abs(tc - mid)).toBeLessThan(80);
        expect(positions.get("t")!.x).toBeGreaterThan(positions.get("s1")!.x);
    });

    it("orders crossing chain by barycenter to reduce edge span", () => {
        // a→c, b→d with a/b stacked and c/d initially reversed — after layout d should be below c
        // if a is above b, so edges don't fully cross.
        const nodes = [
            node("a", CanvasNodeType.Image, { position: { x: 0, y: 0 } }),
            node("b", CanvasNodeType.Image, { position: { x: 0, y: 200 } }),
            node("c", CanvasNodeType.Image, { position: { x: 400, y: 300 } }),
            node("d", CanvasNodeType.Image, { position: { x: 400, y: 0 } }),
        ];
        const connections: CanvasConnection[] = [
            { id: "1", fromNodeId: "a", toNodeId: "c" },
            { id: "2", fromNodeId: "b", toNodeId: "d" },
        ];

        const positions = layoutCanvasNodes(nodes, connections);
        expect(positions.get("a")!.y).toBeLessThan(positions.get("b")!.y);
        expect(positions.get("c")!.y).toBeLessThan(positions.get("d")!.y);
    });

    it("applyLayoutPositions only rewrites moved nodes", () => {
        const nodes = [node("a", CanvasNodeType.Image, { position: { x: 1, y: 2 } }), node("b", CanvasNodeType.Image)];
        const next = applyLayoutPositions(nodes, new Map([["a", { x: 9, y: 8 }]]));
        expect(next[0].position).toEqual({ x: 9, y: 8 });
        expect(next[1]).toBe(nodes[1]);
    });
});
