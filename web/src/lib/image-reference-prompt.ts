import type { ReferenceImage } from "@/types/image";
import type { AiConfig } from "@/stores/use-config-store";

import { getImageCompatStrategy, isLanAiBaseUrl } from "@/stores/use-config-store";

export function imageReferenceLabel(index: number) {
    return `图片${index + 1}`;
}

export function buildImageReferencePromptText(prompt: string, references: ReferenceImage[], config?: AiConfig) {
    const text = prompt.trim();
    if (!references.length) return text;

    const labels = references.map((_, index) => imageReferenceLabel(index));
    const baseUrl = config?.baseUrl || "";
    const modelHints = `${config?.model || ""} ${config?.imageModel || ""}`;
    const looksLikeGrokMultiImage =
        references.length > 1 &&
        Boolean(config) &&
        (isLanAiBaseUrl(baseUrl) || getImageCompatStrategy(baseUrl, "auto").profile === "grok-image" || /(grok)/i.test(modelHints));

    if (looksLikeGrokMultiImage) {
        return `${text}\n\n你会收到多张参考图（顺序为：${labels.join("、")}）。请同时参考全部图片，不要只参考第一张；若提示词描述的是“一起、同框、多人、组合、并排”等场景，请让每张参考图的主要人物或主体都出现在结果中。`;
    }

    if (config && isLanAiBaseUrl(config.baseUrl)) {
        return text;
    }

    return `参考图片编号：${labels.join("、")}。请按这些编号理解提示词中的图片引用。\n\n${text}`;
}
