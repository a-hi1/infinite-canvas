import { compressImageDataUrl } from "@/lib/image-utils";
import { requestGeneration } from "@/services/api/image";
import { setPromptCoverOverride, type Prompt } from "@/services/api/prompts";
import { type AiConfig, modelMatchesCapability } from "@/stores/use-config-store";

function pickImageModel(config: AiConfig) {
    const candidates = [config.imageModel, config.model, ...(config.imageModels || []), ...(config.models || [])];
    for (const model of candidates) {
        const name = String(model || "").trim();
        if (!name) continue;
        if (modelMatchesCapability(name, "image")) return name;
        // 兜底：名称像图片模型且不像视频/音频
        if (/image|dall-e|dalle|seedream|flux|sdxl|imagen/i.test(name) && !/video|tts|audio|whisper/i.test(name)) return name;
    }
    return (config.imageModel || config.model || "").trim();
}

/**
 * 单条按需：用当前 BYOK 图片模型生成 1 张预览，并写入本地封面
 * - 我的提示词：直接更新 coverUrl
 * - 公共库：IndexedDB 覆盖，不回写 GitHub
 */
export async function generatePromptCover(config: AiConfig, prompt: Prompt, options?: { signal?: AbortSignal }) {
    const text = (prompt.prompt || "").trim();
    if (!text) throw new Error("提示词内容为空，无法生成预览图");

    const model = pickImageModel(config);
    if (!model) throw new Error("请先配置可用的图片模型");

    const images = await requestGeneration(
        {
            ...config,
            model,
            imageModel: model,
            count: "1",
            size: config.size || "1024x1024",
            quality: config.quality || "low",
        },
        text,
        { signal: options?.signal },
    );

    let coverUrl = (images[0]?.dataUrl || "").trim();
    if (!coverUrl) throw new Error("生图接口没有返回图片");

    // 压缩 data URI，避免 IndexedDB / 列表缓存过大
    if (coverUrl.startsWith("data:image/")) {
        coverUrl = await compressImageDataUrl(coverUrl, 1024, 0.84);
        if (coverUrl.length > 1_200_000) {
            coverUrl = await compressImageDataUrl(coverUrl, 768, 0.78);
        }
    }

    return setPromptCoverOverride(prompt, coverUrl);
}
