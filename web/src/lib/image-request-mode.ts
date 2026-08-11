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
  /** 有参考图时：推荐/可用图生图模型提示（便于用户选型） */
  modelHint?: string;
  autoSwitched?: { from: string; to: string };
  degraded?: boolean;
};

export const IMAGE_EDIT_DEGRADED_DEFAULT =
  "当前中转无法完成参考图编辑，已降级为纯文生图；参考图像素未参与生成。可换支持图生图的渠道，或在配置里调整「生图兼容预设」后再试。";

/** 官方 xAI 图模（文生/图生共用）；中转可能另有 *-edit 别名。 */
export const GROK_OFFICIAL_IMAGE_MODELS = [
  "grok-imagine-image",
  "grok-imagine-image-pro",
  "grok-imagine-image-quality",
] as const;

/**
 * 有参考图时，根据当前渠道模型列表给出「可用/推荐图生图模型」提示。
 * 不改实际请求模型；只帮助选型。无参考图返回空串。
 */
export function describeImageEditModelHint(opts: {
  config: AiConfig;
  model: string;
  referenceCount: number;
  platform?: boolean;
}): string {
  const { config, model, referenceCount, platform } = opts;
  if (!referenceCount || platform) return "";

  const channel = resolveModelChannel(config, model || config.imageModel || "");
  if (resolveModelScript(config, model || config.imageModel || "")) {
    return "图生图：当前模型走自定义调用脚本，以脚本实现为准。";
  }
  if (channel.apiFormat === "gemini") {
    return "图生图：Gemini 图模可带参考图（不支持蒙版）。";
  }

  const selected = modelOptionName(model || config.imageModel || "").trim();
  const listed = (channel.models || []).map((item) => modelOptionName(item).trim()).filter(Boolean);
  const listedLower = new Set(listed.map((item) => item.toLowerCase()));
  const lower = selected.toLowerCase();
  const isGrokLike =
    (lower.includes("grok") && (lower.includes("imagine") || lower.includes("image"))) ||
    lower.includes("imagine-image");
  const strategy = getImageCompatStrategy(channel.baseUrl, channel.compatProfile);

  if (strategy.profile === "grok-image" || isGrokLike) {
    const officialInList = GROK_OFFICIAL_IMAGE_MODELS.filter((name) => listedLower.has(name));
    const relayEditInList = listed.filter((name) => {
      const n = name.toLowerCase();
      return n.includes("edit") && n.includes("image") && !n.includes("video");
    });
    const preferred = (officialInList.length ? officialInList : [...GROK_OFFICIAL_IMAGE_MODELS]).slice(0, 3);
    const parts = [
      `图生图可用模型（官方）：${preferred.join(" / ")}`,
      "与文生共用模型名，靠是否带参考图区分，不会自动改成 *-edit",
    ];
    if (relayEditInList.length) {
      parts.push(`中转列表另有：${relayEditInList.slice(0, 3).join(" / ")}${relayEditInList.length > 3 ? " 等" : ""}（可选，非官方必需）`);
    } else if (listed.length && !officialInList.length) {
      parts.push("当前渠道列表未含官方名时，优先选名称含 grok-imagine-image 的图模");
    }
    if (selected) parts.push(`当前：${selected}`);
    return parts.join("。") + "。";
  }

  if (strategy.editFallbackFragile) {
    return `图生图：当前为脆弱中转路径，优先使用渠道列表中的图片模型（当前 ${selected || "未选"}）；部分 gpt-image 可能不支持参考图。`;
  }

  return `图生图：使用当前所选图片模型即可（当前 ${selected || "未选"}）；走 /images/edits，依赖上游是否支持参考图编辑。`;
}

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
  const modelHint = describeImageEditModelHint({ config, model, referenceCount, platform });

  const script = resolveModelScript(config, model || config.imageModel || "");
  if (platform) {
    return {
      kind: "platform",
      summary: `请求模式：平台代生成 · ${platformModelLabel || model} · ${referenceCount ? `图生图（参考 ${Math.min(referenceCount, 4)} 张）` : "文生图"} · 生成 ${generationCount} 张`,
      tip: "默认仍是你自己的 API Key；开启平台积分后走服务端 Key。参考图会以 data URL 上传服务端再调上游 edits（平台最多 4 张；本地 BYOK 最多 6 张）。",
      path: "/api/generate/image",
      compatLabel,
      modelLabel: platformModelLabel || modelOptionName(model),
      modelHint: referenceCount ? "图生图：平台模式使用服务端配置的图片模型（最多 4 张参考图）。" : undefined,
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
      modelHint: modelHint || undefined,
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
      modelHint: modelHint || undefined,
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
      tip: "参考图以 JSON data URL 提交到 /images/edits。官方 Grok 图生图模型为 grok-imagine-image（及 pro/quality），与文生共用模型名、靠是否带参考图区分；不会自动改成 *-edit。",
      path: "/images/edits",
      compatLabel,
      modelLabel: modelOptionName(model),
      modelHint: modelHint || undefined,
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
      modelHint: modelHint || undefined,
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
    modelHint: modelHint || undefined,
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
      hints.push("该上游图生图只要 JSON body（如 Grok），不要 multipart。请把渠道「生图兼容预设」设为「Grok / Grok2API 生图」，模型用 grok-imagine-image（官方）或渠道列表中的图模，不要依赖自动 *-edit");
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
  if (/no available channel|无可用渠道|无渠道|channel not found|未配置渠道/i.test(lower)) {
    hints.push("这是 New API 网关侧问题：到管理后台「渠道」里给当前所选图片模型绑定可用上游，并确认令牌所属分组能访问该模型");
  }
  if (/service unavailable|503|502|504|upstream.*(down|unavailable|failed)|overloaded|do request failed/i.test(lower)) {
    hints.push("多为中转上游不可用，不是本站画布/工作台逻辑错误。请在 New API 日志里按 request id 查具体失败原因，并检查该模型对应上游 Key/额度（当前若是 GPT 就查 GPT 上游，不是 Grok Key）");
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
