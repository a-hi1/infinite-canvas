/** Workspace document helpers: .md / .txt / .csv scripts & notes. */

export const WORKSPACE_DOCUMENT_EXTENSIONS = [".md", ".markdown", ".txt", ".csv"] as const;

export const WORKSPACE_DOCUMENT_ACCEPT =
    ".md,.markdown,.txt,.csv,text/markdown,text/plain,text/csv,text/x-markdown";

/** Soft client-side cap; server enforces ~2MB via API_MAX_DOCUMENT_BYTES. */
export const WORKSPACE_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

/** CSV preview rows in detail panel (header + body). */
export const WORKSPACE_DOCUMENT_CSV_PREVIEW_ROWS = 80;

export type WorkspaceDocumentFormat = "markdown" | "plain" | "csv" | "unknown";

export function documentExtFromName(filename = "") {
    const name = String(filename || "").trim();
    const idx = name.lastIndexOf(".");
    if (idx < 0) return "";
    return name.slice(idx).toLowerCase();
}

export function isWorkspaceDocumentFile(file: Pick<File, "name" | "type">) {
    const ext = documentExtFromName(file.name);
    if ((WORKSPACE_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)) return true;
    const mime = String(file.type || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
    return (
        mime === "text/markdown" ||
        mime === "text/x-markdown" ||
        mime === "text/plain" ||
        mime === "text/csv" ||
        mime === "application/csv"
    );
}

export function resolveWorkspaceDocumentMime(filename = "", declaredMime = "") {
    const ext = documentExtFromName(filename);
    if (ext === ".md" || ext === ".markdown") return "text/markdown";
    if (ext === ".txt") return "text/plain";
    if (ext === ".csv") return "text/csv";
    const mime = String(declaredMime || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
    if (mime === "text/markdown" || mime === "text/x-markdown") return "text/markdown";
    if (mime === "text/plain") return "text/plain";
    if (mime === "text/csv" || mime === "application/csv" || mime === "application/vnd.ms-excel") return "text/csv";
    return "";
}

export function workspaceDocumentFormat(mime = "", filename = ""): WorkspaceDocumentFormat {
    const resolved = resolveWorkspaceDocumentMime(filename, mime) || String(mime || "").toLowerCase();
    if (resolved.includes("markdown") || documentExtFromName(filename) === ".md" || documentExtFromName(filename) === ".markdown") {
        return "markdown";
    }
    if (resolved.includes("csv") || documentExtFromName(filename) === ".csv") return "csv";
    if (resolved.startsWith("text/") || documentExtFromName(filename) === ".txt") return "plain";
    return "unknown";
}

export function workspaceDocumentExt(mime = "", filename = "") {
    const fromName = documentExtFromName(filename);
    if (fromName) return fromName.replace(/^\./, "");
    const format = workspaceDocumentFormat(mime, filename);
    if (format === "markdown") return "md";
    if (format === "csv") return "csv";
    if (format === "plain") return "txt";
    return "txt";
}

/** First N chars for card / text_content summary (server also slices). */
export function summarizeDocumentText(text: string, max = 500) {
    const normalized = String(text || "").replace(/\r\n/g, "\n");
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max).trimEnd()}…`;
}

/** Minimal CSV parse for preview (quoted fields, no streaming). */
export function parseCsvPreview(text: string, maxRows = WORKSPACE_DOCUMENT_CSV_PREVIEW_ROWS): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let inQuotes = false;
    const src = String(text || "").replace(/^﻿/, "");
    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        const next = src[i + 1];
        if (inQuotes) {
            if (ch === '"' && next === '"') {
                cell += '"';
                i += 1;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                cell += ch;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            continue;
        }
        if (ch === ",") {
            row.push(cell);
            cell = "";
            continue;
        }
        if (ch === "\n") {
            row.push(cell);
            cell = "";
            rows.push(row);
            row = [];
            if (rows.length >= maxRows) return rows;
            continue;
        }
        if (ch === "\r") continue;
        cell += ch;
    }
    if (cell.length || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows.slice(0, maxRows);
}

/** Lightweight markdown → safe HTML (no raw HTML passthrough). */
export function renderSimpleMarkdown(source: string): string {
    const escaped = escapeHtml(String(source || "").replace(/\r\n/g, "\n"));
    const lines = escaped.split("\n");
    const out: string[] = [];
    let inList = false;
    let inCode = false;
    let codeBuf: string[] = [];

    const flushList = () => {
        if (inList) {
            out.push("</ul>");
            inList = false;
        }
    };
    const flushCode = () => {
        if (inCode) {
            out.push(`<pre class="ws-doc-pre"><code>${codeBuf.join("\n")}</code></pre>`);
            codeBuf = [];
            inCode = false;
        }
    };

    for (const rawLine of lines) {
        const line = rawLine;
        if (line.startsWith("```")) {
            if (inCode) {
                flushCode();
            } else {
                flushList();
                inCode = true;
                codeBuf = [];
            }
            continue;
        }
        if (inCode) {
            codeBuf.push(line);
            continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
            if (!inList) {
                out.push('<ul class="ws-doc-ul">');
                inList = true;
            }
            out.push(`<li>${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
            continue;
        }
        flushList();
        if (/^###\s+/.test(line)) {
            out.push(`<h3 class="ws-doc-h3">${inlineMarkdown(line.replace(/^###\s+/, ""))}</h3>`);
            continue;
        }
        if (/^##\s+/.test(line)) {
            out.push(`<h2 class="ws-doc-h2">${inlineMarkdown(line.replace(/^##\s+/, ""))}</h2>`);
            continue;
        }
        if (/^#\s+/.test(line)) {
            out.push(`<h1 class="ws-doc-h1">${inlineMarkdown(line.replace(/^#\s+/, ""))}</h1>`);
            continue;
        }
        if (/^>\s?/.test(line)) {
            out.push(`<blockquote class="ws-doc-quote">${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`);
            continue;
        }
        if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
            out.push('<hr class="ws-doc-hr" />');
            continue;
        }
        if (!line.trim()) {
            out.push("<br />");
            continue;
        }
        out.push(`<p class="ws-doc-p">${inlineMarkdown(line)}</p>`);
    }
    flushList();
    flushCode();
    return out.join("");
}

function inlineMarkdown(text: string) {
    return text
        .replace(/`([^`]+)`/g, '<code class="ws-doc-code">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(
            /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
            '<a href="$2" target="_blank" rel="noreferrer noopener" class="ws-doc-link">$1</a>',
        );
}

function escapeHtml(value: string) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
