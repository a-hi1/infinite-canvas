import { describe, expect, it } from "vitest";

import {
    isWorkspaceDocumentFile,
    parseCsvPreview,
    renderSimpleMarkdown,
    resolveWorkspaceDocumentMime,
    summarizeDocumentText,
    workspaceDocumentExt,
    workspaceDocumentFormat,
} from "./workspace-document";

describe("workspace-document", () => {
    it("detects md/txt/csv by extension and mime", () => {
        expect(isWorkspaceDocumentFile({ name: "script.md", type: "" })).toBe(true);
        expect(isWorkspaceDocumentFile({ name: "notes.txt", type: "text/plain" })).toBe(true);
        expect(isWorkspaceDocumentFile({ name: "shots.csv", type: "text/csv" })).toBe(true);
        expect(isWorkspaceDocumentFile({ name: "photo.png", type: "image/png" })).toBe(false);
        expect(resolveWorkspaceDocumentMime("a.markdown", "")).toBe("text/markdown");
        expect(workspaceDocumentFormat("text/csv", "x.csv")).toBe("csv");
        expect(workspaceDocumentExt("text/markdown", "script")).toBe("md");
    });

    it("summarizes long text", () => {
        const long = "a".repeat(600);
        const summary = summarizeDocumentText(long, 500);
        expect(summary.endsWith("…")).toBe(true);
        expect(summary.length).toBeLessThanOrEqual(501);
    });

    it("parses simple csv with quotes", () => {
        const rows = parseCsvPreview('name,note\n"a,b","ok""yes"\nc,d');
        expect(rows[0]).toEqual(["name", "note"]);
        expect(rows[1]).toEqual(["a,b", 'ok"yes']);
        expect(rows[2]).toEqual(["c", "d"]);
    });

    it("renders markdown without raw html", () => {
        const html = renderSimpleMarkdown("# Title\n\nHello **world** and <script>x</script>");
        expect(html).toContain("ws-doc-h1");
        expect(html).toContain("<strong>world</strong>");
        expect(html).toContain("&lt;script&gt;");
        expect(html).not.toContain("<script>");
    });
});
