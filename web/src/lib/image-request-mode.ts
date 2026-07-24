import { getImageCompatStrategy, modelOptionName, resolveChannelCompatProfile, resolveModelChannel, resolveModelScript, type AiConfig, CHANNEL_COMPAT_OPTIONS, normalizeCompatProfile } from "@/stores/use-config-store";
import type { GeneratedImageResult } from "@/services/api/image";

export type ImageRequestModeKind =
  | "platform"
  | "script"
  | "gemini-image"
  | "text-to-image"
  | "edit-grok-json"
  | "edit-fragile"
  | "edit-openai-multipart";

export type ImageRequestModeDescription = {
  kind: ImageRequestModeKind;
  summary: string;
  tip: string;
  path: string;
  compatLabel: string;
  modelLabel: string;
  autoSwitched?: { from: string; to: string };
  degraded?: boolean;
};

export const IMAGE_EDIT_DEGRADED_DEFAULT =
  "当前中转无法完成参考图编辑，已降级为纯文生图；参考图像素未参与生成。可换支持图生图的渠道，或在配置里调整「生图兼容预设」后再试。";

export function describeImageRequestMode(opts: {
  config: AiConfig;
  model: string;
  referenceCount: number;
  generationCount: number;
  platform?: boolean;
  platformModelLabel?: string;
  autoSwitched?: { from: string; to: string };
  degraded?: boolean;
}): ImageRequestModeDescription {
  const {
    config,
    model,
    referenceCount,
    generationCount,
    platform,
    platformModelLabel,
    autoSwitched,
    degraded,
  } = opts;

  const channel = resolveModelChannel(config, model || config.imageModel || "");
  const profile = normalizeCompatProfile(channel.compatProfile);
  const resolvedProfile = resolveChannelCompatProfile(channel.baseUrl, profile);
  const compatLabel = profile === "auto"
    ? `自动（${CHANNEL_COMPAT_OPTIONS.find(o => o.value === resolvedProfile)?.label || resolvedProfile}）`
    : CHANNEL_COMPAT_OPTIONS.find(o => o.value === profile)?.label || profile;

  const script = resolveModelScript(config, model || config.imageModel || "");
  if (platform) {
    return {
      kind: "platform",
      summary: `请求模式：平台代生成 · ${platformModelLabel || model} · ${referenceCount ? `图生图（参考 ${Math.min(referenceCount, 4)} 张）` : "文生图"} · 生成 ${generationCount} 张`,
      tip: "默认仍是你自己的 API Key；开启平台积分后走服务端 Key。参考图会以 data URL 上传服务端再调上游 edits（最多 4 张）。",
      path: "/api/generate/image",
      compatLabel,
      modelLabel: platformModelLabel || modelOptionName(model),
      autoSwitched,
      degraded,
    };
  }

  if (script) {
    return {
      kind: "script",
      summary: `请求模式：自定义调用脚本 · ${modelOptionName(model)} · ${referenceCount ? `图生图（参考 ${referenceCount} 张）` : "文生图"} · 生成 ${generationCount} 张`,
      tip: "当前模型已配置本地调用脚本；留空脚本则回退系统默认 OpenAI/Gemini 路径。多张时仍优先一次请求，不足再串行补齐。",
      path: "自定义脚本",
      compatLabel,
      modelLabel: modelOptionName(model),
      autoSwitched,
      degraded,
    };
  }

  const isGemini = channel.apiFormat === "gemini";
  if (isGemini) {
    return {
      kind: "gemini-image",
      summary: `请求模式：Gemini 图生图 · ${modelOptionName(model)} · ${referenceCount ? `图生图（参考 ${referenceCount} 张）` : "文生图"} · 生成 ${generationCount} 张`,
      tip: "Gemini 图生图不支持蒙版编辑。",
      path: "/v1/images/generations",
      compatLabel,
      modelLabel: modelOptionName(model),
      autoSwitched,
      degraded,
    };
  }

  if (referenceCount === 0) {
    return {
      kind: "text-to-image",
      summary: `请求模式：文生图 /images/generations · ${modelOptionName(model)} · 生成 ${generationCount} 张`,
      tip: "当前没有参考图；兼容预设只调整该渠道发送给上游的参数字段。",
      path: "/images/generations",
      compatLabel,
      modelLabel: modelOptionName(model),
      autoSwitched,
      degraded,
    };
  }

  const lowerModel = model.toLowerCase();
  const isGrokLike = lowerModel.includes("grok") && (lowerModel.includes("imagine") || lowerModel.includes("image"));
  const strategy = getImageCompatStrategy(channel.baseUrl, profile);

  if (strategy.profile === "grok-image" || isGrokLike) {
    return {
      kind: "edit-grok-json",
      summary: `请求模式：Grok JSON 图生图 /images/edits · ${modelOptionName(model)} · 图生图（参考 ${referenceCount} 张） · 生成 ${generationCount} 张`,
      tip: "参考图以 JSON data URL 提交；有参考图时可能自动切换到 *-edit 模型。",
      path: "/images/edits",
      compatLabel,
      modelLabel: modelOptionName(model),
      autoSwitched,
      degraded,
    };
  }

  if (strategy.editFallbackFragile) {
    return {
      kind: "edit-fragile",
      summary: `请求模式：脆弱中转图生图（可能降级） · ${modelOptionName(model)} · 图生图（参考 ${referenceCount} 张） · 生成 ${generationCount} 张`,
      tip: "图生图失败时会尝试旁路仍失败可能降级纯文生图（会明确提示）。",
      path: "/images/edits → generations",
      compatLabel,
      modelLabel: modelOptionName(model),
      autoSwitched,
      degraded,
    };
  }

  return {
    kind: "edit-openai-multipart",
    summary: `请求模式：OpenAI multipart 图生图 /images/edits · ${modelOptionName(model)} · 图生图（参考 ${referenceCount} 张） · 生成 ${generationCount} 张`,
    tip: "参考图走 multipart 上传。",
    path: "/images/edits",
    compatLabel,
    modelLabel: modelOptionName(model),
    autoSwitched,
    degraded,
  };
}

export function enhanceImageUpstreamError(upstream: string, context?: "generation" | "edit", fallback = "请求失败"): string {
  const text = upstream.trim();
  if (!text) return fallback;
  const lower = text.toLowerCase();
  const hints: string[] = [];

  if (context === "edit") {
    if (/(application\/json|only support.*json|content-type|multipart)/i.test(lower) && /multipart|form-data|image/i.test(lower)) {
      hints.push("该上游图生图只要 JSON body（如 Grok），不要 multipart。请把渠道「生图兼容预设」设为「Grok / Grok2API 生图」或换 grok-imagine-image-edit 模型");
    }
    if (/multipart|form-data/i.test(lower) && /not support|unsupported|invalid/i.test(lower)) {
      hints.push("当前渠道可能不接受 multipart 参考图。可改兼容预设、换模型，或清空参考图改文生图");
    }
    if (/mask/i.test(lower)) {
      hints.push("蒙版编辑可能不被该模型支持");
    }
  } else {
    if (/(aspect_ratio|resolution|size|quality)/i.test(lower) && /unknown|invalid|not support|unexpected/i.test(lower)) {
      hints.push("上游可能不接受 size/quality 字段。Grok 类请用「Grok」兼容预设；挑剔中转可用「OpenAI 精简」或「脆弱中转」");
    }
  }
  if (/rate limit|too many|429/i.test(lower)) {
    hints.push("疑似限流，请降低张数或稍后重试");
  }
  if (!hints.length) {
    if (context === "edit" && !/图生图|参考图/.test(text)) {
      return `${fallback}：${text}。若在做图生图：确认模型支持参考图、参考图为本地可读，或调整生图兼容预设`;
    }
    return text;
  }
  return `${text}。${hints.join("；")}`;
}
