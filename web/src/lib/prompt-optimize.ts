import { requestImageQuestion } from "@/services/api/image";
import { buildOptimizeSystemPrompt, resolvePromptOptimizeIntent, type PromptOptimizeIntent } from "@/lib/prompt-optimize-skills";
import { isSameOriginRelayBaseUrl, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

export type PromptOptimizeMode = "image" | "video" | "text" | "audio";

export type OptimizeGenerationPromptOptions = {
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
    /** 内容意图：默认 auto，按原文识别人物/场景/道具/分镜 */
    intent?: PromptOptimizeIntent | null;
    /** 画布连接素材、项目备注等附加约束 */
    contextNotes?: string[];
};

const MODE_LABEL: Record<PromptOptimizeMode, string> = {
    image: "图片",
    video: "视频",
    text: "文本",
    audio: "音频",
};

export async function optimizeGenerationPrompt(config: AiConfig, prompt: string, mode: PromptOptimizeMode, options?: OptimizeGenerationPromptOptions) {
    const source = prompt.trim();
    if (!source) throw new Error("请先输入提示词");

    const textModel = (config.textModel || config.model || "").trim();
    if (!textModel) throw new Error("请先在配置中选择文本模型，用于优化提示词");

    // 关键：保留 channelId::model 归属，不要只把解析后的裸 model 传下去。
    // 否则下游再次 resolve 时，若多个渠道都有同名模型（如 grok-4.5），会回退到第一个匹配渠道，
    // 出现 UI 选了“内网grok”，请求却打到默认 codex2api 的现象。
    const requestConfig = resolveModelRequestConfig(
        {
            ...config,
            model: textModel,
            textModel,
        },
        textModel,
    );
    if (!requestConfig.baseUrl.trim()) throw new Error("请先配置文本模型渠道的 Base URL");
    if (!requestConfig.apiKey.trim() && !isSameOriginRelayBaseUrl(requestConfig.baseUrl)) throw new Error("请先配置文本模型渠道的 API Key");

    const intent = resolvePromptOptimizeIntent(source, options?.intent);
    const systemPrompt = buildOptimizeSystemPrompt({
        mode,
        intent,
        prompt: source,
        contextNotes: options?.contextNotes,
    });

    const label = MODE_LABEL[mode] || MODE_LABEL.image;
    const answer = await requestImageQuestion(
        {
            ...requestConfig,
            // 再次明确保留原始 textModel 选择，避免 requestImageQuestion 二次解析时丢失渠道归属。
            model: textModel,
            textModel,
            systemPrompt,
        },
        [{ role: "user", content: buildOptimizeUserMessage(source, label, intent) }],
        (text) => options?.onDelta?.(sanitizeOptimizedPrompt(text)),
        { signal: options?.signal },
    );

    const optimized = sanitizeOptimizedPrompt(answer);
    if (!optimized) throw new Error("文本模型没有返回可用的优化结果");
    return optimized;
}

function buildOptimizeUserMessage(source: string, label: string, intent: PromptOptimizeIntent) {
    const intentHint =
        intent === "character_sheet"
            ? "内容偏向角色九宫格/表情表，请写成单张 3×3 九宫格角色表提示词：同一人、九格等分、只变表情/微姿态/机位，不要写成九个无关镜头。"
            : intent === "character"
              ? "内容偏向人物/角色，请按人物生产维度补全，但不要改成另一个人。"
              : intent === "scene"
                ? "内容偏向场景/环境，请按场景生产维度补全。"
                : intent === "prop"
                  ? "内容偏向道具/物件，请按道具生产维度补全。"
                  : intent === "storyboard"
                    ? "内容偏向分镜/镜头，请按镜头语言补全。"
                    : "请按原文重心补全，不要强行改成人物设定图。";

    return `请优化以下${label}提示词。
${intentHint}
只输出优化后的提示词正文。

原文：
${source}`;
}

function sanitizeOptimizedPrompt(text: string) {
    // 九宫格描述更长，不在这里硬截断；只剥包装语与代码块
    return text
        .trim()
        .replace(/^```[\w-]*\s*/i, "")
        .replace(/\s*```$/i, "")
        .replace(/^(优化后的?(图片|视频|文本|音频)?提示词[:：]\s*)/i, "")
        .trim();
}

export { detectPromptOptimizeIntent, describeOptimizeIntent, resolvePromptOptimizeIntent, type PromptOptimizeIntent } from "@/lib/prompt-optimize-skills";
