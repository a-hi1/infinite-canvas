import { describe, expect, it } from "vitest";

import { shouldStayOnWorkspaceList } from "./workspace-preference";

describe("workspace-preference", () => {
    it("detects list/select query to skip auto-enter", () => {
        expect(shouldStayOnWorkspaceList("?list=1")).toBe(true);
        expect(shouldStayOnWorkspaceList("list=1")).toBe(true);
        expect(shouldStayOnWorkspaceList("?select=1")).toBe(true);
        expect(shouldStayOnWorkspaceList("")).toBe(false);
        expect(shouldStayOnWorkspaceList("?foo=1")).toBe(false);
    });
});
