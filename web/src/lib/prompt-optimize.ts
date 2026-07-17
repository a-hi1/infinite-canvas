import { requestImageQuestion } from "@/services/api/image";
import { isAiProxyBaseUrl, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

export type PromptOptimizeMode = "image" | "video" | "text" | "audio";

const IMAGE_OPTIMIZE_INSTRUCTION = `你是资深 AI 绘图提示词优化助手。把用户的简短描述扩写成更准确、美观、可执行的中文图片提示词。

要求：
1. 只输出优化后的提示词正文，不要解释、标题、编号或 markdown。
2. 保留用户原意，不要编造与原意冲突的主体。
3. 补全主体、场景、构图、光线、色彩、材质、风格、氛围、画质关键词。
4. 适合文生图/图生图，避免镜头分镜、时长、运镜等视频术语。
5. 控制在 80-220 字，信息密度高，避免空话。`;

const VIDEO_OPTIMIZE_INSTRUCTION = `你是资深 AI 视频提示词优化助手。把用户的简短描述扩写成更准确、流畅、可执行的中文视频提示词。

要求：
1. 只输出优化后的提示词正文，不要解释、标题、编号或 markdown。
2. 保留用户原意，不要编造与原意冲突的主体。
3. 补全主体动作、镜头运动、场景氛围、光影、节奏、风格、画质关键词。
4. 适合文生视频/图生视频，强调连续运动与镜头语言，不要写成静态海报描述。
5. 控制在 80-220 字，信息密度高，避免空话。`;

const TEXT_OPTIMIZE_INSTRUCTION = `你是资深中文写作与提示词优化助手。把用户的简短描述扩写成更清晰、具体、可执行的中文文本生成提示词。

要求：
1. 只输出优化后的提示词正文，不要解释、标题、编号或 markdown。
2. 保留用户原意，不要编造与原意冲突的核心信息。
3. 补全目标、受众、语气、结构、重点信息与约束条件。
4. 适合文本生成/改写，不要写成图片或视频镜头描述。
5. 控制在 60-180 字，信息密度高，避免空话。`;

const AUDIO_OPTIMIZE_INSTRUCTION = `你是资深语音合成与旁白提示词优化助手。把用户的简短描述扩写成更清晰、可朗读、可执行的中文音频提示词。

要求：
1. 只输出优化后的提示词正文，不要解释、标题、编号或 markdown。
2. 保留用户原意，不要编造与原意冲突的核心信息。
3. 补全说话内容、语气、情绪、节奏、场景用途，必要时点明适合的旁白风格。
4. 适合 TTS / 音频生成，不要写成图片构图或视频运镜描述。
5. 控制在 40-160 字，信息密度高，避免空话。`;

const MODE_META: Record<PromptOptimizeMode, { instruction: string; label: string }> = {
    image: { instruction: IMAGE_OPTIMIZE_INSTRUCTION, label: "图片" },
    video: { instruction: VIDEO_OPTIMIZE_INSTRUCTION, label: "视频" },
    text: { instruction: TEXT_OPTIMIZE_INSTRUCTION, label: "文本" },
    audio: { instruction: AUDIO_OPTIMIZE_INSTRUCTION, label: "音频" },
};

export async function optimizeGenerationPrompt(config: AiConfig, prompt: string, mode: PromptOptimizeMode, options?: { signal?: AbortSignal; onDelta?: (text: string) => void }) {
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
    if (!requestConfig.apiKey.trim() && !isAiProxyBaseUrl(requestConfig.baseUrl)) throw new Error("请先配置文本模型渠道的 API Key");

    const meta = MODE_META[mode] || MODE_META.image;
    const answer = await requestImageQuestion(
        {
            ...requestConfig,
            // 再次明确保留原始 textModel 选择，避免 requestImageQuestion 二次解析时丢失渠道归属。
            model: textModel,
            textModel,
            systemPrompt: meta.instruction,
        },
        [{ role: "user", content: `请优化以下${meta.label}提示词：\n${source}` }],
        (text) => options?.onDelta?.(sanitizeOptimizedPrompt(text)),
        { signal: options?.signal },
    );

    const optimized = sanitizeOptimizedPrompt(answer);
    if (!optimized) throw new Error("文本模型没有返回可用的优化结果");
    return optimized;
}

function sanitizeOptimizedPrompt(text: string) {
    return text
        .trim()
        .replace(/^```[\w-]*\s*/i, "")
        .replace(/\s*```$/i, "")
        .replace(/^(优化后的?(图片|视频|文本|音频)?提示词[:：]\s*)/i, "")
        .trim();
}

