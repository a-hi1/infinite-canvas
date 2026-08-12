/**
 * 视频中转主机适配配置（本机自动适配入口）。
 *
 * 目的：同一 Base URL 上多模型（Grok / Seedance / Sora…）的路径与字段约定
 * 收口到一处，避免每次踩坑再散改 video.ts。扩展新主机/模型时优先改本文件。
 *
 * 不负责上游渠道类型绑定（New API platform 48 等后台配置）；
 * 本文件只保证「本机按主机+模型族发出正确路径/形态」。
 */

import { isCodex2apiBaseUrl, isOpenAI2ApiBaseUrl, isXaiBaseUrl } from "@/lib/grok-video";
import { isAiProxyBaseUrl, isLanAiBaseUrl } from "@/stores/use-config-store";

export type VideoHostKind =
  | "openai2api"
  | "codex2api"
  | "xai"
  | "lan-ai"
  | "private-new-api"
  | "generic";

export type VideoModelFamily = "grok" | "seedance" | "sora-veo" | "agnes" | "kling" | "other";

export type VideoHostProfile = {
  kind: VideoHostKind;
  /** 展示名 */
  label: string;
  /**
   * 大 body / 多图时按中转压图：openai2api / codex2api / lan-ai 都需要，
   * 避免网关 400/假 404。
   */
  compressLikeRelay: boolean;
  /** Grok generation 路径（不含 edits）。按优先级。禁止项不出现在列表。 */
  grokCreatePaths: string[];
  /** Grok 是否允许把 /videos 当 generation 兜底（OpenAI Sora 适配器）。openai2api/New API 禁止。 */
  allowGrokOpenAiVideosFallback: boolean;
  /** Grok 轮询路径模板（`{id}` 会替换为任务 ID），按优先级。 */
  grokPollPaths: string[];
  /** Grok 完成无 URL 时的内容下载路径模板，按优先级。 */
  grokContentPaths: string[];
  /** Seedance 非 Agent Plan 中转创建路径 */
  seedanceRelayCreatePath: string;
  /**
   * 公网是否可能支持 Grok 多图参考生视频。
   * - supported: 本机会发完整多图字段，上游若开通则可成
   * - fragile: 历史上游 404/未开通 multi-ref 常见（如部分 codex 套餐）
   * - unknown: 未验证
   * 本机从不静默只发第一张。
   */
  grokMultiImageCapability: "supported" | "fragile" | "unknown";
};

function isPrivateOrLoopbackHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(host)) return true;
  return false;
}

/** 内网 New API（非 openai2api 公网域名）。与 video.ts 原 isLikelyPrivateNewApi 语义对齐。 */
export function isPrivateNewApiBaseUrl(baseUrl: string) {
  if (
    isCodex2apiBaseUrl(baseUrl) ||
    isXaiBaseUrl(baseUrl) ||
    isLanAiBaseUrl(baseUrl) ||
    isAiProxyBaseUrl(baseUrl) ||
    isOpenAI2ApiBaseUrl(baseUrl)
  ) {
    return false;
  }
  const raw = (baseUrl || "").trim();
  if (!raw) return false;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return isPrivateOrLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

export function resolveVideoHostKind(baseUrl: string): VideoHostKind {
  if (isOpenAI2ApiBaseUrl(baseUrl)) return "openai2api";
  if (isCodex2apiBaseUrl(baseUrl)) return "codex2api";
  if (isXaiBaseUrl(baseUrl)) return "xai";
  if (isLanAiBaseUrl(baseUrl)) return "lan-ai";
  if (isPrivateNewApiBaseUrl(baseUrl)) return "private-new-api";
  return "generic";
}

/**
 * openai2api.com（公网 New API 多模型站）本机适配表。
 * Seedance 主机默认：/video/generations（doubao-seedance-*）。
 * 精确模型 seedance2 的 openai-video 路径由 video.ts 按模型切到 /videos，不写死在本 profile。
 * Grok：只 /video/generations。实测 /videos/generations → Invalid URL 404；/videos → platform 48。
 */
const OPENAI2API_PROFILE: VideoHostProfile = {
  kind: "openai2api",
  label: "openai2api",
  compressLikeRelay: true,
  // 仅 singular generations；勿再试 /videos/generations（用户实测 404 Invalid URL）
  grokCreatePaths: ["/video/generations"],
  allowGrokOpenAiVideosFallback: false,
  grokPollPaths: [
    "/video/generations/{id}",
    "/video/generations?task_id={id}",
    "/video/generations?request_id={id}",
    "/video/generations?id={id}",
  ],
  // New API 成片代理固定 GET /v1/videos/{task_id}/content（TokenOrUserAuth，不走 platform 48）。
  // 创建/轮询仍只用 /video/generations；content 下载与创建路径分离。
  grokContentPaths: [
    "/videos/{id}/content",
    "/videos/{id}/download",
    "/videos/{id}/file",
    "/video/generations/{id}/content",
  ],
  seedanceRelayCreatePath: "/video/generations",
  // 本机发完整多图；出片仍依赖该站 Grok 渠道类型 + 上游 multi-ref
  grokMultiImageCapability: "supported",
};

const CODEX2API_PROFILE: VideoHostProfile = {
  kind: "codex2api",
  label: "codex2api",
  compressLikeRelay: true,
  grokCreatePaths: ["/videos/generations"],
  allowGrokOpenAiVideosFallback: false,
  grokPollPaths: ["/videos/{id}", "/videos/generations?request_id={id}", "/videos/generations?id={id}"],
  grokContentPaths: ["/videos/{id}/content", "/videos/{id}/download", "/videos/{id}/file"],
  seedanceRelayCreatePath: "/video/generations",
  // 历史：多图常 xAI upstream 404（套餐/映射未开 multi-ref）
  grokMultiImageCapability: "fragile",
};

const XAI_PROFILE: VideoHostProfile = {
  kind: "xai",
  label: "xAI",
  compressLikeRelay: false,
  grokCreatePaths: ["/videos/generations"],
  allowGrokOpenAiVideosFallback: false,
  grokPollPaths: ["/videos/{id}", "/videos/generations?request_id={id}", "/videos/generations?id={id}"],
  grokContentPaths: ["/videos/{id}/content", "/videos/{id}/download", "/videos/{id}/file"],
  seedanceRelayCreatePath: "/video/generations",
  grokMultiImageCapability: "supported",
};

const LAN_AI_PROFILE: VideoHostProfile = {
  kind: "lan-ai",
  label: "lan-ai / Grok2API",
  compressLikeRelay: true,
  grokCreatePaths: ["/videos/generations", "/video/generations"],
  allowGrokOpenAiVideosFallback: false,
  grokPollPaths: ["/videos/{id}", "/videos/generations?request_id={id}", "/videos/generations?id={id}", "/video/generations/{id}"],
  grokContentPaths: ["/videos/{id}/content", "/videos/{id}/download", "/videos/{id}/file", "/video/generations/{id}/content"],
  seedanceRelayCreatePath: "/video/generations",
  grokMultiImageCapability: "supported",
};

const PRIVATE_NEW_API_PROFILE: VideoHostProfile = {
  kind: "private-new-api",
  label: "内网 New API",
  compressLikeRelay: true,
  // 实测 /videos/generations 404；创建勿打 /videos（platform 48）；content 代理仍是 /videos/{id}/content
  grokCreatePaths: ["/video/generations"],
  allowGrokOpenAiVideosFallback: false,
  grokPollPaths: ["/video/generations/{id}", "/video/generations?task_id={id}", "/video/generations?request_id={id}", "/video/generations?id={id}"],
  grokContentPaths: [
    "/videos/{id}/content",
    "/videos/{id}/download",
    "/videos/{id}/file",
    "/video/generations/{id}/content",
  ],
  seedanceRelayCreatePath: "/video/generations",
  grokMultiImageCapability: "unknown",
};

const GENERIC_PROFILE: VideoHostProfile = {
  kind: "generic",
  label: "通用中转",
  compressLikeRelay: false,
  grokCreatePaths: ["/video/generations", "/videos/generations", "/videos"],
  allowGrokOpenAiVideosFallback: true,
  grokPollPaths: [
    "/videos/{id}",
    "/videos/generations/{id}",
    "/video/generations/{id}",
    "/videos/generations?request_id={id}",
    "/videos?request_id={id}",
    "/videos/generations?id={id}",
  ],
  grokContentPaths: [
    "/videos/{id}/content",
    "/videos/{id}/download",
    "/videos/{id}/file",
    "/videos/generations/{id}/content",
    "/video/generations/{id}/content",
  ],
  seedanceRelayCreatePath: "/video/generations",
  grokMultiImageCapability: "unknown",
};

export function resolveVideoHostProfile(baseUrl: string): VideoHostProfile {
  switch (resolveVideoHostKind(baseUrl)) {
    case "openai2api":
      return OPENAI2API_PROFILE;
    case "codex2api":
      return CODEX2API_PROFILE;
    case "xai":
      return XAI_PROFILE;
    case "lan-ai":
      return LAN_AI_PROFILE;
    case "private-new-api":
      return PRIVATE_NEW_API_PROFILE;
    default:
      return GENERIC_PROFILE;
  }
}

/** 是否 New API 风格（openai2api 公网 + 内网 New API）：Grok 禁止 /videos 兜底。 */
export function isNewApiStyleVideoHost(baseUrl: string) {
  const kind = resolveVideoHostKind(baseUrl);
  return kind === "openai2api" || kind === "private-new-api";
}

/**
 * 从模型名粗分族。仅用于主机 profile 内路径/提示；真正 create 仍走 isGrok/isSeedance 等判定。
 */
export function detectVideoModelFamily(model: string): VideoModelFamily {
  const value = (model || "").toLowerCase();
  if (value.includes("grok") || value.includes("imagine-video") || value.includes("imagine_video")) return "grok";
  if (value.includes("seedance") || value.includes("doubao-seedance") || value.includes("seedance2")) return "seedance";
  if (value.includes("sora") || value.includes("veo")) return "sora-veo";
  if (value.includes("agnes")) return "agnes";
  if (value.includes("kling")) return "kling";
  return "other";
}

/**
 * Grok generation 路径候选（主机 profile 驱动）。
 * 不含 /videos/edits。
 */
export function hostGrokCreatePaths(baseUrl: string, model = ""): string[] {
  const profile = resolveVideoHostProfile(baseUrl);
  const family = detectVideoModelFamily(model);
  // 非 Grok 模型误入时：New API 可优先 /videos（Sora）；其它仍用 profile 列表
  if (family !== "grok" && family !== "other") {
    if (isNewApiStyleVideoHost(baseUrl)) return ["/videos", "/video/generations"];
  }
  if (family !== "grok" && profile.kind === "generic") {
    return ["/videos", "/video/generations", "/videos/generations"];
  }
  return [...profile.grokCreatePaths];
}

/** Grok 轮询路径模板（主机 profile 驱动）。 */
export function hostGrokPollPaths(baseUrl: string): string[] {
  return [...resolveVideoHostProfile(baseUrl).grokPollPaths];
}

/** Grok 完成无 URL 时的内容下载路径模板（主机 profile 驱动）。 */
export function hostGrokContentPaths(baseUrl: string): string[] {
  return [...resolveVideoHostProfile(baseUrl).grokContentPaths];
}

/** Seedance 中转创建路径（非 Agent Plan）。 */
export function hostSeedanceRelayCreatePath(baseUrl: string) {
  return resolveVideoHostProfile(baseUrl).seedanceRelayCreatePath;
}

/**
 * 公网 Grok 多图参考能力说明（给 UI/错误文案，不探测付费）。
 */
export function describeGrokMultiImagePublicCapability(baseUrl: string): {
  capability: VideoHostProfile["grokMultiImageCapability"];
  summary: string;
} {
  const profile = resolveVideoHostProfile(baseUrl);
  switch (profile.grokMultiImageCapability) {
    case "supported":
      return {
        capability: "supported",
        summary:
          profile.kind === "openai2api"
            ? "本机对 openai2api 会按 /video/generations 发送完整多图参考（最多 7 张，不静默只发第一张）。能否生成成功取决于该站 Grok 渠道类型是否绑 xAI/Grok，以及上游是否开通 multi-reference。"
            : "本机会发送完整多图参考字段；成功依赖上游 multi-reference 能力。",
      };
    case "fragile":
      return {
        capability: "fragile",
        summary:
          "本机会发送完整多图参考。codex2api 等公网中转历史上常因 xAI 上游 404/未开通 multi-ref 失败；可先验证单图/文生，多图失败可改 Seedance 或支持 multi-ref 的渠道。",
      };
    default:
      return {
        capability: "unknown",
        summary: "本机会发送完整多图参考；该主机多图能力未充分验证，失败时请对照 Network 路径与上游报错。",
      };
  }
}
