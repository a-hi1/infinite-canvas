/** 资产展示：从生成提示词生成可读标题，并从 metadata 读取 prompt。 */

export function assetGenerationPrompt(asset: { metadata?: Record<string, unknown> | null; note?: string }) {
    const fromMeta = asset.metadata?.prompt;
    if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim();
    // 少数手动资产会把提示词写在备注里
    if (typeof asset.note === "string" && asset.note.trim().startsWith("提示词：")) {
        return asset.note.replace(/^提示词：\s*/, "").trim();
    }
    return "";
}

/** 用提示词前若干字作标题，避免批量「生成结果 1」无法区分。 */
export function assetTitleFromPrompt(prompt: string | undefined | null, fallback: string, max = 28) {
    const text = String(prompt || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!text) return fallback;
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function assetPromptSnippet(prompt: string, max = 96) {
    const text = prompt.replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** 列表/详情展示用：旧资产若仍是「生成结果 1」等通用名，优先用已存提示词摘要区分。不改写本地存储。 */
export function assetDisplayTitle(asset: { title: string; metadata?: Record<string, unknown> | null; note?: string }) {
    const title = (asset.title || "").trim() || "未命名资产";
    if (!isGenericAssetTitle(title)) return title;
    const prompt = assetGenerationPrompt(asset);
    if (!prompt) return title;
    return assetTitleFromPrompt(prompt, title);
}

function isGenericAssetTitle(title: string) {
    return /^(生成结果(\s*\d+)?|生成视频|画布图片|画布视频|画布文本|本地图片|本地视频)$/i.test(title.trim());
}
