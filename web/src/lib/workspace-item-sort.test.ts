import { describe, expect, it } from "vitest";

import { ALL_FOLDERS_VALUE, WORKSPACE_UNFILED_VALUE } from "@/lib/workspace-folder";
import {
    applyLocalReorder,
    canDragReorderFolder,
    compareWorkspaceItemsInFolder,
    folderParamForReorderApi,
    moveOrderedId,
    sortWorkspaceItemsForDisplay,
    workspaceItemFolderKey,
} from "@/lib/workspace-item-sort";

describe("workspace-item-sort", () => {
    it("maps empty folder to unfiled key", () => {
        expect(workspaceItemFolderKey({ folder: "" })).toBe(WORKSPACE_UNFILED_VALUE);
        expect(workspaceItemFolderKey({ folder: "定妆" })).toBe("定妆");
    });

    it("defaults to finals-first then newest when no custom order", () => {
        const items = [
            { id: "a", folder: "定妆", is_final: false, created_at: "2026-01-02T00:00:00.000Z" },
            { id: "b", folder: "定妆", is_final: true, created_at: "2026-01-01T00:00:00.000Z" },
            { id: "c", folder: "定妆", is_final: false, created_at: "2026-01-03T00:00:00.000Z" },
        ];
        const sorted = sortWorkspaceItemsForDisplay(items, { folderFilter: "定妆" });
        expect(sorted.map((x) => x.id)).toEqual(["b", "c", "a"]);
    });

    it("uses folder_sort_order when any sibling has custom order", () => {
        const items = [
            { id: "a", folder: "定妆", folder_sort_order: 2048, is_final: true, created_at: "2026-01-03T00:00:00.000Z" },
            { id: "b", folder: "定妆", folder_sort_order: 1024, is_final: false, created_at: "2026-01-01T00:00:00.000Z" },
            { id: "c", folder: "定妆", is_final: true, created_at: "2026-01-02T00:00:00.000Z" },
        ];
        const sorted = sortWorkspaceItemsForDisplay(items, { folderFilter: "定妆" });
        // b (1024), a (2048), c (no order → MAX)
        expect(sorted.map((x) => x.id)).toEqual(["b", "a", "c"]);
        // final does not jump ahead once custom order exists
        expect(sorted[0].id).toBe("b");
    });

    it("keeps folder scopes independent in all view", () => {
        const items = [
            { id: "u1", folder: "", folder_sort_order: 1024, created_at: "2026-01-01T00:00:00.000Z" },
            { id: "d2", folder: "定妆", folder_sort_order: 2048, created_at: "2026-01-01T00:00:00.000Z" },
            { id: "d1", folder: "定妆", folder_sort_order: 1024, created_at: "2026-01-01T00:00:00.000Z" },
        ];
        const sorted = sortWorkspaceItemsForDisplay(items, { folderFilter: ALL_FOLDERS_VALUE });
        expect(sorted.map((x) => x.id)).toEqual(["d1", "d2", "u1"]);
    });

    it("applyLocalReorder only touches listed ids", () => {
        const items = [
            { id: "a", folder: "x", folder_sort_order: 1 },
            { id: "b", folder: "x", folder_sort_order: 2 },
            { id: "c", folder: "y", folder_sort_order: 9 },
        ];
        const next = applyLocalReorder(items, ["b", "a"]);
        expect(next.find((i) => i.id === "b")?.folder_sort_order).toBe(1024);
        expect(next.find((i) => i.id === "a")?.folder_sort_order).toBe(2048);
        expect(next.find((i) => i.id === "c")?.folder_sort_order).toBe(9);
    });

    it("moveOrderedId inserts before/after", () => {
        expect(moveOrderedId(["a", "b", "c"], "c", "a", true)).toEqual(["c", "a", "b"]);
        expect(moveOrderedId(["a", "b", "c"], "a", "c", false)).toEqual(["b", "c", "a"]);
    });

    it("folder param and drag gate", () => {
        expect(canDragReorderFolder(ALL_FOLDERS_VALUE)).toBe(false);
        expect(canDragReorderFolder("定妆")).toBe(true);
        expect(canDragReorderFolder(WORKSPACE_UNFILED_VALUE)).toBe(true);
        expect(folderParamForReorderApi(WORKSPACE_UNFILED_VALUE)).toBe("");
        expect(folderParamForReorderApi("定妆")).toBe("定妆");
    });

    it("compare without custom order prefers finals", () => {
        const a = { id: "a", is_final: false, created_at: "2026-01-02T00:00:00.000Z" };
        const b = { id: "b", is_final: true, created_at: "2026-01-01T00:00:00.000Z" };
        expect(compareWorkspaceItemsInFolder(a, b, { useCustomOrder: false })).toBeGreaterThan(0);
    });
});
