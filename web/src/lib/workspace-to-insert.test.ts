import { describe, expect, it } from "vitest";

import { WORKSPACE_ITEM_KIND } from "@/lib/cloud-domain";
import {
    isWorkspaceItemInsertable,
    matchesWorkspaceInsertFilter,
    workspaceItemMediaKind,
} from "./workspace-to-insert";

describe("workspace-to-insert", () => {
    it("classifies workspace kinds", () => {
        expect(workspaceItemMediaKind({ kind: WORKSPACE_ITEM_KIND.ASSET_IMAGE })).toBe("image");
        expect(workspaceItemMediaKind({ kind: WORKSPACE_ITEM_KIND.GEN_IMAGE })).toBe("image");
        expect(workspaceItemMediaKind({ kind: WORKSPACE_ITEM_KIND.ASSET_VIDEO })).toBe("video");
        expect(workspaceItemMediaKind({ kind: WORKSPACE_ITEM_KIND.GEN_VIDEO })).toBe("video");
        expect(workspaceItemMediaKind({ kind: WORKSPACE_ITEM_KIND.ASSET_TEXT })).toBe("text");
        expect(workspaceItemMediaKind({ kind: WORKSPACE_ITEM_KIND.ASSET_DOCUMENT })).toBe("text");
        expect(workspaceItemMediaKind({ kind: "other" })).toBe("unknown");
    });

    it("requires file for media and content for text", () => {
        expect(isWorkspaceItemInsertable({ kind: WORKSPACE_ITEM_KIND.ASSET_IMAGE, file_url: "/x" })).toBe(true);
        expect(isWorkspaceItemInsertable({ kind: WORKSPACE_ITEM_KIND.ASSET_IMAGE })).toBe(false);
        expect(isWorkspaceItemInsertable({ kind: WORKSPACE_ITEM_KIND.ASSET_TEXT, text_content: "hi" })).toBe(true);
        expect(isWorkspaceItemInsertable({ kind: WORKSPACE_ITEM_KIND.ASSET_DOCUMENT, file_url: "/d" })).toBe(true);
    });

    it("filters by insert kind", () => {
        expect(matchesWorkspaceInsertFilter({ kind: WORKSPACE_ITEM_KIND.GEN_IMAGE }, "image")).toBe(true);
        expect(matchesWorkspaceInsertFilter({ kind: WORKSPACE_ITEM_KIND.GEN_IMAGE }, "video")).toBe(false);
        expect(matchesWorkspaceInsertFilter({ kind: WORKSPACE_ITEM_KIND.ASSET_TEXT }, "text")).toBe(true);
        expect(matchesWorkspaceInsertFilter({ kind: WORKSPACE_ITEM_KIND.ASSET_TEXT }, "all")).toBe(true);
    });
});
