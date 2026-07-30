import axios from "axios";

import {
    buildApiUrl,
    getImageCompatStrategy,
    isAiProxyBaseUrl,
    isLanAiBaseUrl,
    modelMatchesCapability,
    modelOptionName,
    resolveModelChannel,
    resolveModelRequestConfig,
    resolveModelScript,
    type AiConfig,
    type ModelChannel,
} from "@/stores/use-config-store";
import { nanoid } from "nanoid";
import { compressImageDataUrl, dataUrlToFile } from "@/lib/image-utils";
import { BYOK_IMAGE_REFERENCE_LIMIT, SCRIPT_IMAGE_REFERENCE_LIMIT } from "@/lib/image-reference-limits";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { enhanceImageUpstreamError } from "@/lib/image-request-mode";
import { withSoraRelayModelAliases } from "@/lib/openai-compatible-video";
import { ensureLocalImageDataUrl, imageToDataUrl } from "@/services/image-storage";
import { normalizePluginImages, runModelPlugin } from "@/services/api/model-plugin";
import type { ReferenceImage } from "@/types/image";

/** 图生图 multipart 容易被中转掐断；参考图过大时更明显。 */
const IMAGE_EDIT_TIMEOUT_MS = 180_000;
const IMAGE_GEN_TIMEOUT_MS = 120_000;
const IMAGE_EDIT_MAX_EDGE = 1280;
const IMAGE_EDIT_JPEG_QUALITY = 0.84;
/** codex2api 带参考图 body 更易被掐；旁路用更小图 */
const FRAGILE_REF_MAX_EDGE = 768;
const FRAGILE_REF_JPEG_QUALITY = 0.72;

export type GeneratedImageResult = {
    id: string;
    dataUrl: string;
    /** 脆弱中转无法传参考图时降级为纯文生图 */
    degradedFromEdit?: boolean;
    degradeReason?: string;
};

/** @deprecated 优先用 getImageCompatStrategy；保留给旧调用点 */
function isFragileImageRelay(baseUrl: string) {
    return getImageCompatStrategy(baseUrl, "auto").profile === "relay-fragile";
}

function isConnectionClosedError(error: unknown) {
    if (!axios.isAxiosError(error) || error.response) return false;
    const blob = `${error.code || ""} ${error.message || ""}`;
    return /ERR_CONNECTION_CLOSED|ECONNRESET|socket hang up|Network Error|Failed to fetch/i.test(blob);
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("请求已取消", "AbortError"));
            return;
        }
        const timer = window.setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("请求已取消", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** 脆弱中转上 edits 常直接掐连接或 404/400；仅对这些错误尝试 generations 图生图旁路。 */
function shouldFallbackEditOnFragileRelay(error: unknown) {
    if (isConnectionClosedError(error)) return true;
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    return status === 404 || status === 405 || status === 400 || status === 415 || status === 501;
}

function dataUrlToRawBase64(dataUrl: string) {
    const trimmed = dataUrl.trim();
    if (!trimmed.startsWith("data:")) return trimmed.replace(/\s+/g, "");
    return trimmed.split(",", 2)[1] || "";
}

function markDegraded(images: Array<{ id: string; dataUrl: string }>, reason: string): GeneratedImageResult[] {
    return images.map((image) => ({ ...image, degradedFromEdit: true, degradeReason: reason }));
}

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

export type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

export type ResponseInputMessage =
    | AiTextMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { role: "tool"; tool_call_id: string; content: string };

export type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

export type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = AiTextMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem =
    | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
    | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string };
type ResponseApiPayload = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string };

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
    thoughtSignature?: string;
    thought_signature?: string;
};
type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<{ name?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type GeminiStreamState = { buffer: string; text: string; toolCalls: ResponseToolCall[]; error?: string };
type RequestOptions = { signal?: AbortSignal };

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";
const GEMINI_SUPPORTED_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const GEMINI_IMAGE_SIZE_BY_QUALITY: Record<string, string> = { low: "1K", medium: "2K", high: "4K", standard: "1K", hd: "2K" };

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Only "transparent" is forwarded; empty/other means keep opaque default. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("图像比例必须是正数，例如 9:16");
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图像尺寸必须是正整数，例如 1024x1024");
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error("图像尺寸的宽高必须是 16 的倍数，请调整尺寸");
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error("图像尺寸最长边不能超过 3840px，请调整尺寸");
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error("图像总像素需在 655360 到 8294400 之间，请调整尺寸");
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
}

function resolveGeminiImageConfig(config: AiConfig) {
    const value = (config.size || "").trim();
    const dimensions = parseImageDimensions(value);
    const ratio = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
    // Gemini 支持更极端比例（如 21:9），用 parseRatioValue 匹配最近支持比例，避免被 OpenAI 3:1 校验误伤
    const aspectRatio = value && value.toLowerCase() !== "auto" ? closestGeminiAspectRatio(ratio) : undefined;
    const imageSize = supportsGeminiImageSize(config.model) ? resolveGeminiImageSize(config.quality, dimensions) : undefined;
    // Gemini 原生字段为 imageConfig；部分中转也可能读 responseFormat.image，两者都带上更稳
    const image = {
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(imageSize ? { imageSize } : {}),
    };
    if (!Object.keys(image).length) return {};
    return {
        imageConfig: image,
        responseFormat: { image },
    };
}

function closestGeminiAspectRatio(value: string) {
    const ratio = parseRatioValue(value);
    const target = ratio.width / ratio.height;
    return GEMINI_SUPPORTED_RATIOS.reduce((best, item) => {
        const current = parseRatioValue(item);
        const bestRatio = parseRatioValue(best);
        return Math.abs(current.width / current.height - target) < Math.abs(bestRatio.width / bestRatio.height - target) ? item : best;
    });
}

function resolveGeminiImageSize(quality: string, dimensions: { width: number; height: number } | null) {
    const normalizedQuality = normalizeQuality(quality || "");
    if (normalizedQuality) return GEMINI_IMAGE_SIZE_BY_QUALITY[normalizedQuality];
    if (!dimensions) return undefined;
    const edge = Math.max(dimensions.width, dimensions.height);
    if (edge <= 768) return "512";
    if (edge <= 1536) return "1K";
    if (edge <= 3072) return "2K";
    return "4K";
}

function supportsGeminiImageSize(model: string) {
    const value = (model || "").toLowerCase();
    return value.includes("gemini-3") || value.includes("3.1") || value.includes("3-pro");
}

function resolveImageDataUrl(item: Record<string, unknown>) {
    const b64 = readImageBase64(item);
    if (b64) {
        const mime = guessImageMimeFromBase64Field(item) || "image/png";
        return b64.startsWith("data:") ? b64 : `data:${mime};base64,${b64.replace(/^data:[^;]+;base64,/, "")}`;
    }
    if (typeof item.url === "string" && item.url) return item.url;
    if (typeof item.image_url === "string" && item.image_url) return item.image_url;
    if (item.image_url && typeof item.image_url === "object") {
        const nested = item.image_url as Record<string, unknown>;
        if (typeof nested.url === "string" && nested.url) return nested.url;
    }
    return null;
}

function readImageBase64(item: Record<string, unknown>) {
    for (const key of ["b64_json", "b64", "base64", "image_base64", "data"]) {
        const value = item[key];
        if (typeof value === "string" && value.trim()) {
            const text = value.trim();
            if (text.startsWith("data:image/") || looksLikeBase64(text)) return text;
        }
    }
    return "";
}

function guessImageMimeFromBase64Field(item: Record<string, unknown>) {
    if (typeof item.mime_type === "string" && item.mime_type.startsWith("image/")) return item.mime_type;
    if (typeof item.output_format === "string") {
        const format = item.output_format.toLowerCase();
        if (format === "jpeg" || format === "jpg") return "image/jpeg";
        if (format === "webp") return "image/webp";
    }
    return "image/png";
}

function looksLikeBase64(value: string) {
    if (value.length < 64) return false;
    return /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 200));
}

function parseImagePayload(payload: ImageApiResponse) {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new Error(payload.msg || "请求失败");
    }
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const images = rows
        .map((item) => resolveImageDataUrl(item as Record<string, unknown>))
        .filter((value): value is string => Boolean(value))
        .map((dataUrl) => ({ id: nanoid(), dataUrl }));

    if (images.length === 0) {
        throw new Error("接口没有返回图片");
    }

    // 中转站若忽略 response_format=b64_json，只给 imgen.x.ai 远程 URL，本机网络又访问不了时会“生成成功但看不见”。
    const onlyRemoteXai = images.every((image) => /^https?:\/\/(?:[\w.-]+\.)?imgen\.x\.ai\//i.test(image.dataUrl) || /^https?:\/\/(?:[\w.-]+\.)?cdn\.x\.ai\//i.test(image.dataUrl));
    if (onlyRemoteXai) {
        // 仍返回结果，让上层尝试展示/落盘；同时在 dataUrl 保持原样。上层 uploadImage 失败时会保留 remote URL。
        return images;
    }

    return images;
}

function extractUpstreamErrorMessage(data: unknown): string {
    if (!data || typeof data !== "object") return "";
    const row = data as {
        msg?: string;
        message?: string;
        error?: { message?: string; msg?: string } | string;
    };
    if (typeof row.msg === "string" && row.msg.trim()) return row.msg.trim();
    if (typeof row.message === "string" && row.message.trim()) return row.message.trim();
    if (typeof row.error === "string" && row.error.trim()) return row.error.trim();
    if (row.error && typeof row.error === "object") {
        if (typeof row.error.message === "string" && row.error.message.trim()) return row.error.message.trim();
        if (typeof row.error.msg === "string" && row.error.msg.trim()) return row.error.msg.trim();
    }
    return "";
}

/** New API / 中转侧「无渠道、上游宕机」等，换 body 形态重试也没用 */
export function isPermanentImageUpstreamFailure(error: unknown): boolean {
    if (!axios.isAxiosError(error) || !error.response) return false;
    const status = error.response.status;
    if (status === 401 || status === 403) return true;
    const message = extractUpstreamErrorMessage(error.response.data).toLowerCase();
    if (status === 503 || status === 502 || status === 504) {
        // 无可用渠道 / 上游不可用：继续刷候选 body 只会拖时间
        if (!message) return true;
        if (/no available channel|no channel|channel not found|无可用渠道|无渠道|未配置渠道|model_not_found|not have access|group not|distributor|upstream.*(down|unavailable|failed)|service unavailable|overloaded/i.test(message)) {
            return true;
        }
        // 其它 5xx 也视为本轮不必穷尽所有 body 变体（仍抛出可读错误）
        return true;
    }
    if (/no available channel|无可用渠道|无渠道可用|model not found|invalid token|insufficient quota|余额不足/i.test(message)) {
        return true;
    }
    return false;
}

function readAxiosError(error: unknown, fallback: string, context?: "generation" | "edit") {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError(error)) {
        const responseData = error.response?.data;
        const upstream = extractUpstreamErrorMessage(responseData);
        if (upstream) {
            return enhanceImageUpstreamError(upstream, context, fallback);
        }
        if (!error.response) return readNetworkError(error.code, fallback, context, error.message);
        return readStatusError(error.response.status, fallback, context);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? error.message : fallback;
}

function readNetworkError(code: string | undefined, fallback: string, context?: "generation" | "edit", rawMessage?: string) {
    const closed = /ERR_CONNECTION_CLOSED|ECONNRESET|socket hang up|Network Error|Failed to fetch/i.test(`${code || ""} ${rawMessage || ""}`);
    if (context === "edit") {
        if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
            return `${fallback}：图生图（/images/edits）连接超时。请减少参考图数量/分辨率后重试；若仍失败，当前中转可能不支持该模型的 edits`;
        }
        if (closed || !code) {
            return `${fallback}：图生图（/images/edits）连接被中转关闭。常见原因：① 渠道/模型不支持参考图编辑 ② 参考图 multipart 过大被掐断。可先去掉参考图走文生图，或换支持 /v1/images/edits 的模型/渠道；本机也可改用自定义调用脚本`;
        }
        return `${fallback}：无法连接图生图接口，请确认 Base URL 可从浏览器直连，且服务商支持 /v1/images/edits（不是只支持文生图 generations）`;
    }
    if (code === "ECONNABORTED" || code === "ETIMEDOUT") return `${fallback}：图片接口连接超时，请检查 Base URL、网络代理或服务商状态`;
    if (closed) {
        return `${fallback}：文生图连接被对端关闭（ERR_CONNECTION_CLOSED）。常见于中转限流/瞬时故障/代理干扰。建议：① 张数先设 1 ② 等几秒再试 ③ 渠道兼容预设用「脆弱中转」或「OpenAI 精简」④ 换网络或关系统代理试一次 ⑤ 确认套餐含 gpt-image。本站已对脆弱中转改为单张串行+间隔重试`;
    }
    return `${fallback}：无法连接到图片接口，请确认 Base URL 可从浏览器直连、服务商支持 /v1/images/generations，且没有被代理、防火墙或 CORS 策略拦截`;
}

function readStatusError(status: number | undefined, fallback: string, context?: "generation" | "edit") {
    if (status === 400) {
        return context === "edit"
            ? `${fallback}（400），当前渠道可能不接受该模型的参考图编辑，请检查模型是否支持图生图、参考图格式/张数，或去掉参考图改文生图`
            : `${fallback}（400），上游拒绝参数。内网 Grok2API 等常不支持 size/quality/比例字段——请换渠道支持的生图模型名，或清空参考图后重试；UI 上的比例/质量可能不会被该上游使用`;
    }
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 404) {
        return context === "edit"
            ? `${fallback}（404），当前渠道可能不支持 /images/edits（图生图）。请换支持图生图的模型/中转，或清空参考图改用文生图`
            : `${fallback}（404），当前渠道可能不支持 /images/generations 接口或所选图片模型，请确认模型与 Base URL 匹配`;
    }
    if (status === 413) return `${fallback}（413），参考图或请求体过大，请减少张数或使用更小分辨率的参考图`;
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    if (status === 502 || status === 503 || status === 504) {
        return context === "edit"
            ? `${fallback}（${status}），局域网 New API / 中转网关未能完成图生图。常见原因：① 管理后台该模型未绑定可用「渠道」或渠道已禁用 ② 上游 Grok/xAI 账号或 Key 失效 ③ 分组/令牌无权访问该模型。请打开 New API 控制台检查渠道与日志（本机请求路径本身已打到 /v1/images/edits）`
            : `${fallback}（${status}），中转网关或上游暂时不可用。请检查 New API 渠道状态、上游 Key 与额度后重试`;
    }
    return status ? `${fallback}：${status}` : fallback;
}

async function referenceImageToUploadFile(image: ReferenceImage) {
    const dataUrl = await ensureLocalImageDataUrl(image);
    // 中转 multipart 对大图很敏感；压缩后再传，降低 ERR_CONNECTION_CLOSED。
    const compact = dataUrl.startsWith("data:image/") ? await compressImageDataUrl(dataUrl, IMAGE_EDIT_MAX_EDGE, IMAGE_EDIT_JPEG_QUALITY) : dataUrl;
    const name = (image.name || "reference.png").replace(/\.[^.]+$/, "") + (compact.startsWith("data:image/jpeg") || compact.startsWith("data:image/jpg") ? ".jpg" : ".png");
    const type = compact.startsWith("data:image/jpeg") || compact.startsWith("data:image/jpg") ? "image/jpeg" : image.type || "image/png";
    return dataUrlToFile({ ...image, name, type, dataUrl: compact });
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function geminiBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    if (lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta")) return normalizedBaseUrl;
    return `${normalizedBaseUrl}/${isAiProxyBaseUrl(normalizedBaseUrl) ? "v1" : "v1beta"}`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: Pick<AiConfig, "baseUrl" | "model">, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    if (!action) return `${baseUrl}/models`;
    return `${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`;
}

function geminiHeaders(config: Pick<AiConfig, "baseUrl" | "apiKey">) {
    return {
        ...(config.apiKey.trim() ? { "x-goog-api-key": config.apiKey } : {}),
        "Content-Type": "application/json",
    };
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [message];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function parseToolResponse(payload: ResponseApiPayload): ToolResponseResult {
    const output = payload.output || [];
    const content =
        payload.output_text ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    const toolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: item.call_id || item.id || "",
            type: "function" as const,
            function: { name: item.name || "", arguments: item.arguments || "{}" },
        }))
        .filter((item) => item.id && item.function.name);
    return { content, toolCalls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "请求失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`);
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return readStatusError(response.status, fallback);
    try {
        return responseErrorMessage(JSON.parse(text)) || readStatusError(response.status, fallback);
    } catch {
        return text.slice(0, 300) || readStatusError(response.status, fallback);
    }
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta?.(state.text);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta?.(state.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeResponseStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    if (!response.body) {
        const payload = (await response.json()) as ResponseApiPayload;
        validateResponsePayload(payload);
        return parseToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeResponseStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeResponseStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    if (!state.payload) return { content: state.text, toolCalls: [] };
    validateResponsePayload(state.payload);
    const result = parseToolResponse(state.payload);
    return { ...result, content: state.text || result.content };
}

function toGeminiBody(config: AiConfig, messages: ResponseInputMessage[], extra?: Record<string, unknown>) {
    const systemText = [
        config.systemPrompt.trim(),
        ...messages.flatMap((message) => (!("type" in message) && message.role === "system" ? [geminiTextContent(message.content)] : [])),
    ]
        .filter(Boolean)
        .join("\n\n");
    const contents = toGeminiContents(messages.filter((message) => ("type" in message ? true : message.role !== "system")));
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

function toGeminiContents(messages: ResponseInputMessage[]): GeminiContent[] {
    const callNameById = new Map<string, string>();
    return messages.flatMap((message): GeminiContent[] => {
        if ("type" in message) {
            callNameById.set(message.call_id, message.name);
            return [{ role: "model", parts: [{ functionCall: { id: message.call_id, name: message.name, args: jsonObject(message.arguments) }, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }] }];
        }
        if (message.role === "tool") {
            const name = callNameById.get(message.tool_call_id) || "tool_result";
            return [{ role: "user", parts: [{ functionResponse: { id: message.tool_call_id, name, response: { result: jsonValue(message.content) } } }] }];
        }
        return [{ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }];
    });
}

function toGeminiParts(content: ResponseMessageContent): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: ResponseMessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function jsonObject(value: string): Record<string, unknown> {
    const parsed = jsonValue(value);
    return isRecord(parsed) ? parsed : {};
}

function jsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toGeminiToolOptions(tools: ResponseFunctionTool[], toolChoice: ToolChoice) {
    if (!tools.length) return {};
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const functionCallingConfig =
        typeof toolChoice === "object"
            ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] }
            : { mode: toolChoice === "required" ? "ANY" : "AUTO" };
    return {
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig },
    };
}

async function requestGeminiStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(`${geminiApiUrl(config, "streamGenerateContent")}?alt=sse`, {
        method: "POST",
        headers: geminiHeaders(config),
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    if (!response.body) {
        const payload = (await response.json()) as GeminiPayload;
        return parseGeminiToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeGeminiStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeGeminiStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    return { content: state.text, toolCalls: state.toolCalls };
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeGeminiStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function consumeGeminiStreamBlock(block: string, state: GeminiStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const result = parseGeminiToolResponse(JSON.parse(data) as GeminiPayload);
    if (result.content) {
        state.text += result.content;
        onDelta?.(state.text);
    }
    state.toolCalls.push(...result.toolCalls);
}

function parseGeminiToolResponse(payload: GeminiPayload): ToolResponseResult {
    validateGeminiPayload(payload);
    const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
    const content = parts.map((part) => part.text || "").join("");
    const toolCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name))
        .map((call) => {
            const part = parts.find((item) => item.functionCall === call);
            const thoughtSignature = part?.thoughtSignature || part?.thought_signature;
            return {
                id: call.id || nanoid(),
                type: "function" as const,
                function: { name: call.name || "", arguments: JSON.stringify(call.args || {}) },
                ...(thoughtSignature ? { thoughtSignature } : {}),
            };
        });
    return { content, toolCalls };
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGeminiImagesOnce(config, prompt, references, options));
    return (await Promise.all(requests)).flat();
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const image of references) {
        parts.push(toGeminiImagePart(await imageToDataUrl(image)));
    }
    const response = await axios.post<GeminiPayload>(
        geminiApiUrl(config, "generateContent"),
        {
            ...toGeminiBody(config, [{ role: "user", content: prompt }], {
                generationConfig: {
                    responseModalities: ["TEXT", "IMAGE"],
                    ...resolveGeminiImageConfig(config),
                },
            }),
            contents: [{ role: "user", parts }],
        },
        { headers: geminiHeaders(config), signal: options?.signal },
    );
    return parseGeminiImagePayload(response.data);
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return part.fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new Error("Gemini 接口没有返回图片");
    return images;
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<GeneratedImageResult[]> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    assertImageModel(requestConfig.model);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script) {
        try {
            const quality = normalizeQuality(config.quality);
            const requestSize = resolveRequestSize(quality, config.size);
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, prompt),
                images: [],
                params: { size: requestSize, quality, count: n, background: normalizeBackground(config.background) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, prompt, [], n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败", "generation"));
        }
    }
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    const channel = resolveModelChannel(config, config.model || config.imageModel);
    const strategy = getImageCompatStrategy(requestConfig.baseUrl, channel.compatProfile);
    const fullPrompt = withSystemPrompt(requestConfig, prompt);
    const grokOpts = strategy.sizeMode === "grok-aspect" ? resolveLanGrokImageOptions(config.quality, config.size) : null;
    // 脆弱中转（codex2api）：一次只生成 1 张，避免 n>1 或连打重试把连接掐断
    const requestCount = strategy.profile === "relay-fragile" ? 1 : n;

    const primaryBody: Record<string, unknown> = {
        model: requestConfig.model,
        prompt: fullPrompt,
        n: requestCount,
        response_format: "b64_json",
    };
    if (strategy.sizeMode === "grok-aspect" && grokOpts) {
        if (grokOpts.aspect_ratio) primaryBody.aspect_ratio = grokOpts.aspect_ratio;
        if (grokOpts.resolution) primaryBody.resolution = grokOpts.resolution;
    } else if (strategy.sizeMode === "openai-size") {
        if (requestSize) primaryBody.size = requestSize;
        if (strategy.includeQuality && quality) primaryBody.quality = quality;
        if (strategy.includeBackground && background) primaryBody.background = background;
        if (strategy.includeOutputFormat) primaryBody.output_format = IMAGE_OUTPUT_FORMAT;
    }

    const postGeneration = (body: Record<string, unknown>) =>
        axios.post<ImageApiResponse>(aiApiUrl(requestConfig, "/images/generations"), body, {
            headers: aiHeaders(requestConfig, "application/json"),
            signal: options?.signal,
            timeout: IMAGE_GEN_TIMEOUT_MS,
        });

    // 兜底：仅 model+prompt（部分网关极简）
    const bareBody: Record<string, unknown> = {
        model: requestConfig.model,
        prompt: fullPrompt,
        n: 1,
    };
    const minimalBody: Record<string, unknown> = {
        ...bareBody,
        response_format: "b64_json",
    };

    try {
        try {
            return parseImagePayload((await postGeneration(primaryBody)).data);
        } catch (error) {
            if (options?.signal?.aborted) throw error;
            if (!strategy.retrySlimOnError) throw error;
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            const closed = isConnectionClosedError(error);
            const retrySlim = closed || status === 400 || status === 422;
            if (!retrySlim) throw error;

            // 连接被掐：先等一会再原样重试 1 次（n=1），避免立刻连打多轮把中转打崩
            let lastError: unknown = error;
            if (closed) {
                try {
                    await sleep(1500, options?.signal);
                    return parseImagePayload((await postGeneration({ ...primaryBody, n: 1 })).data);
                } catch (retryError) {
                    if (options?.signal?.aborted) throw retryError;
                    lastError = retryError;
                }
            }

            // 参数类 400：再试更瘦 body（Grok 比例 / 极简字段）
            if (strategy.sizeMode === "grok-aspect" && grokOpts?.aspect_ratio && !isConnectionClosedError(lastError)) {
                try {
                    return parseImagePayload(
                        (
                            await postGeneration({
                                model: requestConfig.model,
                                prompt: fullPrompt,
                                n: 1,
                                response_format: "b64_json",
                                aspect_ratio: grokOpts.aspect_ratio,
                            })
                        ).data,
                    );
                } catch (e) {
                    lastError = e;
                }
            }

            // 脆弱中转在 connection closed 后不要再疯狂换 body 连打；等更久再极简试一次
            if (strategy.profile === "relay-fragile" && isConnectionClosedError(lastError)) {
                try {
                    await sleep(2500, options?.signal);
                    return parseImagePayload((await postGeneration(minimalBody)).data);
                } catch (e) {
                    throw new Error(readAxiosError(e, "请求失败", "generation"));
                }
            }

            try {
                if (isConnectionClosedError(lastError)) await sleep(1000, options?.signal);
                return parseImagePayload((await postGeneration(minimalBody)).data);
            } catch (error2) {
                if (options?.signal?.aborted) throw error2;
                const status2 = axios.isAxiosError(error2) ? error2.response?.status : undefined;
                if (status2 === 400 || status2 === 422 || isConnectionClosedError(error2)) {
                    if (isConnectionClosedError(error2)) await sleep(1200, options?.signal);
                    return parseImagePayload((await postGeneration(bareBody)).data);
                }
                throw error2;
            }
        }
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败", "generation"));
    }
}

/** UI 质量/尺寸 → Grok/xAI 系 aspect_ratio + resolution（1k/2k） */
function resolveLanGrokImageOptions(qualityRaw: string, sizeRaw: string) {
    const size = (sizeRaw || "").trim().toLowerCase();
    const quality = (qualityRaw || "").trim().toLowerCase();

    let aspect_ratio = "1:1";
    if (!size || size === "auto") {
        aspect_ratio = "1:1";
    } else if (size.includes(":")) {
        // "16:9" / "9:16" …
        aspect_ratio = size.split("-")[0] || size;
    } else {
        const m = size.match(/^(\d+)x(\d+)$/);
        if (m) {
            const w = Number(m[1]);
            const h = Number(m[2]);
            if (w > 0 && h > 0) aspect_ratio = nearestAspectRatio(w / h);
        }
    }

    // 质量 → 分辨率档；2k/4k 尺寸选项强制 2k
    let resolution: "1k" | "2k" = "1k";
    if (size.includes("2k") || size.includes("4k") || /^(2048|2160|3840)/.test(size)) resolution = "2k";
    else if (quality === "high" || quality === "hd") resolution = "2k";
    else if (quality === "medium" || quality === "low" || quality === "auto" || quality === "standard" || !quality) resolution = "1k";

    // 仅允许常见比例，避免上游 400
    const allowed = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
    if (!allowed.has(aspect_ratio)) aspect_ratio = nearestAspectRatioLabel(aspect_ratio);

    return { aspect_ratio, resolution };
}

function nearestAspectRatio(ratio: number) {
    const options: Array<[string, number]> = [
        ["1:1", 1],
        ["16:9", 16 / 9],
        ["9:16", 9 / 16],
        ["4:3", 4 / 3],
        ["3:4", 3 / 4],
        ["3:2", 3 / 2],
        ["2:3", 2 / 3],
    ];
    let best = options[0][0];
    let bestDiff = Infinity;
    for (const [label, value] of options) {
        const diff = Math.abs(Math.log(ratio) - Math.log(value));
        if (diff < bestDiff) {
            bestDiff = diff;
            best = label;
        }
    }
    return best;
}

function nearestAspectRatioLabel(label: string) {
    const m = label.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!m) return "1:1";
    return nearestAspectRatio(Number(m[1]) / Number(m[2]));
}

/**
 * 官方 xAI ImageGenerationModel（见 xai-sdk types/model.py）：
 *   grok-imagine-image | grok-imagine-image-pro | grok-imagine-image-quality
 * 官方图生图/多参考编辑与文生图共用同一模型族，靠请求是否带 image_url(s) 区分能力；
 * **没有** 单独的 grok-imagine-image-edit 模型名。
 * 部分中转仍暴露 *-edit 别名；仅当用户选中或渠道列表真实存在时才作为候选，绝不自动注入/跳转。
 */
const GROK_IMAGE_OFFICIAL = [
    "grok-imagine-image",
    "grok-imagine-image-pro",
    "grok-imagine-image-quality",
] as const;
/** 中转兼容别名（非官方 SDK 类型）；只在列表命中或用户已选时加入候选。 */
const GROK_IMAGE_RELAY_ALIASES = [
    "grok-imagine-image-edit",
    "grok-imagine-image-edit-quality",
    "grok-2-image-edit",
    "grok-2-image-1212",
    "grok-2-image",
] as const;

function isGrokImageEditModelName(name: string) {
    const n = name.toLowerCase();
    if (n.includes("video")) return false;
    if (n.includes("edit") && n.includes("image")) return true;
    if (n.includes("imagine-image-edit")) return true;
    return n.includes("imagine-image") || n.includes("image-quality") || (n.includes("grok") && n.includes("image") && !n.includes("video"));
}

function channelLooksLikeGrokImage(selectedName: string) {
    const lower = selectedName.toLowerCase();
    if (lower.includes("video")) return false;
    return (
        (lower.includes("grok") && (lower.includes("imagine") || lower.includes("image"))) ||
        lower.includes("imagine-image")
    );
}

/**
 * 同渠道内图生图模型候选。
 * 顺序：用户当前选择 → 官方 image/pro/quality（列表命中）→ 其它列表内 Grok 图模 → 中转 *-edit 别名（仅列表命中，不注入）。
 */
export function listGrokImageEditModelCandidates(config: AiConfig, selectedModelValue: string, channelOverride?: ModelChannel): string[] {
    const selected = (selectedModelValue || config.imageModel || config.model || "").trim();
    const channel = channelOverride || resolveModelChannel(config, selected);
    const fromName = modelOptionName(selected);
    const rawModels = (channel.models || []).map((m) => modelOptionName(m).trim()).filter(Boolean);
    const knownLower = new Map(rawModels.map((m) => [m.toLowerCase(), m] as const));
    const out: string[] = [];
    const push = (name: string) => {
        const n = (name || "").trim();
        if (!n) return;
        if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
    };

    // 1) 永远先用用户当前选择（官方图生图与文生共用 grok-imagine-image*）
    push(fromName);

    // 2) 官方模型名：列表命中才加入；列表为空且当前是 Grok 图模时补官方主名便于重试
    const grokImageChannel = channelLooksLikeGrokImage(fromName);
    for (const p of GROK_IMAGE_OFFICIAL) {
        const hit = knownLower.get(p) || rawModels.find((m) => m.toLowerCase() === p);
        if (hit) {
            push(hit);
            continue;
        }
        if (!rawModels.length && grokImageChannel) push(p);
    }

    // 3) 列表里其它 Grok 图模（含用户渠道自定义名）
    for (const m of rawModels) {
        if (isGrokImageEditModelName(m)) push(m);
    }

    // 4) 中转 *-edit 等别名：仅当渠道列表真实存在时加入，绝不凭空注入
    for (const p of GROK_IMAGE_RELAY_ALIASES) {
        const hit = knownLower.get(p) || rawModels.find((m) => m.toLowerCase().includes(p));
        if (hit) push(hit);
    }

    return out;
}

/**
 * 有参考图时 **不** 再自动改模型名。
 * 官方图生图用 grok-imagine-image（或 pro/quality）；是否带参考图由 /images/edits + image 字段决定，
 * 与是否叫 *-edit 无关。保留此函数供 UI 诊断与旧调用点兼容（始终 switched:false）。
 */
export function resolveImageModelForReferences(config: AiConfig, selectedModelValue: string): { modelValue: string; switched: boolean; from: string; to: string } {
    const selected = (selectedModelValue || config.imageModel || config.model || "").trim();
    const fromName = modelOptionName(selected);
    return { modelValue: selected, switched: false, from: fromName, to: fromName };
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions): Promise<GeneratedImageResult[]> {
    const selectedModel = config.model || config.imageModel;
    // 用户给所选模型配置的脚本必须优先。官方图生图与文生共用 grok-imagine-image*，不再自动改成 *-edit。
    const selectedScript = resolveModelScript(config, selectedModel);
    // resolveImageModelForReferences 现始终 switched:false，保留调用仅兼容诊断/旧路径。
    const auto = references.length && !mask && !selectedScript ? resolveImageModelForReferences(config, selectedModel) : { modelValue: selectedModel, switched: false, from: "", to: "" };
    const effectiveConfig = auto.switched ? { ...config, model: auto.modelValue, imageModel: auto.modelValue } : config;

    const requestConfig = resolveModelRequestConfig(effectiveConfig, effectiveConfig.model || effectiveConfig.imageModel);
    assertImageModel(requestConfig.model);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const script = resolveModelScript(effectiveConfig, effectiveConfig.model || effectiveConfig.imageModel);
    // 内置 edits 与 UI 上限一致；脚本可在 SCRIPT 上限内自行消费（不静默截断）
    const maxReferences = script ? SCRIPT_IMAGE_REFERENCE_LIMIT : BYOK_IMAGE_REFERENCE_LIMIT;
    if (references.length > maxReferences) {
        throw new Error(`图生图最多支持 ${maxReferences} 张参考图；请删减后重试${script ? "" : "，或为当前模型配置自定义调用脚本"}`);
    }
    const requestReferences = references;
    const requestPrompt = buildImageReferencePromptText(prompt, requestReferences, effectiveConfig);
    if (script) {
        if (mask) throw new Error("自定义模型调用脚本暂不支持蒙版编辑，请清空脚本或改用系统默认调用");
        try {
            const quality = normalizeQuality(config.quality);
            const requestSize = resolveRequestSize(quality, config.size);
            const refs = await Promise.all(
                references.map(async (image) => {
                    try {
                        return (await ensureLocalImageDataUrl(image)) || image.dataUrl || "";
                    } catch {
                        return image.dataUrl || "";
                    }
                }),
            );
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, requestPrompt),
                images: refs.filter(Boolean),
                params: { size: requestSize, quality, count: n, background: normalizeBackground(config.background) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        if (mask) throw new Error("Gemini 调用格式暂不支持蒙版编辑");
        try {
            return await requestGeminiImages(requestConfig, requestPrompt, requestReferences, n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }

    // 渠道兼容：Grok JSON edits；fragile 旁路；其它标准 OpenAI multipart edits。
    const editChannel = resolveModelChannel(effectiveConfig, effectiveConfig.model || effectiveConfig.imageModel);
    const editStrategy = getImageCompatStrategy(requestConfig.baseUrl, editChannel.compatProfile);
    const modelName = (requestConfig.model || "").toLowerCase();
    const looksLikeGrokImage = modelName.includes("grok") && (modelName.includes("imagine") || modelName.includes("image"));

    // xAI / Grok2API：POST /images/edits 仅 application/json（不支持 OpenAI multipart）
    // 见 https://docs.x.ai/developers/model-capabilities/images/editing
    if (!mask && (editStrategy.profile === "grok-image" || looksLikeGrokImage)) {
        return requestGrokJsonImageEdit(requestConfig, effectiveConfig, requestPrompt, requestReferences, n, options);
    }

    if (editStrategy.editFallbackFragile && !mask) {
        return requestEditOnFragileRelay(requestConfig, effectiveConfig, requestPrompt, requestReferences, n, options);
    }

    return requestOpenAiCompatibleEdit(requestConfig, effectiveConfig, requestPrompt, requestReferences, mask, n, options, {
        slim: editStrategy.profile === "openai-slim" || editStrategy.profile === "relay-fragile",
    });
}

/**
 * Grok / xAI / Grok2API 图生图：JSON body + data URL，不是 multipart。
 * image: { type, url } 或 images: [...]；可选 aspect_ratio / resolution / response_format。
 */
async function requestGrokJsonImageEdit(
    requestConfig: AiConfig,
    config: AiConfig,
    requestPrompt: string,
    references: ReferenceImage[],
    n: number,
    options?: RequestOptions,
): Promise<GeneratedImageResult[]> {
    if (!references.length) throw new Error("图生图需要至少一张参考图");

    let dataUrls: string[];
    try {
        dataUrls = await Promise.all(
            references.map(async (image) => {
                const dataUrl = await ensureLocalImageDataUrl(image);
                if (!dataUrl?.startsWith("data:image/")) {
                    throw new Error("参考图无法读取为本地图片，请重新上传本地图后再试");
                }
                // 控制 JSON body 体积，降低中转掐断概率
                return compressImageDataUrl(dataUrl, IMAGE_EDIT_MAX_EDGE, IMAGE_EDIT_JPEG_QUALITY);
            }),
        );
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : "参考图无法读取，请重新上传本地图片后再试图生图");
    }

    const grokOpts = resolveLanGrokImageOptions(config.quality, config.size);
    const fullPrompt = withSystemPrompt(requestConfig, requestPrompt);
    // Grok 多图编辑需要明确告诉上游“全部参考图都要参与”；保留多图增强提示。
    // 单图或普通编号前缀仍尽量瘦身，避免无关说明干扰。
    const userPrompt = (config.systemPrompt || "").trim()
        ? fullPrompt
        : (references.length > 1
            ? requestPrompt
            : (requestPrompt.includes("参考图片编号") ? requestPrompt.replace(/^参考图片编号：.*?\n\n/s, "").trim() || requestPrompt : requestPrompt));

    const multiImageObjects = dataUrls.map((url) => ({ url }));
    const singleImageObject = { url: dataUrls[0] };
    const count = Math.max(1, Math.min(4, n));
    const isMultiReference = dataUrls.length > 1;
    // 多模型候选：优先 edit，再 quality 等（同渠道列表 + 硬编码后备）
    const selectedModel = config.model || config.imageModel;
    const selectedChannel = resolveModelChannel(config, selectedModel);
    const modelCandidates = listGrokImageEditModelCandidates(config, selectedModel, selectedChannel);
    const models: string[] = [];
    const pushModel = (model: string) => {
        const name = modelOptionName(model).trim();
        if (name && !models.some((item) => item.toLowerCase() === name.toLowerCase())) models.push(name);
    };
    // requestConfig.model 是 requestEdit 已解析并保持渠道归属的最终模型，必须成为首个真实 POST。
    pushModel(requestConfig.model);
    modelCandidates.forEach(pushModel);

    const candidates: Record<string, unknown>[] = [];
    const push = (body: Record<string, unknown>) => {
        const key = JSON.stringify(body);
        if (candidates.some((c) => JSON.stringify(c) === key)) return;
        candidates.push(body);
    };

    for (const model of models) {
        if (isMultiReference) {
            // 多图时只尝试真正的 multi-image 形态，避免中转静默退化成“只吃第一张”。
            push({
                model,
                prompt: userPrompt,
                n: count,
                response_format: "b64_json",
                images: multiImageObjects,
                ...(grokOpts.aspect_ratio ? { aspect_ratio: grokOpts.aspect_ratio } : {}),
                ...(grokOpts.resolution ? { resolution: grokOpts.resolution } : {}),
            });
            push({
                model,
                prompt: userPrompt,
                n: count,
                response_format: "b64_json",
                images: multiImageObjects,
                ...(grokOpts.aspect_ratio ? { aspect_ratio: grokOpts.aspect_ratio } : {}),
            });
            // 一些 Grok 中转把 SDK 里的 image_urls 直接透到 HTTP 层。
            push({
                model,
                prompt: userPrompt,
                n: count,
                response_format: "b64_json",
                image_urls: dataUrls,
                ...(grokOpts.aspect_ratio ? { aspect_ratio: grokOpts.aspect_ratio } : {}),
                ...(grokOpts.resolution ? { resolution: grokOpts.resolution } : {}),
            });
            // 兼容只接受字符串数组的中转。
            push({ model, prompt: userPrompt, n: count, response_format: "b64_json", images: dataUrls });
            push({ model, prompt: userPrompt, n: count, images: dataUrls });
            continue;
        }

        push({
            model,
            prompt: userPrompt,
            n: count,
            response_format: "b64_json",
            image: singleImageObject,
            ...(grokOpts.aspect_ratio ? { aspect_ratio: grokOpts.aspect_ratio } : {}),
            ...(grokOpts.resolution ? { resolution: grokOpts.resolution } : {}),
        });
        push({
            model,
            prompt: userPrompt,
            n: 1,
            response_format: "b64_json",
            image: singleImageObject,
            ...(grokOpts.aspect_ratio ? { aspect_ratio: grokOpts.aspect_ratio } : {}),
        });
        push({ model, prompt: userPrompt, n: 1, response_format: "b64_json", image: { url: dataUrls[0] } });
        // 部分网关 image 为纯 data URI 字符串
        push({ model, prompt: userPrompt, n: 1, response_format: "b64_json", image: dataUrls[0] });
    }

    let lastError: unknown;
    for (let i = 0; i < candidates.length; i += 1) {
        if (options?.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        try {
            if (i > 0) await sleep(500, options?.signal);
            const response = await axios.post<ImageApiResponse>(aiApiUrl(requestConfig, "/images/edits"), candidates[i], {
                headers: aiHeaders(requestConfig, "application/json"),
                signal: options?.signal,
                timeout: IMAGE_EDIT_TIMEOUT_MS,
            });
            return parseImagePayload(response.data);
        } catch (error) {
            lastError = error;
            // 鉴权失败 / New API 无渠道 / 网关 5xx：换 body 形态也没用，立刻停
            if (isPermanentImageUpstreamFailure(error)) {
                break;
            }
            if (axios.isAxiosError(error) && error.response && references.length > 1 && i === 0) {
                const upstream = readAxiosError(error, "图生图失败", "edit");
                if (/only one image|single image|exactly 1 image|multiple images not supported|too many images/i.test(upstream)) {
                    throw new Error(`当前中转站的 Grok 图生图接口不支持多参考图：${upstream}`);
                }
            }
            if (isConnectionClosedError(error)) {
                try {
                    await sleep(1200, options?.signal);
                } catch {
                    throw error;
                }
            }
        }
    }

    throw new Error(readAxiosError(lastError, "图生图失败", "edit"));
}

async function requestOpenAiCompatibleEdit(
    requestConfig: AiConfig,
    config: AiConfig,
    requestPrompt: string,
    references: ReferenceImage[],
    mask: ReferenceImage | undefined,
    n: number,
    options: RequestOptions | undefined,
    mode: { slim: boolean },
) {
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    const formData = new FormData();
    formData.set("model", requestConfig.model);
    formData.set("prompt", withSystemPrompt(requestConfig, requestPrompt));
    formData.set("n", String(n));
    formData.set("response_format", "b64_json");
    // 脆弱中转：不带 output_format / 可选 quality，减少 multipart 被掐断
    if (!mode.slim) {
        formData.set("output_format", IMAGE_OUTPUT_FORMAT);
        if (quality) formData.set("quality", quality);
    }
    if (requestSize) formData.set("size", requestSize);
    if (background && !mode.slim) formData.set("background", background);

    let files: File[];
    try {
        files = await Promise.all(references.map((image) => referenceImageToUploadFile(image)));
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : "参考图无法读取，请重新上传本地图片后再试图生图");
    }
    files.forEach((file) => formData.append("image", file));
    if (mask) {
        if (!mask.dataUrl.startsWith("data:")) throw new Error("蒙版图片无法读取，请重新上传本地图片");
        formData.set("mask", dataUrlToFile(mask));
    }

    const response = await axios.post<ImageApiResponse>(aiApiUrl(requestConfig, "/images/edits"), formData, {
        headers: aiHeaders(requestConfig),
        signal: options?.signal,
        timeout: IMAGE_EDIT_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });
    return parseImagePayload(response.data);
}

/**
 * 仅 fragile 中转（codex2api 等），无蒙版：
 * 1) 瘦身 edits（多数会 connection closed，只试一次）
 * 2) generations + 缩小后的参考图字段（少候选，避免刷屏）
 * 3) 仍失败 → 降级纯文生图并标记 degradedFromEdit（不静默丢参考意图）
 * 不碰 Gemini / 自定义脚本 / 其它 Base URL / 蒙版编辑。
 */
async function requestEditOnFragileRelay(requestConfig: AiConfig, config: AiConfig, requestPrompt: string, references: ReferenceImage[], n: number, options?: RequestOptions): Promise<GeneratedImageResult[]> {
    let editsError: unknown;
    try {
        return await requestOpenAiCompatibleEdit(requestConfig, config, requestPrompt, references, undefined, n, options, { slim: true });
    } catch (error) {
        editsError = error;
        if (options?.signal?.aborted || !shouldFallbackEditOnFragileRelay(error)) {
            throw new Error(readAxiosError(error, "图生图失败", "edit"));
        }
    }

    let primary = "";
    try {
        const dataUrl = await ensureLocalImageDataUrl(references[0]);
        if (dataUrl.startsWith("data:image/")) {
            primary = await compressImageDataUrl(dataUrl, FRAGILE_REF_MAX_EDGE, FRAGILE_REF_JPEG_QUALITY);
            // 仍偏大再压一档，降低 JSON body 被中转掐断概率
            if (primary.length > 400_000) {
                primary = await compressImageDataUrl(primary, 512, 0.65);
            }
        } else {
            primary = dataUrl;
        }
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : "参考图无法读取，请重新上传本地图片后再试图生图");
    }
    if (!primary.startsWith("data:image/")) {
        throw new Error(readAxiosError(editsError, "图生图失败", "edit"));
    }

    const fullPrompt = withSystemPrompt(requestConfig, requestPrompt);
    // 只试 2 个带图候选（dataURL / raw b64），避免多次 CONNECTION_CLOSED 刷控制台
    const candidates: Record<string, unknown>[] = [
        { model: requestConfig.model, prompt: fullPrompt, n: 1, response_format: "b64_json", image: primary },
        { model: requestConfig.model, prompt: fullPrompt, n: 1, response_format: "b64_json", image: dataUrlToRawBase64(primary) },
    ];

    let lastError: unknown = editsError;
    let allConnectionClosed = isConnectionClosedError(editsError);
    for (const body of candidates) {
        if (options?.signal?.aborted) break;
        try {
            const response = await axios.post<ImageApiResponse>(aiApiUrl(requestConfig, "/images/generations"), body, {
                headers: aiHeaders(requestConfig, "application/json"),
                signal: options?.signal,
                timeout: IMAGE_GEN_TIMEOUT_MS,
            });
            return parseImagePayload(response.data);
        } catch (error) {
            lastError = error;
            allConnectionClosed = allConnectionClosed && isConnectionClosedError(error);
            if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403 || error.response?.status === 429)) {
                break;
            }
            if (!isConnectionClosedError(error) && axios.isAxiosError(error) && error.response && ![400, 404, 405, 415, 501].includes(error.response.status || 0)) {
                break;
            }
        }
    }

    // 最后手段：该中转对「带图」请求一律掐连接时，降级纯文生图（仅 fragile + 无蒙版）
    if (!options?.signal?.aborted && allConnectionClosed) {
        try {
            const degradedPrompt = `${requestPrompt}\n\n（说明：当前中转不支持参考图编辑，已按文生图生成，未实际使用参考图像素。）`;
            const images = await requestGeneration({ ...config, model: requestConfig.model, count: String(n) }, degradedPrompt, options);
            return markDegraded(
                images,
                "当前中转（如 codex2api）的 gpt-image 无法走 /images/edits，带参考图的 generations 也被关闭，已降级为纯文生图；参考图未参与生成。",
            );
        } catch {
            // 文生图也挂则抛出旁路错误
        }
    }

    throw new Error(
        `${readAxiosError(lastError, "图生图失败", "edit")}（已尝试 edits、generations 参考图旁路；当前中转可能不支持 gpt-image 参考图。可清空参考图只用文生图，或换支持 edits 的渠道）`,
    );
}

function assertImageModel(model: string) {
    if (modelMatchesCapability(model, "video")) throw new Error(`当前选择的是「${modelOptionName(model)}」，它是视频模型。请切换到视频生成，或在配置中选择图片模型。`);
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const selectedTextModel = (config.textModel || config.model || "").trim();
    const requestConfig = resolveModelRequestConfig(config, selectedTextModel);
    const script = resolveModelScript(config, selectedTextModel);
    try {
        if (script) {
            const answer =
                (await runModelPlugin<string>({
                    capability: "text",
                    script,
                    config: requestConfig,
                    messages: withSystemMessage(requestConfig, messages),
                    signal: options?.signal,
                    onDelta,
                })) || "没有返回内容";
            if (answer === "没有返回内容") onDelta(answer);
            return answer;
        }
        if (requestConfig.apiFormat === "gemini") {
            const answer = (await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages), onDelta, options)).content || "没有返回内容";
            if (answer === "没有返回内容") onDelta(answer);
            return answer;
        }
        const answer = (await requestStreamingResponse(requestConfig, {
            model: requestConfig.model,
            input: toResponseInput(withSystemMessage(requestConfig, messages)),
        }, onDelta, options)).content || "没有返回内容";
        if (answer === "没有返回内容") onDelta(answer);
        return answer;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestToolResponse(config: AiConfig, messages: ResponseInputMessage[], tools: ResponseFunctionTool[], toolChoice: ToolChoice = "auto", onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const selectedTextModel = (config.textModel || config.model || "").trim();
    const requestConfig = resolveModelRequestConfig(config, selectedTextModel);
    // Tool/function-calling stays on the system path even if a text model has a custom script.
    // Custom scripts only cover plain prompt/messages return shapes, not tool schemas.
    try {
        if (requestConfig.apiFormat === "gemini") {
            return await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages, toGeminiToolOptions(tools, toolChoice)), onDelta, options);
        }
        return await requestStreamingResponse(requestConfig, {
            model: requestConfig.model,
            input: toResponseInput(withSystemMessage(requestConfig, messages)),
            tools: tools.map(toResponseTool),
            tool_choice: toolChoice,
            parallel_tool_calls: false,
        }, onDelta, options);
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat">) {
    try {
        if (config.apiFormat === "gemini") {
            const response = await axios.get<GeminiPayload>(geminiApiUrl({ ...defaultGeminiConfig, ...config }), { headers: geminiHeaders({ ...defaultGeminiConfig, ...config }) });
            validateGeminiPayload(response.data);
            return Array.from(
                new Set(
                    (response.data.models || [])
                        .map((model) => model.name?.replace(/^models\//, ""))
                        .filter((id): id is string => Boolean(id)),
                ),
            ).sort((a, b) => a.localeCompare(b));
        }
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
        });
        return Array.from(
            new Set(
                (response.data.data || [])
                    .map((model) => model.id)
                    .filter((id): id is string => Boolean(id)),
            ),
        ).sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}

export async function fetchChannelModels(channel: ModelChannel) {
    const models = await fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat });
    // openai2api 等：/models 常只有 sora-2，VIDEO 端点却要 azure-sora → 本地补可选别名
    return withSoraRelayModelAliases(models);
}

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};
