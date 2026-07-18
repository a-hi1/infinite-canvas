import { CanvasNodeType } from "@/types/canvas";

type NodeTitleKind = CanvasNodeType | "text" | "image" | "video" | "audio" | "group" | "config";

/** 生成结果节点的短标题，避免把整段提示词塞进节点名 */
export function shortGenerationTitle(type: NodeTitleKind, prompt?: string) {
    const key = String(type);
    const base = key === "video" ? "视频" : key === "audio" ? "音频" : key === "image" ? "图片" : key === "text" ? "文本" : key === "group" ? "组" : key === "config" ? "生成配置" : "节点";
    const snippet = (prompt || "").replace(/\s+/g, " ").trim().slice(0, 10);
    return snippet ? `${base} · ${snippet}` : base;
}

/** 展示用：过长标题（常见于历史节点把提示词当 title）压缩成可读短名 */
export function displayNodeTitle(title: string | undefined, type: CanvasNodeType, prompt?: string) {
    const raw = (title || "").trim();
    if (!raw) return shortGenerationTitle(type, prompt);
    // 历史数据：title 基本就是提示词前缀
    if (raw.length > 18 || (prompt && prompt.startsWith(raw) && raw.length > 12)) {
        return shortGenerationTitle(type, prompt || raw);
    }
    return raw;
}
