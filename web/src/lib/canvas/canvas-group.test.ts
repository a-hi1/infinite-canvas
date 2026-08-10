import { describe, expect, it } from "vitest";

import {
    collectGroupableMemberIds,
    createGroupFromSelection,
    resolveUngroupTargetIds,
    ungroupSelection,
} from "@/lib/canvas/canvas-group";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

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

describe("createGroupFromSelection", () => {
    it("creates a frame that fits members with padding and assigns groupId", () => {
        const nodes = [
            node("a", CanvasNodeType.Image, { position: { x: 100, y: 100 }, width: 100, height: 80 }),
            node("b", CanvasNodeType.Image, { position: { x: 250, y: 180 }, width: 100, height: 80 }),
            node("c", CanvasNodeType.Image, { position: { x: 900, y: 900 } }),
        ];

        const result = createGroupFromSelection(nodes, ["a", "b"], {
            createId: () => "g-new",
            padding: 40,
            topChrome: 30,
        });

        expect(result).not.toBeNull();
        expect(result!.groupId).toBe("g-new");
        expect(result!.memberIds.sort()).toEqual(["a", "b"]);

        const group = result!.nodes.find((n) => n.id === "g-new")!;
        expect(group.type).toBe(CanvasNodeType.Group);
        // minX=100, minY=100, maxX=350, maxY=260
        expect(group.position).toEqual({ x: 60, y: 30 }); // 100-40, 100-40-30
        expect(group.width).toBe(350 - 100 + 80); // 330
        expect(group.height).toBe(260 - 100 + 80 + 30); // 270

        const a = result!.nodes.find((n) => n.id === "a")!;
        const b = result!.nodes.find((n) => n.id === "b")!;
        expect(a.metadata?.groupId).toBe("g-new");
        expect(b.metadata?.groupId).toBe("g-new");
        expect(a.position).toEqual({ x: 100, y: 100 });
        // c untouched
        expect(result!.nodes.find((n) => n.id === "c")!.metadata?.groupId).toBeUndefined();
    });

    it("returns null when fewer than 2 groupable members", () => {
        const nodes = [node("a", CanvasNodeType.Image)];
        expect(createGroupFromSelection(nodes, ["a"])).toBeNull();
        expect(createGroupFromSelection(nodes, [])).toBeNull();
    });

    it("ignores selected group containers and pulls batch children", () => {
        const nodes = [
            node("g", CanvasNodeType.Group, { position: { x: 0, y: 0 }, width: 400, height: 300 }),
            node("root", CanvasNodeType.Image, {
                position: { x: 20, y: 20 },
                metadata: { isBatchRoot: true, batchChildIds: ["c1"] },
            }),
            node("c1", CanvasNodeType.Image, {
                position: { x: 40, y: 40 },
                metadata: { batchRootId: "root" },
            }),
            node("other", CanvasNodeType.Image, { position: { x: 200, y: 20 } }),
        ];

        const members = collectGroupableMemberIds(nodes, ["g", "root", "other"]);
        expect(members.sort()).toEqual(["c1", "other", "root"]);

        const result = createGroupFromSelection(nodes, ["g", "root", "other"], { createId: () => "g2" });
        expect(result!.memberIds.sort()).toEqual(["c1", "other", "root"]);
        expect(result!.nodes.find((n) => n.id === "c1")!.metadata?.groupId).toBe("g2");
    });
});

describe("ungroupSelection", () => {
    it("clears groupId and removes the group frame", () => {
        const nodes = [
            node("g", CanvasNodeType.Group),
            node("a", CanvasNodeType.Image, { metadata: { groupId: "g" } }),
            node("b", CanvasNodeType.Image, { metadata: { groupId: "g" } }),
            node("c", CanvasNodeType.Image, { metadata: { groupId: "other" } }),
        ];
        const next = ungroupSelection(nodes, ["g"]);
        expect(next.find((n) => n.id === "g")).toBeUndefined();
        expect(next.find((n) => n.id === "a")!.metadata?.groupId).toBeUndefined();
        expect(next.find((n) => n.id === "b")!.metadata?.groupId).toBeUndefined();
        expect(next.find((n) => n.id === "c")!.metadata?.groupId).toBe("other");
    });

    it("resolveUngroupTargetIds picks selected group or shared member groupId", () => {
        const nodes = [
            node("g", CanvasNodeType.Group),
            node("a", CanvasNodeType.Image, { metadata: { groupId: "g" } }),
            node("b", CanvasNodeType.Image, { metadata: { groupId: "g" } }),
            node("c", CanvasNodeType.Image, { metadata: { groupId: "h" } }),
        ];
        expect(resolveUngroupTargetIds(nodes, ["g"])).toEqual(["g"]);
        expect(resolveUngroupTargetIds(nodes, ["a", "b"]).sort()).toEqual(["g"]);
        // Mixed groups without selecting a group container → no single target
        expect(resolveUngroupTargetIds(nodes, ["a", "c"])).toEqual([]);
    });
});
