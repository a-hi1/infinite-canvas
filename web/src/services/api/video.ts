import axios from "axios";
import { nanoid } from "nanoid";

import { compressImageDataUrl, dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { AGNES_VIDEO_HEIGHT, AGNES_VIDEO_WIDTH, agnesFrameCount, agnesVideoRequestError, isAgnesBaseUrl, isAgnesVideoConfig, normalizeAgnesDuration } from "@/lib/agnes-video";
import {
    GROK_EDIT_REFERENCE_LIMITS,
    grokEditVideoReferenceError,
    isCodex2apiBaseUrl,
    isGrokVideoConfig,
    isXaiBaseUrl,
    normalizeGrokAspectRatio,
    normalizeGrokDuration,
    normalizeGrokResolution,
} from "@/lib/grok-video";
import { boolConfig, buildSeedancePromptText, isArkPlanBaseUrl, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import {
    buildSoraVeoFormFieldCandidates,
    isInvalidVideoRequestBodyError,
    isMissingSoraVeoCreatePathError,
    isMultiImageSoraVeoReferenceField,
    isSoraOrVeoVideoModel,
    isSoraVideoModel,
    isUnavailableVideoChannelError,
    isUnsupportedVideoModelError,
    isVeoI2vModel,
    isVeoVideoModel,
    parseSupportedVideoModelsFromError,
    shouldSkipToNextVideoModelName,
    shouldTryNextSoraVeoCreatePath,
    preferSoraRelayModelName,
    preferVeoI2vModelName,
    soraRequestModelCandidates,
    soraVeoCreatePathCandidates,
    soraVeoReferenceImageLimit,
    type SoraVeoReferenceField,
} from "@/lib/openai-compatible-video";
import { runModelPlugin } from "@/services/api/model-plugin";
import { AI_PROXY_BASE_URL, buildApiUrl, encodeChannelModel, isAiProxyBaseUrl, isLanAiBaseUrl, isSameOriginRelayBaseUrl, LAN_AI_BASE_URL, modelOptionName, resolveModelChannel, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = {
    id: string;
    status?: string;
    error?: { message?: string };
    url?: string;
    result_url?: string;
    video_url?: string;
    content?: { video_url?: string; url?: string } | null;
    /** 部分中转轮询返回 0–100；100 可当完成信号 */
    progress?: number;
};
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type GrokVideoAsset = { url?: string; video_url?: string; output_url?: string; download_url?: string; [key: string]: unknown };
type GrokVideoResponse = {
    id?: string;
    request_id?: string;
    status?: string;
    url?: string;
    video_url?: string;
    output_url?: string;
    download_url?: string;
    result_url?: string;
    video?: string | GrokVideoAsset | GrokVideoAsset[];
    data?: unknown;
    response?: GrokVideoAsset & { videos?: GrokVideoAsset[] };
    result?: GrokVideoAsset & { videos?: GrokVideoAsset[] };
    content?: GrokVideoAsset | null;
    videos?: GrokVideoAsset[];
    output?: string | string[] | GrokVideoAsset | GrokVideoAsset[];
    error?: string | { message?: string };
    message?: string;
    msg?: string;
    [key: string]: unknown;
};
type ApiGrokVideoResponse = GrokVideoResponse | { code?: number | string; data?: GrokVideoResponse | null; msg?: string; message?: string };
type AgnesTaskResponse = { video_id?: string; id?: string; status?: string; video_url?: string; url?: string; result_url?: string; metadata?: { url?: string }; error?: string | { message?: string }; message?: string; msg?: string };
type ApiAgnesResponse = AgnesTaskResponse | { code?: number | string; data?: AgnesTaskResponse | null; msg?: string; message?: string };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "completed" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
    url?: string;
    result_url?: string;
    video_url?: string;
};
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = {
    id: string;
    provider: "openai" | "seedance" | "agnes" | "grok" | "script";
    model: string;
    requestModel?: string;
    /** Sora/Veo 实际打通的创建路径，如 /videos 或 /video/generations；轮询优先对齐 */
    createPath?: string;
    /** 用户在 UI 选择的清晰度（Grok 如 1080p）；用于结果对照，不代表上游一定交付 */
    requestedResolution?: string;
    /** 创建成功时实际写入请求的 resolution（可能因创建失败后降档而低于 requested） */
    acceptedResolution?: string;
    readyResult?: VideoGenerationResult;
};
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** One-shot scripted video results (script does its own create+poll). */
const scriptVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

/** 轮询预算：Sora/Veo 中转常 5～15 分钟；Grok/Seedance/Agnes 保持原节奏 */
export function videoPollBudget(task: Pick<VideoGenerationTask, "provider" | "model" | "requestModel">): {
    delayMs: number;
    maxAttempts: number;
    isSoraVeo: boolean;
    timeoutLabel: string;
} {
    const isSoraVeo = task.provider === "openai" && isSoraOrVeoVideoModel(task.requestModel || task.model);
    if (task.provider === "seedance" || task.provider === "agnes" || task.provider === "grok") {
        return { delayMs: 5000, maxAttempts: 120, isSoraVeo: false, timeoutLabel: task.provider === "seedance" ? "Seedance " : task.provider === "agnes" ? "Agnes " : "" };
    }
    if (isSoraVeo) {
        // 300 × 3s ≈ 15 分钟（参考脚本 300s 偏紧，中转排队常更久）
        return { delayMs: 3000, maxAttempts: 300, isSoraVeo: true, timeoutLabel: "Sora/Veo " };
    }
    return { delayMs: 2500, maxAttempts: 120, isSoraVeo: false, timeoutLabel: "" };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    const budget = videoPollBudget(task);
    for (let attempt = 0; attempt < budget.maxAttempts; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === budget.maxAttempts - 1) {
            throw new Error(
                `${budget.timeoutLabel}视频生成超时，请稍后重试` + (budget.isSoraVeo ? "（中转排队较慢时可到历史记录里继续查询）" : ""),
            );
        }
        await delay(budget.delayMs, options?.signal);
    }
    throw new Error("视频生成超时，请稍后重试");
}

/**
 * 有参考图时：
 * 1) Grok 图片模型 → 同渠道视频模型（1.5/i2v 仅兜底）
 * 2) Veo 非 i2v → 同渠道 veo-*-i2v（若有）
 * Sora 别名映射（sora-2 → azure-sora）在创建任务时处理（文生/图生都需要），此处不改。
 * Grok/Seedance/Agnes 其它路径不变。
 */
export function resolveVideoModelForReferences(config: AiConfig, selectedModelValue: string): { modelValue: string; switched: boolean; from: string; to: string } {
    const selected = (selectedModelValue || config.videoModel || config.model || "").trim();
    const channel = resolveModelChannel(config, selected);
    const fromName = modelOptionName(selected);
    const fromLower = fromName.toLowerCase();
    const raw = (channel.models || []).map((m) => modelOptionName(m).trim()).filter(Boolean);

    // Veo：有参考图时优先同渠道 i2v 变体（不碰 Grok/Sora）
    if (isVeoVideoModel(fromName) && !isVeoI2vModel(fromName)) {
        const preferred = preferVeoI2vModelName(fromName, raw);
        if (preferred && preferred.toLowerCase() !== fromLower) {
            return { modelValue: encodeChannelModel(channel.id, preferred), switched: true, from: fromName, to: preferred };
        }
        return { modelValue: selected, switched: false, from: fromName, to: fromName };
    }

    const isGrok =
        isGrokVideoConfig({ ...config, model: selected, videoModel: selected, baseUrl: channel.baseUrl }) ||
        (fromLower.includes("grok") && (fromLower.includes("video") || fromLower.includes("imagine")));
    if (!isGrok) return { modelValue: selected, switched: false, from: fromName, to: fromName };

    const pick = (pred: (n: string) => boolean) => raw.find((m) => pred(m.toLowerCase())) || "";
    // 已是明确视频模型则保留（含用户选的 1.5 / 基础 video）
    if (fromLower.includes("video") || fromLower.includes("imagine-video")) {
        return { modelValue: selected, switched: false, from: fromName, to: fromName };
    }
    // 从图片模型切视频：基础 video 优先，1.5/i2v 仅兜底（避免多参考图先撞「仅 1 张首图」）
    const preferred =
        pick((n) => n.includes("grok") && n.includes("video") && !n.includes("1.5") && !n.includes("i2v") && !n.includes("image-to-video")) ||
        pick((n) => n.includes("grok") && n.includes("video")) ||
        pick((n) => n.includes("grok") && n.includes("imagine") && !n.includes("image-quality"));
    if (!preferred || preferred.toLowerCase() === fromLower) {
        return { modelValue: selected, switched: false, from: fromName, to: fromName };
    }
    return { modelValue: encodeChannelModel(channel.id, preferred), switched: true, from: fromName, to: preferred };
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    let selectedModel = (config.model || config.videoModel).trim();
    // 用户给所选模型配置的脚本优先；自动切 I2V 模型不能绕过其 BYOK 调用逻辑。
    const selectedScript = resolveModelScript(config, selectedModel);
    if (references.length && !selectedScript) {
        const auto = resolveVideoModelForReferences(config, selectedModel);
        if (auto.switched) selectedModel = auto.modelValue;
    }
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = selectedScript || resolveModelScript(config, selectedModel);
    // Custom scripts win only when set; empty keeps Agnes/Seedance/Grok/OpenAI defaults.
    if (script) {
        if (videoReferences.length || audioReferences.length) {
            throw new Error("自定义模型调用脚本暂不支持参考视频/音频，请清空脚本或移除参考素材");
        }
        return createScriptVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    }
    assertVideoConfig(requestConfig, requestConfig.model);
    if (isAgnesVideoConfig(requestConfig)) {
        return createAgnesTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    }
    if (isSeedanceVideoConfig(requestConfig)) {
        return createSeedanceTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    }
    // Grok 单条参考视频 = edits（POST /videos/edits），与多图 generation 隔离；须在通用 throw 之前。
    if (isGrokVideoConfig(requestConfig) && videoReferences.length) {
        if (audioReferences.length) {
            throw new Error("Grok 视频编辑暂不支持参考音频，请移除音频后重试");
        }
        if (references.length) {
            throw new Error("Grok 不能同时使用参考图与参考视频：请只保留参考视频（edits）或只保留参考图（generation）");
        }
        return createGrokEditTask(requestConfig, selectedModel, prompt, videoReferences, options);
    }
    if (videoReferences.length || audioReferences.length) {
        throw new Error("当前视频接口不支持参考视频或参考音频，请切换到 Seedance 2.0 / 火山 Agent Plan / 支持 edits 的 Grok 中转，或移除参考素材");
    }
    if (isGrokVideoConfig(requestConfig)) {
        return createGrokTask(requestConfig, selectedModel, prompt, references, options);
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    // 创建接口若已直接返回可播放结果，跳过轮询（部分中转站同步返回 video.url）
    if (task.readyResult?.url || task.readyResult?.blob) {
        return { status: "completed", result: task.readyResult };
    }
    if (task.provider === "script") {
        const result = scriptVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: "脚本视频任务已失效，请重新生成" };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "agnes") return pollAgnesTask(requestConfig, task, options);
    if (task.provider === "seedance") return pollSeedanceTask(requestConfig, task, options);
    if (task.provider === "grok") return pollGrokTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

function buildVideoPluginParams(config: AiConfig) {
    return {
        // Script payloads commonly map this to JSON `duration`; keep it numeric.
        seconds: Number(normalizeVideoSeconds(config.videoSeconds)),
        size: normalizeVideoSize(config.size),
        resolution: normalizeVideoResolution(config.vquality),
        ratio: config.size,
        generateAudio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };
}

/** Exposed for regression tests of the custom video-script contract. */
export function videoPluginParamsForTest(config: AiConfig) {
    return buildVideoPluginParams(config);
}

async function createScriptVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim() && !isSameOriginRelayBaseUrl(config.baseUrl)) throw new Error("请先配置 API Key");
    const refs = await Promise.all(
        references.map(async (image) => {
            try {
                return await imageToDataUrl(image);
            } catch {
                return image.dataUrl || image.url || "";
            }
        }),
    );
    const result = videoScriptResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs.filter(Boolean),
            params: buildVideoPluginParams(config),
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    scriptVideoResults.set(id, result);
    return { id, provider: "script", model, readyResult: result };
}

function videoScriptResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error("模型调用脚本没有返回视频");
}

export async function storeGeneratedVideo(result: VideoGenerationResult, config?: AiConfig): Promise<UploadedFile> {
    if (result.blob) {
        const typed = ensureVideoBlob(result.blob, result.mimeType);
        return uploadMediaFile(typed, "video");
    }
    if (result.url) {
        // 尽量落本地 blob，便于上云；失败时保留 URL 给 <video src> 直接播放
        // （vidgen.x.ai 常允许 <video> 播，但禁止浏览器 JS fetch）。
        // 注意：不要在代理下载已失败后，仍把 /ai-proxy/media 写成最终播放地址——
        // 那会让预览必定 502；应回退到原始远端 URL 交给 <video> 直连尝试。
        // 内网 Grok 常返回 http://127.0.0.1:port 或局域网 IP：浏览器 CONNECTION_REFUSED，
        // 经 /lan-ai 同源中继后再下载/预览（仅当渠道或 URL 像内网服务时）。
        const originalUrl = unwrapMediaProxyUrl(result.url) || result.url;
        const playableUrl = rewritePrivateVideoUrlToLanRelay(originalUrl, config) || originalUrl;
        const candidates = videoDownloadCandidates(originalUrl, config);
        for (const candidate of candidates) {
            try {
                // /lan-ai 上的 /videos/.../content 通常要 Bearer，必须带渠道 Key 才能落盘
                const blob = await downloadVideoBlob(candidate, undefined, config);
                return uploadMediaFile(ensureVideoBlob(blob, result.mimeType), "video");
            } catch {
                // try next
            }
        }
        // 内网 content 需要鉴权时，不要把 127.0.0.1 或无 Key 的 /lan-ai 交给 <video>（会 REFUSED/401）
        if (playableUrl.startsWith(LAN_AI_BASE_URL) || isPrivateOrLoopbackHost(safeHostname(originalUrl))) {
            throw new Error(
                "视频已生成，但无法下载预览文件。内网地址（如 127.0.0.1:8000/.../content）需经 /lan-ai 且携带 API Key 拉取。请确认：① 渠道 Base URL 为 /lan-ai ② 已填写与内网服务一致的 API Key ③ LAN_AI_UPSTREAM 已配置并重建 app",
            );
        }
        return {
            url: playableUrl,
            storageKey: "",
            bytes: 0,
            mimeType: result.mimeType || "video/mp4",
        };
    }
    throw new Error("视频接口没有返回可播放的视频");
}

/**
 * 内网视频服务常在 JSON 里返回 127.0.0.1 / 局域网 IP 的 mp4 地址。
 * 浏览器页面在 localhost:3011 时直连会 CONNECTION_REFUSED；改写为同源 /lan-ai 路径。
 * 公网 CDN（vidgen 等）不改写。
 */
export function rewritePrivateVideoUrlToLanRelay(url: string, config?: AiConfig) {
    if (!url || !/^https?:\/\//i.test(url)) return "";
    if (isBrowserCorsBlockedVideoHost(url)) return "";
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return "";
    }
    if (!isPrivateOrLoopbackHost(parsed.hostname)) return "";
    // 环回/局域网 + 视频类路径一律改写（内网 Grok 常回 127.0.0.1:.../v1/videos/.../content）
    const channelIsLan = Boolean(config && isSameOriginRelayBaseUrl(config.baseUrl) && !isAiProxyBaseUrl(config.baseUrl));
    if (!channelIsLan && !looksLikeLanVideoService(parsed)) return "";
    const pathWithQuery = `${parsed.pathname || "/"}${parsed.search || ""}`;
    return `${LAN_AI_BASE_URL}${pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`}`;
}

function safeHostname(url: string) {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}

function isPrivateOrLoopbackHost(hostname: string) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1") return true;
    if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(host)) return true;
    return false;
}

function looksLikeLanVideoService(parsed: URL) {
    const path = parsed.pathname.toLowerCase();
    return (
        path.includes("/v1/") ||
        path.includes("/videos/") ||
        path.endsWith("/content") ||
        path.endsWith(".mp4") ||
        path.includes("/video") ||
        path.includes("/media") ||
        path.includes("/files")
    );
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    // Sora / Veo（New API 等）：禁止 resolution_name / preset，秒数与尺寸夹到上游枚举；invalid body 时换精简候选。
    // 其它 OpenAI 兼容模型保持原 multipart（含 resolution_name + preset），避免影响已有渠道。
    if (isSoraOrVeoVideoModel(modelName)) {
        return createSoraVeoOpenAiVideoTask(config, model, prompt, references, options);
    }

    // OpenAI / 多数中转站使用单数 input_reference 作为首帧/参考图；同名字段多次 append 兼容多图中转。
    // 远程 CORS 图拿不到二进制时不要强行 append，否则 dataUrlToFile 会失败或发出空字段请求。
    const files = (
        await Promise.all(
            references.slice(0, 7).map(async (image) => {
                const dataUrl = await resolveReferenceBinaryDataUrl(image);
                if (!dataUrl) return null;
                return dataUrlToFile({ ...image, dataUrl });
            }),
        )
    ).filter((file): file is File => Boolean(file));
    if (references.length && !files.length) {
        throw new Error("参考图是远程地址且浏览器无法读取（常见于 imgen.x.ai CORS）。请改用本地上传的参考图，或使用支持公网图片 URL 的 Grok /videos/generations 渠道");
    }

    const body = new FormData();
    body.append("model", modelName);
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    files.forEach((file) => body.append("input_reference", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务创建失败"));
    }
}

/**
 * Sora / Veo 经 OpenAI 兼容中转（含 New API / Azure 视频网关）创建任务。
 * 文生优先 JSON；图生只试带参考的候选（multipart 文件 + JSON images/input_reference/URL 字段），
 * **禁止**无参考文生成功（避免“任务成功但不跟图”）。
 * Sora：若渠道 VIDEO 端点不认 `sora-2`，会按清单/常见别名改试 `azure-sora`；图生仅 1 张首帧。
 * Veo：图生最多 3 张，优先 JSON `images` / `reference_images` 全量发送。
 * 不碰 Grok/Seedance/Agnes。
 */
async function createSoraVeoOpenAiVideoTask(
    config: AiConfig,
    model: string,
    prompt: string,
    references: ReferenceImage[],
    options?: RequestOptions,
): Promise<VideoGenerationTask> {
    const selectedName = modelOptionName(model);
    const imageLimit = soraVeoReferenceImageLimit(selectedName);
    // Sora 只取首帧；Veo 最多 3 张。禁止静默多图只发第一张（Veo 多图路径用数组字段）。
    const primaryRefs = references.slice(0, imageLimit);
    const hasUserReferences = primaryRefs.length > 0;
    const preparedList = hasUserReferences
        ? (await Promise.all(primaryRefs.map((item) => prepareSoraVeoReferenceAssets(item)))).filter((item) => item.file || item.dataUrl || item.publicUrl)
        : [];
    const prepared = preparedList[0] || { file: null as File | null, dataUrl: "", publicUrl: "" };
    const hasBinary = preparedList.some((item) => Boolean(item.file || item.dataUrl));
    const hasUrl = preparedList.some((item) => Boolean(item.publicUrl));
    if (hasUserReferences && !preparedList.length) {
        throw new Error("参考图是远程地址且浏览器无法读取（常见于 imgen.x.ai CORS）。Sora/Veo 图生请改用本地上传的参考图，或换可公网拉取的 https 图片 URL");
    }

    const channelModels = (config.channels || []).flatMap((channel) => channel.models || []).map((item) => modelOptionName(item));
    // 也合并当前 resolve 后的渠道 models（resolveModelRequestConfig 可能只带 baseUrl/key）
    const requestChannelModels = (() => {
        try {
            return (resolveModelChannel(config, model).models || []).map((item) => modelOptionName(item));
        } catch {
            return [] as string[];
        }
    })();
    const inventory = Array.from(new Set([...requestChannelModels, ...channelModels].filter(Boolean)));

    // 用可变队列：默认首包用用户选择（如 sora-2）；422 ModelModality 立刻换 azure-sora。
    // 若本 host 曾因 VIDEO 白名单拒收 sora-2、且 azure-sora 创建成功，下次优先 azure（仍保留 sora-2 作回退）。
    const modelNames = isSoraVideoModel(selectedName)
        ? orderSoraRequestModelsForHost(config, selectedName, inventory)
        : [preferVeoI2vModelName(selectedName, inventory) || selectedName].filter(Boolean);

    // 路径候选：参考脚本优先 POST /video/generations；官方 /videos；再 /videos/generations
    // 成功路径按 host 记忆，下次优先（不碰 Grok 路径表）
    const createPaths = orderSoraVeoCreatePaths(config);

    let lastError: unknown;
    const triedModels: string[] = [];
    const triedPaths: string[] = [];
    // 跨路径记住「VIDEO 模态明确拒收」的模型名，避免每条路径再刷一遍 sora-2 的 422
    const modalityRejectedLower = new Set<string>();
    const multipartFiles = preparedList.map((item) => item.file).filter((file): file is File => Boolean(file));

    for (const createPath of createPaths) {
        if (!triedPaths.includes(createPath)) triedPaths.push(createPath);
        const triedLower = new Set<string>();
        let pathDead = false; // 路径不存在 / 应立刻换路径

        for (let i = 0; i < modelNames.length; i += 1) {
            const requestModel = modelNames[i];
            const requestLower = requestModel.toLowerCase();
            if (triedLower.has(requestLower)) continue;
            // 本 host 本次请求里已被 ModelModality 拒收的名字：整次创建都不要再试
            if (modalityRejectedLower.has(requestLower)) continue;
            triedLower.add(requestLower);
            if (!triedModels.includes(requestModel)) triedModels.push(requestModel);
            const candidates = buildSoraVeoFormFieldCandidates({
                model: requestModel,
                prompt,
                size: config.size,
                videoSeconds: config.videoSeconds,
                hasReferences: hasUserReferences,
                hasBinaryReference: hasBinary,
                hasUrlReference: hasUrl,
                referenceCount: preparedList.length,
            });
            // 有参考时：只允许 withReferences 候选，绝不落到纯文生成功
            const runnable = hasUserReferences ? candidates.filter((item) => item.withReferences) : candidates.filter((item) => !item.withReferences);

            let skipToNextModel = false;
            let bodyExhaustedInvalid = false;
            for (const fields of runnable) {
                if (fields.withReferences && !hasBinary && !hasUrl) continue;
                if (fields.encoding === "multipart" && !multipartFiles.length) continue;
                try {
                    const created =
                        fields.encoding === "json"
                            ? await postSoraVeoJsonCreate(config, createPath, fields, preparedList, options)
                            : await postSoraVeoMultipartCreate(config, createPath, fields, multipartFiles, options);
                    if (!created.id) throw new Error("视频接口没有返回任务 ID");
                    rememberSoraVeoCreatePath(config, createPath);
                    // 若最终成功的是别名（如 azure-sora），记住本 host 偏好，减少下次 422
                    if (isSoraVideoModel(selectedName) && requestModel.toLowerCase() !== selectedName.toLowerCase()) {
                        rememberSoraPreferredRequestModel(config, requestModel);
                    } else if (isSoraVideoModel(selectedName)) {
                        // 用户原名直接成功：清掉错误的 azure 优先记忆
                        clearSoraPreferredRequestModel(config);
                    }
                    // 创建响应若已带可播 URL（部分中转同步完成），跳过轮询
                    const readyUrl = openAiCompatibleVideoUrl(created);
                    // 返回原始 UI 模型选择；上游实际 requestModel + 打通路径 createPath
                    return {
                        id: created.id,
                        provider: "openai",
                        model,
                        requestModel,
                        createPath,
                        ...(readyUrl ? { readyResult: { url: readyUrl } } : {}),
                    };
                } catch (error) {
                    lastError = error;
                    if (options?.signal?.aborted) throw new Error(readAxiosError(error, "视频任务创建失败"));
                    const message = readAxiosError(error, "");
                    // 合并 axios 原文 + 规范化文案，避免只剩短 message 时漏判 ModelModality
                    const errorBlob = `${message}\n${collectSoraCreateErrorBlob(error)}`;

                    // 路径不存在：立刻换下一条 create path，不继续刷 body/model
                    if (isMissingSoraVeoCreatePathError(error) || isMissingSoraVeoCreatePathError(message) || isMissingSoraVeoCreatePathError(errorBlob)) {
                        rememberSoraVeoCreatePathMissing(config, createPath);
                        pathDead = true;
                        break;
                    }

                    // 422 模型不被 VIDEO 端点支持，或 503 当前分组无可用上游：换下一个 model 名
                    // 注意：绝不能把 ModelModality 422 当最终错误抛出——必须继续试 azure-sora
                    if (
                        shouldSkipToNextVideoModelName(error) ||
                        shouldSkipToNextVideoModelName(message) ||
                        shouldSkipToNextVideoModelName(errorBlob) ||
                        isSoraVideoModalityRejectedError(errorBlob)
                    ) {
                        skipToNextModel = true;
                        if (isSoraVideoModel(selectedName) || isSoraVideoModel(requestModel)) {
                            const modalityRejected =
                                isUnsupportedVideoModelError(error) ||
                                isUnsupportedVideoModelError(message) ||
                                isUnsupportedVideoModelError(errorBlob) ||
                                isSoraVideoModalityRejectedError(errorBlob);
                            if (modalityRejected) {
                                modalityRejectedLower.add(requestLower);
                                // 从 422 Supported models 里抠 sora/azure 名，插到队列最前（紧挨当前之后）
                                const supported = parseSupportedVideoModelsFromError(errorBlob);
                                const aliases: string[] = [];
                                for (const name of supported) {
                                    const trimmed = modelOptionName(name).trim();
                                    if (!trimmed) continue;
                                    if (!isSoraVideoModel(trimmed) && !/azure[-_]?sora/i.test(trimmed)) continue;
                                    if (modalityRejectedLower.has(trimmed.toLowerCase())) continue;
                                    aliases.push(trimmed);
                                }
                                // 白名单没解析出来时，经典回退仍必须有 azure-sora
                                if (!aliases.some((item) => item.toLowerCase() === "azure-sora")) aliases.push("azure-sora");
                                if (!aliases.some((item) => item.toLowerCase() === "azure_sora")) aliases.push("azure_sora");
                                promoteSoraModelAliases(modelNames, i + 1, aliases, modalityRejectedLower);
                                // 本 host 明确拒收 sora-2 时，记住下次优先 azure
                                if (/sora-2|sora sora-2/i.test(errorBlob) && aliases.some((item) => /azure[-_]?sora/i.test(item))) {
                                    rememberSoraPreferredRequestModel(config, aliases.find((item) => /azure[-_]?sora/i.test(item)) || "azure-sora");
                                }
                            }
                            if (isUnavailableVideoChannelError(error) || isUnavailableVideoChannelError(message) || isUnavailableVideoChannelError(errorBlob)) {
                                // 503 无渠道：当前别名不可用，换其它 sora 名；不要标记 modalityRejected
                                promoteSoraModelAliases(modelNames, i + 1, ["sora-2", "azure_sora", "sora-2-pro", "azure-sora-pro", "azure-sora"], modalityRejectedLower);
                            }
                        }
                        break;
                    }

                    // body/上游兼容类：换 body 候选
                    if (isInvalidVideoRequestBodyError(error) || isInvalidVideoRequestBodyError(message) || isInvalidVideoRequestBodyError(errorBlob)) {
                        bodyExhaustedInvalid = true;
                        continue;
                    }

                    // 鉴权/额度/限流等直接结束
                    throw new Error(readAxiosError(error, "视频任务创建失败"));
                }
            }
            if (pathDead) break;
            if (skipToNextModel) continue;
            // 本路径上 body 穷举仍 invalid：换下一条创建路径（常见：/videos 拒 body，/video/generations 能通）
            if (bodyExhaustedInvalid && shouldTryNextSoraVeoCreatePath(lastError)) {
                pathDead = true;
                break;
            }
        }
        if (pathDead) continue;
    }

    throw new Error(
        enhanceSoraVeoCreateError(readAxiosError(lastError, "视频任务创建失败"), selectedName, hasUserReferences, triedModels, triedPaths),
    );
}

/** 按 host 记住 Sora/Veo 创建成功路径 / 不存在路径（与 Grok 缓存隔离） */
const soraVeoCreatePathMemory = new Map<string, { good?: string; missing: Set<string> }>();
/** 按 host 记住 VIDEO 端点实际吃得下的 Sora 请求名（如 azure-sora） */
const soraVeoModelNameMemory = new Map<string, string>();

function soraVeoPathMemoryKey(config: AiConfig) {
    return (config.baseUrl || "").trim().replace(/\/+$/, "").toLowerCase() || "default";
}

function orderSoraVeoCreatePaths(config: AiConfig): string[] {
    const key = soraVeoPathMemoryKey(config);
    const mem = soraVeoCreatePathMemory.get(key);
    const base = soraVeoCreatePathCandidates().filter((path) => !mem?.missing.has(path));
    if (mem?.good && base.includes(mem.good)) {
        return [mem.good, ...base.filter((path) => path !== mem.good)];
    }
    return base.length ? base : soraVeoCreatePathCandidates();
}

function rememberSoraVeoCreatePath(config: AiConfig, path: string) {
    const key = soraVeoPathMemoryKey(config);
    const mem = soraVeoCreatePathMemory.get(key) || { missing: new Set<string>() };
    mem.good = path;
    mem.missing.delete(path);
    soraVeoCreatePathMemory.set(key, mem);
}

function rememberSoraVeoCreatePathMissing(config: AiConfig, path: string) {
    const key = soraVeoPathMemoryKey(config);
    const mem = soraVeoCreatePathMemory.get(key) || { missing: new Set<string>() };
    mem.missing.add(path);
    if (mem.good === path) mem.good = undefined;
    soraVeoCreatePathMemory.set(key, mem);
}

function rememberSoraPreferredRequestModel(config: AiConfig, modelName: string) {
    const name = modelOptionName(modelName).trim();
    if (!name) return;
    soraVeoModelNameMemory.set(soraVeoPathMemoryKey(config), name);
}

function clearSoraPreferredRequestModel(config: AiConfig) {
    soraVeoModelNameMemory.delete(soraVeoPathMemoryKey(config));
}

function orderSoraRequestModelsForHost(config: AiConfig, selectedName: string, inventory: string[]): string[] {
    const base = [...soraRequestModelCandidates(selectedName, inventory)];
    const preferred = soraVeoModelNameMemory.get(soraVeoPathMemoryKey(config));
    if (!preferred) return base;
    const preferredLower = preferred.toLowerCase();
    // 用户已显式选 azure-sora 等：不改
    if (selectedName.toLowerCase() === preferredLower) return base;
    // 把 host 偏好插到最前，用户选择仍保留在列表（偏好失败时可回退）
    const rest = base.filter((item) => item.toLowerCase() !== preferredLower);
    return [preferred, ...rest];
}

/** 把别名插到 queue 的 at 位置，已存在则移到前面；跳过 modality 已拒收的名字 */
function promoteSoraModelAliases(queue: string[], at: number, aliases: string[], rejectedLower: Set<string>) {
    const insertAt = Math.max(0, Math.min(at, queue.length));
    const ordered: string[] = [];
    for (const alias of aliases) {
        const value = modelOptionName(alias).trim();
        if (!value) continue;
        const lower = value.toLowerCase();
        if (rejectedLower.has(lower)) continue;
        if (ordered.some((item) => item.toLowerCase() === lower)) continue;
        ordered.push(value);
    }
    if (!ordered.length) return;
    // 先从队列去掉即将提升的名字，再按顺序插入
    for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (ordered.some((item) => item.toLowerCase() === queue[i].toLowerCase())) {
            queue.splice(i, 1);
        }
    }
    queue.splice(insertAt, 0, ...ordered);
}

/** 专门识别 openai2api 一类「sora-2 不在 VIDEO 白名单」422，防止漏判后直接抛错 */
function isSoraVideoModalityRejectedError(error: unknown) {
    const blob = collectSoraCreateErrorBlob(error);
    if (!blob) return false;
    if (/modelmodality\.video|not supported for.*video endpoint|supported models:\s*\[/i.test(blob) && /sora|validation_error|422/i.test(blob)) {
        return true;
    }
    if (/\b422\b|status=422/i.test(blob) && /sora-2|sora sora-2/i.test(blob) && /not supported|validation_error|supported models/i.test(blob)) {
        return true;
    }
    return false;
}

function collectSoraCreateErrorBlob(error: unknown): string {
    if (!error) return "";
    if (typeof error === "string") return error;
    const parts: string[] = [];
    if (error instanceof Error) parts.push(error.message);
    if (axios.isAxiosError(error)) {
        if (error.response?.status) parts.push(`status=${error.response.status}`);
        const data = error.response?.data;
        if (typeof data === "string") parts.push(data);
        else if (data && typeof data === "object") {
            try {
                parts.push(JSON.stringify(data));
            } catch {
                /* ignore */
            }
        }
    }
    try {
        parts.push(JSON.stringify(error));
    } catch {
        parts.push(String(error));
    }
    return parts.filter(Boolean).join("\n");
}

type SoraVeoPreparedReference = {
    file: File | null;
    dataUrl: string;
    publicUrl: string;
};

/**
 * 准备 Sora/Veo 图生参考图：本地 blob/data 优先压缩为 File+dataURI；
 * 公网 https 保留为 URL 候选（上游服务端拉取，绕过浏览器 CORS）。
 */
async function prepareSoraVeoReferenceAssets(image: ReferenceImage): Promise<SoraVeoPreparedReference> {
    const direct = (image.url || image.dataUrl || "").trim();
    const publicUrl = isPublicMediaUrl(direct) ? direct : "";

    // 1) 本地 / data URI → 压缩后 File
    let dataUrl = "";
    try {
        const binary = await resolveReferenceBinaryDataUrl(image);
        if (binary?.startsWith("data:")) {
            // 压到 ~1.5MB / 1280 边，降低中转 multipart/JSON 拒收（多图时尤其重要）
            dataUrl = await compressImageDataUrl(binary, 1280, 0.84, 1.5 * 1024 * 1024);
        }
    } catch {
        dataUrl = "";
    }

    let file: File | null = null;
    if (dataUrl.startsWith("data:")) {
        try {
            file = dataUrlToFile({ ...image, dataUrl, name: image.name || "reference.jpg", type: dataUrl.match(/^data:([^;]+)/)?.[1] || image.type || "image/jpeg" });
        } catch {
            file = null;
        }
    }

    return { file, dataUrl: dataUrl.startsWith("data:") ? dataUrl : "", publicUrl };
}

function resolveSoraVeoJsonReferenceValue(prepared: SoraVeoPreparedReference, source?: "binary" | "url" | "either") {
    const mode = source || "either";
    if (mode === "binary") return prepared.dataUrl || "";
    if (mode === "url") return prepared.publicUrl || "";
    return prepared.dataUrl || prepared.publicUrl || "";
}

function resolveSoraVeoJsonReferenceValues(preparedList: SoraVeoPreparedReference[], source?: "binary" | "url" | "either") {
    return preparedList.map((item) => resolveSoraVeoJsonReferenceValue(item, source)).filter(Boolean);
}

function applySoraVeoJsonReferenceField(payload: Record<string, unknown>, field: SoraVeoReferenceField | undefined, values: string[]) {
    const key = field || "images";
    const first = values[0] || "";
    if (!first) return;
    if (key === "file") {
        // file 仅 multipart；JSON 误配时回退 images
        payload.images = values;
        return;
    }
    if (isMultiImageSoraVeoReferenceField(key)) {
        // 多图数组字段：全量发送，禁止静默只发第一张
        payload[key] = values;
        return;
    }
    // 单值字段（input_reference / image / first_frame 等）只能塞首帧
    payload[key] = first;
}

async function postSoraVeoJsonCreate(
    config: AiConfig,
    createPath: string,
    fields: {
        model: string;
        prompt: string;
        seconds: string;
        secondsAsNumber?: boolean;
        durationField?: "seconds" | "duration";
        size?: string;
        withReferences?: boolean;
        referenceField?: SoraVeoReferenceField;
        referenceSource?: "binary" | "url" | "either";
    },
    preparedList: SoraVeoPreparedReference[],
    options?: RequestOptions,
) {
    // 默认 seconds 字符串（OpenAI / New API）；secondsAsNumber 时发 number（部分中转）
    // durationField=duration 时用 duration 键代替 seconds
    const payload: Record<string, unknown> = {
        model: fields.model,
        prompt: fields.prompt,
    };
    const timeKey = fields.durationField === "duration" ? "duration" : "seconds";
    if (fields.seconds !== "" && fields.seconds != null) {
        payload[timeKey] = fields.secondsAsNumber ? Number(fields.seconds) : String(fields.seconds);
    }
    if (fields.size) payload.size = fields.size;

    if (fields.withReferences) {
        const values = resolveSoraVeoJsonReferenceValues(preparedList, fields.referenceSource);
        if (!values.length) throw new Error("参考图不可用");
        applySoraVeoJsonReferenceField(payload, fields.referenceField, values);
    }

    return unwrapVideoResponse(
        (
            await axios.post<ApiVideoResponse>(aiApiUrl(config, createPath || "/videos"), payload, {
                headers: aiHeaders(config, "application/json"),
                signal: options?.signal,
                timeout: 180000,
            })
        ).data,
    );
}

async function postSoraVeoMultipartCreate(
    config: AiConfig,
    createPath: string,
    fields: {
        model: string;
        prompt: string;
        seconds: string;
        size?: string;
        withReferences: boolean;
        referenceField?: SoraVeoReferenceField;
        multipartFileField?: "input_reference" | "image" | "file" | "first_frame";
    },
    files: File[],
    options?: RequestOptions,
) {
    const body = new FormData();
    body.append("model", fields.model);
    body.append("prompt", fields.prompt);
    if (fields.seconds !== "" && fields.seconds != null) body.append("seconds", String(fields.seconds));
    if (fields.size) body.append("size", fields.size);
    if (fields.withReferences && files.length) {
        // multipart 首帧：默认 input_reference；兼容 image / file / first_frame 字段名
        // New API parseMultipartFormData 只映射文本字段，文件由 ExtractMultipartImage / Sora 重建读取。
        const fileField = fields.multipartFileField || "input_reference";
        body.append(fileField, files[0], files[0].name || "reference.jpg");
    }
    return unwrapVideoResponse(
        (
            await axios.post<ApiVideoResponse>(aiApiUrl(config, createPath || "/videos"), body, {
                headers: aiHeaders(config),
                signal: options?.signal,
                timeout: 180000,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            })
        ).data,
    );
}

function enhanceSoraVeoCreateError(upstream: string, model: string, hasReferences: boolean, triedModels: string[] = [], triedPaths: string[] = []) {
    const text = (upstream || "视频任务创建失败").trim();
    const hints: string[] = [];
    const supported = parseSupportedVideoModelsFromError(text);
    const triedAzure = triedModels.some((item) => /azure[-_]?sora/i.test(item));
    const triedClassicSora = triedModels.some((item) => /^sora([-_.]|$)/i.test(item) || /^sora-2/i.test(item));

    if (isUnsupportedVideoModelError(text) || supported.length) {
        hints.push(
            `当前中转的 VIDEO 端点不接受模型「${model}」` +
                (triedModels.length ? `（已尝试：${triedModels.join(" → ")}）` : ""),
        );
        if (supported.length) {
            hints.push(`网关声明支持：${supported.join(", ")}`);
        }
        if (isSoraVideoModel(model) || triedClassicSora || supported.some((item) => /azure[-_]?sora/i.test(item))) {
            // 用户常误解：模型列表有 sora-2 ≠ VIDEO 端点可用；列表没有 azure-sora 也不代表不能用 body 名试
            hints.push(
                "说明：`sora-2` 是 OpenAI 原名；openai2api 一类网关的 VIDEO 模态只认 `azure-sora`。" +
                    "渠道「模型列表」里有没有 azure-sora 不重要——请求体会自动改试 azure-sora。" +
                    "若 azure-sora 也 422/无渠道，需要在中转后台开通 Azure Sora / 绑定对应上游，或换支持 Sora 的 New API 渠道；不能只靠手填 sora-2。",
            );
            if (triedAzure) {
                hints.push("已自动试过 azure-sora 仍失败：当前 Key/分组多半未开通 azure-sora，请到中转站开通或换渠道");
            } else {
                hints.push("也可在视频模型框手填 azure-sora 再生成（无需列表里已有该名）");
            }
            if (supported.some((item) => /kling|firefly/i.test(item)) && !supported.some((item) => /sora/i.test(item))) {
                hints.push("该中转 VIDEO 通道目前主要是 Kling/Firefly，并非 Sora");
            }
        }
    }

    if (triedPaths.length) {
        hints.push(`已尝试创建路径：${triedPaths.map((path) => `/v1${path}`).join(" → ")}`);
    }
    if (/invalid request body|invalid_request_error|fail_to_fetch_task|invalid_size|unsupported media type|415/i.test(text)) {
        hints.push("本站已按 New API 精简字段（model/prompt/seconds/size，图生另加 input_reference），不发 resolution_name/preset");
        if (isSoraVideoModel(model) && !/pro/i.test(model)) {
            hints.push("sora-2 尺寸通常仅 1280x720 / 720x1280；秒数 4/8/12；已优先 /video/generations + 最小 body {model,prompt,seconds}，并自动试 size/duration/multipart 与 /videos 兜底");
        } else {
            hints.push("秒数用 4/8/12（Sora）或 4/6/8（Veo）；尺寸用面板枚举");
        }
        hints.push(
            "fail_to_fetch_task + invalid request body 表示中转已把请求转到上游，但上游拒收 body，或创建路径与上游协议不匹配。" +
                "请先确认：① 纯文生是否成功；② 图生用本地 jpg/png 首帧；③ 尺寸别选高清 pro 档；④ Network 里是否出现了 /video/generations 等其它路径；⑤ 中转后台该 request id 的上游日志。",
        );
    }
    if (hasReferences) {
        hints.push("已禁止无参考文生回退：图生失败会直接报错，不会假装成功");
        hints.push("图生请优先本地可读参考图；仅公网 https 图可尝试 URL 字段。远程 imgen.x.ai 常因 CORS 读不到");
        if (isVeoVideoModel(model)) {
            hints.push("Veo 图生最多 3 张参考图，优先 JSON images/reference_images 全量发送；有参考时会自动切同渠道 veo-*-i2v；渠道类型应为 Gemini");
        }
        if (isSoraVideoModel(model)) {
            hints.push("Sora 图生仅 1 张首帧（multipart input_reference 或 JSON images）；Azure 网关请用 azure-sora");
        }
    }
    if (isUnavailableVideoChannelError(text) || /no available channel|无可用渠道|channel not found|invalid api platform|distributor/i.test(text)) {
        hints.push(
            "这是中转后台「渠道/分组」问题，不是本站请求字段写错：" +
                "当前令牌所属分组（如 veo-sora）下，该模型（如 azure-sora）没有启用的上游 distributor。" +
                (triedModels.length ? ` 已尝试模型名：${triedModels.join(" → ")}。` : " "),
        );
        hints.push(
            "请到中转管理后台：① 为 azure-sora（或你实际要用的 Sora 模型）绑定并启用上游渠道；" +
                "② 确认令牌分组能访问该模型（分组权限 / 模型映射）；" +
                "③ 或换已开通 Sora 的分组/Key；Veo 模型需 Gemini 类渠道，Sora 需 Azure/Sora 类渠道，不要混绑。",
        );
        if (triedAzure && /azure-sora/i.test(text)) {
            hints.push("azure-sora 已被 VIDEO 端点接受，但分组未配上游——开通/绑定后无需再改前端模型名");
        }
    }
    if (!hints.length) return text.includes(model) ? text : `${text}（模型 ${model}）`;
    return `${text}。${hints.join("；")}`;
}

/** 供单测：Sora/Veo 表单字段候选（不发网） */
export {
    buildSoraVeoFormFieldCandidates,
    isInvalidVideoRequestBodyError,
    isMissingSoraVeoCreatePathError,
    isMultiImageSoraVeoReferenceField,
    isSoraOrVeoVideoModel,
    isSoraVideoModel,
    isUnavailableVideoChannelError,
    isUnsupportedVideoModelError,
    isVeoI2vModel,
    isVeoVideoModel,
    parseSupportedVideoModelsFromError,
    shouldSkipToNextVideoModelName,
    shouldTryNextSoraVeoCreatePath,
    preferSoraRelayModelName,
    preferVeoI2vModelName,
    soraRequestModelCandidates,
    soraVeoCreatePathCandidates,
    soraVeoReferenceImageLimit,
} from "@/lib/openai-compatible-video";

function openAiVideoPollPaths(task: VideoGenerationTask): string[] {
    const id = encodeURIComponent(task.id);
    const preferred: string[] = [];
    // 参考脚本 veo-sora：GET /v1/video/generations/{id}
    if (task.createPath === "/video/generations") {
        preferred.push(`/video/generations/${id}`, `/video/generations?request_id=${id}`, `/video/generations?id=${id}`, `/video/generations?task_id=${id}`);
    } else if (task.createPath === "/videos/generations") {
        preferred.push(`/videos/generations/${id}`, `/videos/generations?request_id=${id}`, `/videos/generations?id=${id}`, `/videos/generations?task_id=${id}`);
    } else if (task.createPath === "/videos") {
        preferred.push(`/videos/${id}`, `/videos?request_id=${id}`, `/videos?id=${id}`);
    }
    // 官方 OpenAI Videos + 通用兜底（含创建路径与轮询路径不一致的中转）
    preferred.push(
        `/video/generations/${id}`,
        `/videos/${id}`,
        `/videos/generations/${id}`,
        `/video/generations?request_id=${id}`,
        `/videos?request_id=${id}`,
        `/videos/generations?request_id=${id}`,
        `/video/generations?id=${id}`,
        `/videos/generations?id=${id}`,
    );
    return Array.from(new Set(preferred));
}

function openAiVideoContentPaths(task: VideoGenerationTask): string[] {
    const id = encodeURIComponent(task.id);
    return Array.from(
        new Set([
            `/videos/${id}/content`,
            `/videos/${id}/download`,
            `/video/generations/${id}/content`,
            `/video/generations/${id}/download`,
            `/videos/generations/${id}/content`,
            `/videos/generations/${id}/download`,
        ]),
    );
}

function isOpenAiVideoCompletedStatus(status: string) {
    const value = String(status || "").toLowerCase().trim();
    if (!value) return false;
    if (
        value === "completed" ||
        value === "complete" ||
        value === "succeeded" ||
        value === "success" ||
        value === "successful" ||
        value === "done" ||
        value === "finished" ||
        value === "finish" ||
        value === "ready" ||
        value === "ok" ||
        value === "process_success" ||
        value === "generate_success" ||
        value === "generation_success" ||
        value === "task_success" ||
        // 部分中文中转
        value === "完成" ||
        value === "成功" ||
        value === "已完成"
    ) {
        return true;
    }
    // 宽松：含 success/complete/finish 且不像失败
    if (/(success|succeed|completed|complete|finished|finish|ready)/i.test(value) && !/(fail|error|cancel|invalid|pending|process(?!_success)|queue|run)/i.test(value)) {
        return true;
    }
    return false;
}

function isOpenAiVideoFailedStatus(status: string) {
    const value = String(status || "").toLowerCase().trim();
    return (
        value === "failed" ||
        value === "failure" ||
        value === "error" ||
        value === "cancelled" ||
        value === "canceled" ||
        value === "expired" ||
        value === "失败" ||
        value === "取消" ||
        value === "已取消" ||
        value === "超时"
    );
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        let video: VideoResponse | null = null;
        let lastPollError: unknown;
        let sawNotReady = false;
        for (const path of openAiVideoPollPaths(task)) {
            try {
                // 轮询响应常只带 status/url、不再重复 task id；用创建时 id 兜底
                video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, path), { headers: aiHeaders(config), signal: options?.signal, timeout: 60000 })).data, {
                    allowMissingId: true,
                    fallbackId: task.id,
                });
                break;
            } catch (error) {
                lastPollError = error;
                const message = readAxiosError(error, "");
                // 路径不存在 / 任务暂未落库：继续试其它查询形态，不要整轮直接失败
                if (
                    isMissingSoraVeoCreatePathError(error) ||
                    isMissingSoraVeoCreatePathError(message) ||
                    (axios.isAxiosError(error) && (error.response?.status === 404 || error.response?.status === 405 || error.response?.status === 409 || error.response?.status === 425))
                ) {
                    sawNotReady = true;
                    continue;
                }
                // 瞬时网络错误：当 pending，留给下一轮
                if (axios.isAxiosError(error) && !error.response) {
                    sawNotReady = true;
                    continue;
                }
                throw error;
            }
        }
        // 创建刚成功、查询接口尚未可见时，返回 pending 而不是立刻超时/报错
        if (!video) {
            if (sawNotReady) return { status: "pending" };
            throw lastPollError || new Error("视频状态查询失败");
        }
        if (!video.id) video.id = task.id;

        // 部分中转在 status 未完成或没有 /content 时直接返回可播 URL
        // 参考脚本 veo-sora：completed 时读 data.video_url / data.url（含嵌套 data.data）
        const directUrl = openAiCompatibleVideoUrl(video);
        if (directUrl) return { status: "completed", result: await videoResultFromUrl(directUrl, options, config) };
        const status = String(video.status || "").toLowerCase();
        // progress=100 且无失败态：按完成处理
        const progressDone = typeof video.progress === "number" && video.progress >= 100;
        if (isOpenAiVideoCompletedStatus(status) || (progressDone && !isOpenAiVideoFailedStatus(status))) {
            try {
                // 优先走渠道 Base（/lan-ai）+ Authorization 拉 content，避免返回 127.0.0.1 给浏览器
                let contentError: unknown;
                for (const contentPath of openAiVideoContentPaths(task)) {
                    try {
                        const content = await axios.get<Blob>(aiApiUrl(config, contentPath), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal, timeout: 120000 });
                        await assertVideoBlob(content.data);
                        return { status: "completed", result: { blob: content.data } };
                    } catch (error) {
                        contentError = error;
                    }
                }
                // /content 不存在时，再尝试从任务体里抠 URL（内网 URL 会再经 /lan-ai + Key 下载）
                const fallbackUrl = openAiCompatibleVideoUrl(video);
                if (fallbackUrl) return { status: "completed", result: await videoResultFromUrl(fallbackUrl, options, config) };
                // 已 completed 但文件暂不可下：继续 pending，避免 5 分钟内因 content 瞬时失败直接挂
                if (axios.isAxiosError(contentError) && (!contentError.response || contentError.response.status === 404 || contentError.response.status === 409)) {
                    return { status: "pending" };
                }
                throw contentError || new Error("视频已完成但无法下载内容");
            } catch (contentError) {
                const fallbackUrl = openAiCompatibleVideoUrl(video);
                if (fallbackUrl) return { status: "completed", result: await videoResultFromUrl(fallbackUrl, options, config) };
                if (axios.isAxiosError(contentError) && (!contentError.response || contentError.response.status === 404 || contentError.response.status === 409)) {
                    return { status: "pending" };
                }
                throw contentError;
            }
        }
        if (isOpenAiVideoFailedStatus(status)) {
            return { status: "failed", error: readErrorPayload(video.error?.message) || readErrorPayload(video) || "视频生成失败" };
        }
        return { status: "pending" };
    } catch (error) {
        // 轮询瞬时失败不要把整次生成打成失败；Sora 排队中常见
        const message = readAxiosError(error, "视频任务查询失败");
        if (/timeout|network|econnreset|enotfound|503|502|504|pending|not ready|not found/i.test(message)) {
            return { status: "pending" };
        }
        throw new Error(message);
    }
}

async function createGrokTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const payloads = await buildGrokPayloadCandidates(config, model, prompt, references);
    const paths = grokCreatePathCandidates(config, references.length, model);
    const requestedResolution = normalizeGrokResolution(config.vquality);
    let lastError: unknown;
    let attemptCount = 0;
    let lastCreateUrl = "";

    for (const path of paths) {
        const createUrl = aiApiUrl(config, path);
        lastCreateUrl = createUrl;
        let pathMissingHits = 0;
        let platformMismatchHits = 0;

        for (const payload of payloads) {
            try {
                // 中转站图生视频可能较慢，创建超时放宽，尽量等同步结果
                attemptCount += 1;
                const created = unwrapGrokVideoResponse(
                    (
                        await axios.post<ApiGrokVideoResponse>(createUrl, payload, {
                            headers: aiHeaders(config, "application/json"),
                            timeout: 180000,
                            signal: options?.signal,
                        })
                    ).data,
                );
                rememberGrokCreatePath(config, path, references.length);
                const id = readGrokTaskId(created) || "grok-inline";
                const ready = extractGrokReadyResult(created);
                const acceptedResolution = readPayloadResolution(payload);
                const taskBase: VideoGenerationTask = {
                    id,
                    provider: "grok",
                    model,
                    requestModel: String(payload.model || modelOptionName(model)),
                    requestedResolution,
                    acceptedResolution,
                };
                if (ready) {
                    return {
                        ...taskBase,
                        readyResult: await videoResultFromUrl(ready, options, config),
                    };
                }
                if (!readGrokTaskId(created)) throw new Error("Grok 视频接口没有返回 request_id");
                // 新任务清掉「路由不存在」短路与该任务 miss 计数；不删已验证可用的 poll path 缓存
                grokPollHostState.delete(hostKeyOf(config));
                grokPollMissCount.delete(pollMissKey(config, id));
                return taskBase;
            } catch (error) {
                lastError = error;
                if (axios.isCancel(error) || options?.signal?.aborted) throw error;
                // New API：渠道类型/平台不匹配（invalid api platform: 48）——换 body 无意义，立刻换路径
                if (isNewApiPlatformMismatchError(error)) {
                    platformMismatchHits += 1;
                    break;
                }
                // 多图大 body 在 codex2api 上偶发 “404 page not found”，不能把第一次 404 当成路径不存在而清空后续候选
                if (isGrokCreatePathMissingError(error, { hasImages: references.length > 0, payload })) {
                    pathMissingHits += 1;
                    // New API Invalid URL = 路由不存在：立刻换路径，禁止多图时继续刷 body
                    // 纯文生：路径真不存在时立刻换路径；多图假 404：连续两次再换
                    if (isInvalidUrlGrokError(error) || references.length === 0 || pathMissingHits >= 2) {
                        rememberGrokCreatePathMissing(config, path);
                        break;
                    }
                    continue;
                }
                // 只在字段/模型兼容候选之间切换；鉴权/限流等直接结束。
                if (!isRetryableGrokPayloadError(error)) {
                    throw new Error(formatGrokCreateError(lastError, references, attemptCount, createUrl));
                }
            }
        }

        // 平台不匹配：继续下一条路径（如 /videos → /video/generations），不要刷 30 次 body
        if (platformMismatchHits > 0) continue;

        if (pathMissingHits === 0 && lastError && !isRetryableGrokPayloadError(lastError) && !isGrokCreatePathMissingError(lastError, { hasImages: references.length > 0 })) {
            break;
        }
    }

    // 仅 New API / 非 codex2api 才回退 multipart OpenAI /videos（codex2api 上 /videos 不存在）
    // 若已明确是 platform mismatch，multipart 同一路径通常仍 48，仍可试一次 /video/generations 失败后的 OpenAI 路径
    if (shouldTryOpenAiCompatibleGrokFallback(config, lastError, references) && !isNewApiPlatformMismatchError(lastError)) {
        try {
            attemptCount += 1;
            lastCreateUrl = aiApiUrl(config, "/videos");
            const openaiTask = await createOpenAIVideoTask(config, model, prompt, references, options);
            rememberGrokCreatePath(config, "/videos", references.length);
            return {
                ...openaiTask,
                provider: "grok",
                requestModel: modelOptionName(model),
                requestedResolution,
                acceptedResolution: openaiTask.acceptedResolution,
            };
        } catch (error) {
            lastError = error;
            lastCreateUrl = aiApiUrl(config, "/videos");
        }
    }

    throw new Error(formatGrokCreateError(lastError, references, attemptCount, lastCreateUrl));
}

/**
 * Grok 单条参考视频编辑：仅 POST /videos/edits（与 generation 路径/缓存完全隔离）。
 * codex2api 实测 multipart → 415，必须走 JSON data URI / 公网 URL。
 * 路径不存在（如 New API）fail-fast，不回退 generation。
 */
async function createGrokEditTask(config: AiConfig, model: string, prompt: string, videoReferences: ReferenceVideo[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const error = grokEditVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    if (!prompt.trim()) throw new Error("请先填写提示词，再对参考视频做 Grok 编辑");

    const payloads = await buildGrokEditPayloadCandidates(config, model, prompt, videoReferences[0]);
    const paths = grokEditPathCandidates(config);
    const requestedResolution = normalizeGrokResolution(config.vquality);
    let lastError: unknown;
    let attemptCount = 0;
    let lastCreateUrl = "";
    let skipMultipart = false;

    for (const path of paths) {
        const createUrl = aiApiUrl(config, path);
        lastCreateUrl = createUrl;

        for (const payload of payloads) {
            const isForm = payload instanceof FormData;
            if (isForm && skipMultipart) continue;
            try {
                attemptCount += 1;
                const created = unwrapGrokVideoResponse(
                    (
                        await axios.post<ApiGrokVideoResponse>(createUrl, payload, {
                            // FormData 不要手写 Content-Type，让浏览器带 boundary
                            headers: isForm ? aiHeaders(config) : aiHeaders(config, "application/json"),
                            timeout: 180000,
                            signal: options?.signal,
                            maxBodyLength: Infinity,
                            maxContentLength: Infinity,
                        })
                    ).data,
                );
                rememberGrokEditPath(config, path);
                const id = readGrokTaskId(created) || "grok-edit-inline";
                const requestModel = isForm
                    ? modelOptionName(model)
                    : String((payload as Record<string, unknown>).model || modelOptionName(model));
                const ready = extractGrokReadyResult(created);
                const acceptedResolution = isForm ? readFormDataResolution(payload) : readPayloadResolution(payload as Record<string, unknown>);
                const taskBase: VideoGenerationTask = {
                    id,
                    provider: "grok",
                    model,
                    requestModel,
                    requestedResolution,
                    acceptedResolution,
                };
                if (ready) {
                    return {
                        ...taskBase,
                        readyResult: await videoResultFromUrl(ready, options, config),
                    };
                }
                if (!readGrokTaskId(created)) throw new Error("Grok 视频编辑接口没有返回 request_id");
                // edits 与 generation 共用 GET /videos/{id}；只清 host 短路与本任务 miss
                grokPollHostState.delete(hostKeyOf(config));
                grokPollMissCount.delete(pollMissKey(config, id));
                return taskBase;
            } catch (caught) {
                lastError = caught;
                if (axios.isCancel(caught) || options?.signal?.aborted) throw caught;
                // platform / 路径不存在：立刻结束，禁止换 body 狂刷
                if (isNewApiPlatformMismatchError(caught) || isGrokCreatePathMissingError(caught, { hasImages: false }) || isInvalidUrlGrokError(caught)) {
                    throw new Error(formatGrokEditCreateError(caught, attemptCount, createUrl));
                }
                // codex2api：multipart 415 → 跳过后续 FormData，继续 JSON
                if (isUnsupportedMediaTypeError(caught)) {
                    if (isForm) skipMultipart = true;
                    continue;
                }
                if (!isRetryableGrokEditPayloadError(caught)) {
                    throw new Error(formatGrokEditCreateError(caught, attemptCount, createUrl));
                }
            }
        }
    }

    throw new Error(formatGrokEditCreateError(lastError, attemptCount, lastCreateUrl));
}

// host 探测：ok=至少有一条查询路径可用。
// 注意：任务级 404（id 尚未落库）绝不能把整个 host 标成 missing，否则会毒化后续所有任务。
const grokPollHostState = new Map<string, "ok" | "routes-missing">();
/** 缓存已验证可用的查询路径模板，`{id}` 为占位符。 */
const grokPollPathState = new Map<string, string>();
const grokPollMissCount = new Map<string, number>();
const GROK_POLL_NOT_FOUND_GRACE = 36; // 约 36*5s ≈ 3 分钟，给中转站任务落库时间

function hostKeyOf(config: AiConfig) {
    return config.baseUrl.trim().replace(/\/+$/, "").toLowerCase();
}

function pollMissKey(config: AiConfig, taskId: string) {
    return `${hostKeyOf(config)}::${taskId}`;
}

function extractGrokReadyResult(payload: GrokVideoResponse) {
    const url = readGrokVideoUrl(payload);
    if (!url) return "";
    const status = String(payload.status || "").toLowerCase();
    if (["pending", "queued", "running", "processing", "in_progress", "generating"].includes(status)) return "";
    // 无 status 但有 url：中转常同步返回
    return url;
}

/** 从创建/查询响应里尽量抠出 request_id（中转字段名不统一）。 */
export function readGrokTaskId(payload: GrokVideoResponse | Record<string, unknown> | null | undefined): string {
    if (!payload || typeof payload !== "object") return "";
    const root = payload as Record<string, unknown>;
    const direct = [root.request_id, root.requestId, root.id, root.task_id, root.taskId, root.job_id, root.jobId, root.video_id, root.videoId]
        .map((value) => (typeof value === "string" || typeof value === "number" ? String(value).trim() : ""))
        .find(Boolean);
    if (direct) return direct;
    for (const key of ["data", "result", "response", "task", "job"]) {
        const nested = root[key];
        if (nested && typeof nested === "object" && !Array.isArray(nested)) {
            const nestedId = readGrokTaskId(nested as Record<string, unknown>);
            if (nestedId) return nestedId;
        }
    }
    return "";
}

// 中转有时 status=done 但 video URL 晚几拍才写入；先宽容等待再失败
// xAI / codex2api：progress=100 / status=done 后 video.url 仍可能空 1～3 分钟
const grokDoneWithoutUrlCount = new Map<string, number>();
const GROK_DONE_WITHOUT_URL_GRACE = 36; // ~36*5s ≈ 3 分钟

async function pollGrokTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        // 官方：POST /videos/generations|edits + GET /videos/{request_id}
        // codex2api 实测：GET /v1/videos/{id} 与 GET /v1/videos/generations?request_id= 存在；/videos/generations/{id} 不存在
        const raw = await fetchGrokTaskState(config, task, options);
        const state = unwrapGrokVideoResponse(raw);
        const status = String(state.status || (state as Record<string, unknown>).state || "").toLowerCase();
        const progress = Number((state as Record<string, unknown>).progress ?? (state as Record<string, unknown>).percent ?? NaN);
        const url = readGrokVideoUrl(state) || readGrokVideoUrl(raw as GrokVideoResponse);
        const completed =
            status === "done" ||
            status === "completed" ||
            status === "succeeded" ||
            status === "success" ||
            status === "complete" ||
            status === "finished" ||
            (Number.isFinite(progress) && progress >= 100 && !["pending", "queued", "running", "processing", "in_progress", "generating"].includes(status));

        if (url && (completed || !["pending", "queued", "running", "processing", "in_progress", "generating"].includes(status))) {
            grokPollMissCount.delete(pollMissKey(config, task.id));
            grokDoneWithoutUrlCount.delete(pollMissKey(config, task.id));
            return { status: "completed", result: await videoResultFromUrl(url, options, config) };
        }

        // 完成但无 URL：先试 content 下载，再短暂等待（中转常晚写 video 字段）
        if (completed && !url) {
            const content = await tryFetchGrokVideoContent(config, task, options);
            if (content) {
                grokPollMissCount.delete(pollMissKey(config, task.id));
                grokDoneWithoutUrlCount.delete(pollMissKey(config, task.id));
                return { status: "completed", result: content };
            }
            const key = pollMissKey(config, task.id);
            const n = (grokDoneWithoutUrlCount.get(key) || 0) + 1;
            grokDoneWithoutUrlCount.set(key, n);
            if (n < GROK_DONE_WITHOUT_URL_GRACE) return { status: "pending" };
            grokDoneWithoutUrlCount.delete(key);
            return {
                status: "failed",
                error: formatGrokDoneWithoutUrlError(raw, state, task.id),
            };
        }

        if (["failed", "fail", "error", "expired", "cancelled", "canceled"].includes(status)) return { status: "failed", error: readGrokError(state) || "Grok 视频生成失败" };
        return { status: "pending" };
    } catch (error) {
        // 中转站常见：任务刚创建时 GET /videos/{id} 暂时 404，先当 pending 继续等
        if (error instanceof GrokPollNotReadyError) return { status: "pending" };
        throw new Error(error instanceof Error ? error.message : readAxiosError(error, "Grok 视频任务查询失败"));
    }
}

class GrokPollNotReadyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GrokPollNotReadyError";
    }
}

/**
 * Grok 查询路径候选（模板，`{id}` 替换为 encodeURIComponent(taskId)）。
 * codex2api 实测：
 * - GET /v1/videos/{id} → 401（路径存在）
 * - GET /v1/videos/generations?request_id= → 401（路径存在）
 * - GET /v1/videos/generations/{id}、/videos/edits/{id} → 404 page not found（路径不存在）
 */
export function grokPollPathTemplates(config: AiConfig): string[] {
    const hostKey = hostKeyOf(config);
    const codex = isCodex2apiBaseUrl(config.baseUrl);
    const xai = isXaiBaseUrl(config.baseUrl);
    let ordered: string[];
    if (codex || xai) {
        ordered = ["/videos/{id}", "/videos/generations?request_id={id}", "/videos/generations?id={id}"];
    } else {
        ordered = [
            "/videos/{id}",
            "/videos/generations/{id}",
            "/video/generations/{id}",
            "/videos/generations?request_id={id}",
            "/videos?request_id={id}",
            "/videos/generations?id={id}",
        ];
    }
    const cached = grokPollPathState.get(hostKey);
    if (!cached || !ordered.includes(cached)) return ordered;
    return [cached, ...ordered.filter((path) => path !== cached)];
}

function materializeGrokPollPath(template: string, taskId: string) {
    return template.split("{id}").join(encodeURIComponent(taskId));
}

async function fetchGrokTaskState(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions) {
    const hostKey = hostKeyOf(config);
    // 仅当「所有路由本身不存在」时才短路；任务级 404 不写 routes-missing
    if (grokPollHostState.get(hostKey) === "routes-missing") {
        throw new Error(formatGrokPollUnsupportedError(config, task.id));
    }
    if (!task.id || task.id === "grok-inline" || task.id === "grok-edit-inline") {
        throw new Error("Grok 任务缺少 request_id，无法查询状态。请查看创建接口响应是否返回 request_id/id");
    }

    const templates = grokPollPathTemplates(config);
    let sawTaskNotFound = false;
    let sawRouteMissing = false;
    let routeExists = false;
    let lastError: unknown;

    for (const template of templates) {
        const path = materializeGrokPollPath(template, task.id);
        try {
            const response = await axios.get<ApiGrokVideoResponse>(aiApiUrl(config, path), {
                headers: aiHeaders(config),
                timeout: 60000,
                signal: options?.signal,
            });
            // 有的中转 200 包一层 code 表示任务不存在
            if (isGrokPollSoftNotFoundPayload(response.data)) {
                sawTaskNotFound = true;
                continue;
            }
            grokPollHostState.set(hostKey, "ok");
            grokPollPathState.set(hostKey, template);
            grokPollMissCount.delete(pollMissKey(config, task.id));
            return response.data;
        } catch (error) {
            if (axios.isCancel(error) || options?.signal?.aborted) throw error;
            lastError = error;
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;

            // 鉴权/限流说明路由存在，不应判「中转无查询接口」
            if (status === 401 || status === 403 || status === 429) {
                routeExists = true;
                throw new Error(readAxiosError(error, `Grok 视频查询失败（${path}）`));
            }

            if (isGrokPollRouteMissingError(error)) {
                sawRouteMissing = true;
                continue;
            }

            if (status === 404 || status === 405 || isGrokPollTaskNotFoundError(error)) {
                // 路由存在但任务未落库 / id 无效 —— 只记任务级 miss
                routeExists = true;
                sawTaskNotFound = true;
                continue;
            }

            if (isRetryableGrokPollNetworkError(error)) {
                await delay(1500, options?.signal);
                try {
                    const response = await axios.get<ApiGrokVideoResponse>(aiApiUrl(config, path), {
                        headers: aiHeaders(config),
                        timeout: 60000,
                        signal: options?.signal,
                    });
                    if (isGrokPollSoftNotFoundPayload(response.data)) {
                        sawTaskNotFound = true;
                        continue;
                    }
                    grokPollHostState.set(hostKey, "ok");
                    grokPollPathState.set(hostKey, template);
                    grokPollMissCount.delete(pollMissKey(config, task.id));
                    return response.data;
                } catch (retryError) {
                    lastError = retryError;
                    if (isGrokPollRouteMissingError(retryError)) {
                        sawRouteMissing = true;
                        continue;
                    }
                    const retryStatus = axios.isAxiosError(retryError) ? retryError.response?.status : undefined;
                    if (retryStatus === 404 || retryStatus === 405 || isGrokPollTaskNotFoundError(retryError)) {
                        routeExists = true;
                        sawTaskNotFound = true;
                        continue;
                    }
                }
            }
        }
    }

    // 任务级 404：继续等，绝不毒化 host
    if (sawTaskNotFound || routeExists) {
        const key = pollMissKey(config, task.id);
        const misses = (grokPollMissCount.get(key) || 0) + 1;
        grokPollMissCount.set(key, misses);
        if (misses < GROK_POLL_NOT_FOUND_GRACE) {
            throw new GrokPollNotReadyError("Grok 任务查询暂不可用，继续等待");
        }
        throw new Error(formatGrokPollTaskMissingError(config, task.id));
    }

    // 所有候选路径都是「路由不存在」
    if (sawRouteMissing) {
        // codex2api 已实测官方路径存在；若仍全 route-missing，多半是 Base URL 配错（少/多 /v1）
        if (!isCodex2apiBaseUrl(config.baseUrl) && !isXaiBaseUrl(config.baseUrl)) {
            grokPollHostState.set(hostKey, "routes-missing");
        }
        throw new Error(formatGrokPollUnsupportedError(config, task.id));
    }

    throw lastError instanceof Error ? lastError : new Error("Grok 视频任务查询失败");
}

/** Go 网关常见：路径本身不存在 → 纯文本 404 page not found / New API Invalid URL */
function isGrokPollRouteMissingError(error: unknown) {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    if (status !== 404 && status !== 405) return false;
    const data = error.response?.data;
    const raw = typeof data === "string" ? data : JSON.stringify(data || {});
    const message = `${raw} ${error.message || ""}`;
    return /404 page not found|invalid url|not found\s*$|no route|path not found|method not allowed/i.test(message) && !/task|request_id|job|video/i.test(message);
}

function isGrokPollTaskNotFoundError(error: unknown) {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    if (status !== 404 && status !== 400) return false;
    if (isGrokPollRouteMissingError(error)) return false;
    const data = error.response?.data;
    const raw = typeof data === "string" ? data : JSON.stringify(data || {});
    return /not\s*found|unknown\s*(task|request|job|video)|no\s*such|does not exist|不存在|未找到/i.test(raw);
}

function isGrokPollSoftNotFoundPayload(payload: unknown) {
    if (!payload || typeof payload !== "object") return false;
    const root = payload as Record<string, unknown>;
    const code = root.code;
    if (typeof code !== "undefined" && String(code) !== "0" && String(code) !== "200" && String(code).toLowerCase() !== "ok" && String(code).toLowerCase() !== "success") {
        const msg = `${root.msg || ""} ${root.message || ""} ${JSON.stringify(root.error || "")}`;
        if (/not\s*found|不存在|未找到|unknown/i.test(msg)) return true;
    }
    return false;
}

async function tryFetchGrokVideoContent(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult | null> {
    const id = encodeURIComponent(task.id);
    // codex 上 content 路径可能不存在；失败则静默跳过
    const paths = [
        `/videos/${id}/content`,
        `/videos/${id}/download`,
        `/videos/${id}/file`,
        `/videos/generations/${id}/content`,
        `/video/generations/${id}/content`,
    ];
    for (const path of paths) {
        try {
            const response = await axios.get<Blob>(aiApiUrl(config, path), {
                headers: aiHeaders(config),
                responseType: "blob",
                timeout: 120000,
                signal: options?.signal,
            });
            const blob = response.data;
            if (!blob?.size) continue;
            // 有的中转把 JSON 错误当 blob 返回
            if (blob.type.includes("json") || blob.type.includes("text")) {
                try {
                    const text = await blob.text();
                    const json = JSON.parse(text) as GrokVideoResponse;
                    const url = readGrokVideoUrl(json);
                    if (url) return await videoResultFromUrl(url, options, config);
                } catch {
                    continue;
                }
                continue;
            }
            await assertVideoBlob(blob);
            return { blob: ensureVideoBlob(blob), mimeType: blob.type.startsWith("video/") ? blob.type : "video/mp4" };
        } catch (error) {
            if (axios.isCancel(error) || options?.signal?.aborted) throw error;
            // try next path
        }
    }
    return null;
}

function summarizeGrokPayloadKeys(payload: unknown) {
    if (!payload || typeof payload !== "object") return "";
    const root = payload as Record<string, unknown>;
    const top = Object.keys(root).slice(0, 12).join(",");
    const nested = root.data && typeof root.data === "object" ? Object.keys(root.data as object).slice(0, 12).join(",") : "";
    const video = root.video && typeof root.video === "object" ? Object.keys(root.video as object).slice(0, 8).join(",") : "";
    return [top && `root{${top}}`, nested && `data{${nested}}`, video && `video{${video}}`].filter(Boolean).join(" ");
}

/** 完成但无 URL 时描述 video.url 实际值形态（不打印完整 URL，避免日志过长/敏感 query） */
function describeGrokVideoUrlField(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "无响应体";
    const root = payload as Record<string, unknown>;
    const video = root.video;
    if (video == null) return "无 video 字段";
    if (typeof video === "string") {
        const text = video.trim();
        if (!text) return "video 为空字符串";
        if (/^https?:\/\//i.test(text)) return `video 为 https 字符串(len=${text.length})`;
        return `video 为非 http 字符串(len=${text.length})`;
    }
    if (typeof video !== "object" || Array.isArray(video)) return `video 类型=${Array.isArray(video) ? "array" : typeof video}`;
    const record = video as Record<string, unknown>;
    const raw = record.url ?? record.video_url ?? record.videoUrl;
    if (raw == null) return "video.url 缺失(null/undefined)";
    if (typeof raw !== "string") return `video.url 类型=${typeof raw}`;
    const text = raw.trim();
    if (!text) return "video.url 为空字符串";
    if (/^https?:\/\//i.test(text)) {
        try {
            const host = new URL(text).host;
            return `video.url 为 https(host=${host}, len=${text.length})`;
        } catch {
            return `video.url 为 https 字符串(len=${text.length})`;
        }
    }
    if (text.startsWith("//")) return `video.url 为协议相对地址(len=${text.length})`;
    if (text.startsWith("/")) return `video.url 为相对路径(len=${text.length})`;
    return `video.url 非 http 字符串(len=${text.length}, head=${text.slice(0, 24)})`;
}

function readGrokRespectModeration(payload: unknown): boolean | null {
    if (!payload || typeof payload !== "object") return null;
    const root = payload as Record<string, unknown>;
    const video = root.video && typeof root.video === "object" && !Array.isArray(root.video) ? (root.video as Record<string, unknown>) : null;
    const raw = video?.respect_moderation ?? root.respect_moderation;
    if (typeof raw === "boolean") return raw;
    if (raw === 0 || raw === "0" || raw === "false") return false;
    if (raw === 1 || raw === "1" || raw === "true") return true;
    return null;
}

function formatGrokDoneWithoutUrlError(raw: unknown, state: GrokVideoResponse, taskId: string) {
    const keys = summarizeGrokPayloadKeys(raw) || summarizeGrokPayloadKeys(state);
    const urlShape = describeGrokVideoUrlField(state) || describeGrokVideoUrlField(raw);
    const moderation = readGrokRespectModeration(state) ?? readGrokRespectModeration(raw);
    const parts = [
        "Grok 任务显示已完成，但响应里没有可播放的视频地址",
        `任务 id：${taskId}`,
        `字段：${keys || "（空）"}`,
        `诊断：${urlShape}`,
    ];
    if (moderation === true) {
        parts.push("响应含 respect_moderation=true，若 video.url 一直为空，可能被审核拦截或中转未回填成片地址");
    } else if (urlShape.includes("空字符串") || urlShape.includes("缺失")) {
        parts.push("常见于中转 status/progress 先到 100、video.url 晚写或永不写；已等待约 3 分钟仍无地址");
        parts.push("可换渠道重试，或打开 Network 的 GET …/videos/{id} 看 video.url 是否始终为空");
    } else if (urlShape.includes("相对") || urlShape.includes("非 http")) {
        parts.push("video.url 存在但不是可直接播放的 http(s) 地址，已尝试 content 下载仍失败");
    }
    return parts.join("。");
}

function formatGrokPollUnsupportedError(config: AiConfig, taskId = "") {
    return [
        "当前中转站长时间无法查询 Grok 视频状态",
        "官方路径是 GET /v1/videos/{request_id}",
        `你的 Base URL：${config.baseUrl.trim() || "（空）"}`,
        taskId ? `任务 id：${taskId}` : "",
        "若 POST /v1/videos/generations 或 /videos/edits 能创建但查询持续「404 page not found」，需要中转站补齐查询接口",
        "codex2api 请确认 Base URL 为 https://www.codex2api.com 或 …/v1，查询应打 GET /v1/videos/{request_id}",
        "参考图生视频请确认创建请求使用本地小图；参考视频 edits 与 generation 共用同一查询路径",
    ]
        .filter(Boolean)
        .join("。");
}

function formatGrokPollTaskMissingError(config: AiConfig, taskId: string) {
    return [
        `Grok 任务已创建，但查询约 3 分钟仍找不到 id「${taskId}」`,
        "官方查询：GET /v1/videos/{request_id}",
        `你的 Base URL：${config.baseUrl.trim() || "（空）"}`,
        "请打开 Network：① 看创建 POST（generations 或 edits）响应里的 request_id/id ② 看 GET /v1/videos/… 的状态码与 JSON",
        "若创建有 request_id 但 GET 一直 404，是中转站任务落库/查询问题；若创建根本没返回 id，把创建响应发我",
    ].join("。");
}

function isRetryableGrokPollNetworkError(error: unknown) {
    if (!axios.isAxiosError(error)) return false;
    if (error.response) return false;
    const code = String(error.code || "").toUpperCase();
    return code === "ERR_NETWORK" || code === "ECONNABORTED" || code === "ECONNRESET" || code === "ETIMEDOUT" || !error.response;
}

async function createAgnesTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const referenceError = agnesVideoRequestError(config, references, videoReferences, audioReferences);
    if (referenceError) throw new Error(referenceError);
    const duration = normalizeAgnesDuration(config.videoSeconds);
    const payload = {
        model: modelOptionName(model),
        prompt,
        height: AGNES_VIDEO_HEIGHT,
        width: AGNES_VIDEO_WIDTH,
        num_frames: agnesFrameCount(duration),
        frame_rate: 24,
    };

    try {
        const created = unwrapAgnesTask((await requestWithRateLimitRetry(() => axios.post<ApiAgnesResponse>(agnesCreateApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal }), options?.signal)).data);
        const id = created.video_id || created.id;
        if (!id) throw new Error("Agnes 接口没有返回 video_id");
        return { id, provider: "agnes", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "Agnes 视频任务创建失败"));
    }
}

async function pollAgnesTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapAgnesTask((await requestWithRateLimitRetry(() => axios.get<ApiAgnesResponse>(agnesPollApiUrl(config, task.id), { headers: aiHeaders(config), signal: options?.signal }), options?.signal)).data);
        const status = String(state.status || "").toLowerCase();
        const url = state.video_url || state.url || state.result_url || state.metadata?.url;
        if (url) {
            try {
                return { status: "completed", result: await videoResultFromUrl(url, options, config, true) };
            } catch (error) {
                if (error instanceof VideoOutputNotReadyError) return { status: "pending" };
                throw error;
            }
        }
        if (["failed", "fail", "error", "cancelled", "canceled"].includes(status)) return { status: "failed", error: readAgnesError(state) || "Agnes 视频生成失败" };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "Agnes 视频任务查询失败"));
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!isArkPlanBaseUrl(config.baseUrl)) {
        return createSeedanceRelayTask(config, model, prompt, references, videoReferences, audioReferences, options);
    }
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error("请输入视频提示词，或连接参考图片/视频/音频");
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality, modelOptionName(model)),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error("Seedance 接口没有返回任务 ID");
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务创建失败"));
    }
}

async function createSeedanceRelayTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    // OpenAI2API / New API Seedance:
    // - text-only: prompt body (proven)
    // - single image only: images[] (proven)
    // - multi image / any video: content[] with role (upstream: "role must be specified for image contents")
    // Audio still requires Agent Plan — no verified relay field yet.
    if (audioReferences.length) {
        throw new Error("当前 OpenAI 兼容 Seedance 中转暂不支持参考音频；请切换火山 Agent Plan 渠道");
    }
    if (videoReferences.length) assertSeedanceVideoReferences(videoReferences);
    const createPath = seedanceCreatePath(config);
    // Resolve every selected media first; never POST a partial/text-only fallback.
    const images = references.length ? await resolveSeedanceRelayImages(config, references) : undefined;
    const videos = videoReferences.length ? await resolveSeedanceRelayVideos(videoReferences) : undefined;
    const payload = buildSeedanceRelayPayload(config, model, prompt, images, videos);
    try {
        const created = unwrapVideoResponse(
            (
                await axios.post<ApiVideoResponse>(aiApiUrl(config, createPath), payload, {
                    headers: aiHeaders(config, "application/json"),
                    signal: options?.signal,
                    timeout: 180000,
                })
            ).data,
        );
        if (!created.id) throw new Error("Seedance 中转接口没有返回任务 ID");
        return { id: created.id, provider: "seedance", model, requestModel: modelOptionName(model), createPath };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 中转任务创建失败"));
    }
}

function seedanceCreatePath(config: AiConfig) {
    return isArkPlanBaseUrl(config.baseUrl) ? "/contents/generations/tasks" : "/video/generations";
}

/** Exposed for regression tests of native Seedance protocol routing. */
export function seedanceCreatePathForTest(config: AiConfig) {
    return seedanceCreatePath(config);
}

/**
 * Resolve every selected relay reference image, preserving order.
 * Throws if any image is unreadable — callers must not filter/drop refs.
 */
async function resolveSeedanceRelayImages(config: AiConfig, references: ReferenceImage[]) {
    const images = await Promise.all(references.map((image) => resolveSeedanceImageUrl(config, image)));
    if (images.length !== references.length || images.some((image) => !image)) {
        throw new Error("参考图读取失败，请换一张图片或重新上传");
    }
    return images;
}

/**
 * Resolve every selected relay reference video, preserving order.
 * Throws if any video is unreadable — callers must not filter/drop refs.
 */
async function resolveSeedanceRelayVideos(videoReferences: ReferenceVideo[]) {
    const videos = await Promise.all(videoReferences.map((video) => resolveSeedanceVideoUrl(video)));
    if (videos.length !== videoReferences.length || videos.some((video) => !video)) {
        throw new Error("参考视频读取失败，请换一个视频或重新上传");
    }
    return videos;
}

/**
 * Seedance multi-image roles for OpenAI-compatible relays that forward to Volcano content[].
 * 1 image → reference_image; 2 → first/last frame; 3+ → first + reference* + last.
 */
export function seedanceRelayImageRole(index: number, total: number) {
    if (total <= 1) return "reference_image";
    if (total === 2) return index === 0 ? "first_frame" : "last_frame";
    if (index === 0) return "first_frame";
    if (index === total - 1) return "last_frame";
    return "reference_image";
}

function buildSeedanceRelayContent(prompt: string, images: string[] = [], videos: string[] = []) {
    const content: Array<Record<string, unknown>> = [];
    const text = prompt.trim();
    if (text) content.push({ type: "text", text });
    for (let index = 0; index < images.length; index += 1) {
        content.push({
            type: "image_url",
            image_url: { url: images[index] },
            role: seedanceRelayImageRole(index, images.length),
        });
    }
    for (const url of videos) {
        content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    }
    return content;
}

function buildSeedanceRelayPayload(config: AiConfig, model: string, prompt: string, images?: string[], videos?: string[]): Record<string, unknown> {
    const base: Record<string, unknown> = {
        model: modelOptionName(model),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        resolution: normalizeSeedanceResolution(config.vquality, modelOptionName(model)),
        ratio: normalizeSeedanceRatio(config.size),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
    };
    const imageList = images?.length ? images : [];
    const videoList = videos?.length ? videos : [];

    // Text-only: keep proven prompt body (no empty media arrays).
    if (!imageList.length && !videoList.length) {
        return { ...base, prompt };
    }

    // Single image, no video: keep proven images[] path that already works on openai2api.
    if (imageList.length === 1 && !videoList.length) {
        return { ...base, prompt, images: imageList };
    }

    // Multi-image and/or video: upstream requires content[] with role on each media item.
    // Never fall back to images[] without role (that yields InvalidParameter on multi-ref).
    return {
        ...base,
        content: buildSeedanceRelayContent(prompt, imageList, videoList),
    };
}

/** Exposed for regression tests of the native API-key Seedance relay contract. */
export function seedanceRelayPayloadForTest(config: AiConfig, model: string, prompt: string, images?: string[], videos?: string[]) {
    return buildSeedanceRelayPayload(config, model, prompt, images, videos);
}

function seedanceRelayContentItems(payload: Record<string, unknown>, type: "image_url" | "video_url") {
    if (!Array.isArray(payload.content)) return [];
    return payload.content.filter((item) => item && typeof item === "object" && (item as { type?: string }).type === type);
}

/** Exposed for regression tests: every selected image must remain on the relay body. */
export function payloadKeepsAllSeedanceRelayReferences(payload: Record<string, unknown>, expectedCount: number) {
    if (expectedCount <= 0) {
        const noImagesArray = !Array.isArray(payload.images) || (payload.images as unknown[]).length === 0;
        return noImagesArray && seedanceRelayContentItems(payload, "image_url").length === 0;
    }
    if (Array.isArray(payload.images) && (payload.images as unknown[]).length === expectedCount) return true;
    return seedanceRelayContentItems(payload, "image_url").length === expectedCount;
}

/** Exposed for regression tests: every selected video must remain on the relay body. */
export function payloadKeepsAllSeedanceRelayVideoReferences(payload: Record<string, unknown>, expectedCount: number) {
    if (expectedCount <= 0) {
        const noVideosArray = !Array.isArray(payload.videos) || (payload.videos as unknown[]).length === 0;
        return noVideosArray && seedanceRelayContentItems(payload, "video_url").length === 0;
    }
    if (Array.isArray(payload.videos) && (payload.videos as unknown[]).length === expectedCount) return true;
    return seedanceRelayContentItems(payload, "video_url").length === expectedCount;
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.createPath === "/video/generations") {
        return pollOpenAIVideoTask(config, task, options);
    }
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = openAiCompatibleVideoUrl(state);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options, config) };
        if (state.status === "succeeded" || state.status === "completed") {
            return { status: "failed", error: "Seedance 任务成功但没有返回视频 URL" };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") {
            return { status: "failed", error: readErrorPayload(state.error?.message) || readErrorPayload(state) || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}` };
        }
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务查询失败"));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error("Seedance 参考视频单个时长需要在 2-15 秒之间");
        total += video.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考视频总时长不能超过 15 秒");
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error("Seedance 参考音频单个时长需要在 2-15 秒之间");
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考音频总时长不能超过 15 秒");
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

function agnesCreateApiUrl(config: AiConfig) {
    return agnesApiUrl(config, "/v1/videos");
}

function agnesPollApiUrl(config: AiConfig, taskId: string) {
    return agnesApiUrl(config, `/agnesapi?video_id=${encodeURIComponent(taskId)}`);
}

/** 按渠道+是否带参考图缓存已验证可用的 Grok 创建路径。 */
const grokCreatePathState = new Map<string, string>();
/** 按 host 记住确认不存在的创建路径，避免把 404 路径提到首位或反复试。 */
const grokCreatePathMissingState = new Map<string, Set<string>>();

function grokCreatePathCacheKey(config: AiConfig, imageCount = 0) {
    return `${hostKeyOf(config)}::${imageCount > 0 ? "img" : "txt"}`;
}

/**
 * 直连内网/回环的 OpenAI 兼容站（常见 New API），且不是同源 /lan-ai（家里 Grok2API 隧道）。
 * 这类站 Grok 视频路径是 /video/generations，/videos/generations 实测不存在。
 */
function isLikelyPrivateNewApiBaseUrl(baseUrl: string) {
    if (isCodex2apiBaseUrl(baseUrl) || isXaiBaseUrl(baseUrl) || isLanAiBaseUrl(baseUrl) || isAiProxyBaseUrl(baseUrl)) return false;
    const raw = baseUrl.trim();
    if (!raw) return false;
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
        return isPrivateOrLoopbackHost(url.hostname);
    } catch {
        return false;
    }
}

/**
 * Grok 创建路径候选（仅 generation，不含 video edits）：
 * - 多参考图/图生/文生都是 generation，不是 POST /videos/edits
 * - 公网 codex2api / xAI：/videos/generations（该站 /videos 不存在）
 * - 内网 New API：Grok 只走 /video/generations，再可试 /videos；跳过不存在的 /videos/generations
 * - 其它中转：/videos 与 generations 都试
 */
export function grokCreatePathCandidates(config: AiConfig, imageCount = 0, model = "") {
    const cacheKey = grokCreatePathCacheKey(config, imageCount);
    const hostKey = hostKeyOf(config);
    const missing = grokCreatePathMissingState.get(hostKey);
    const cachedRaw = grokCreatePathState.get(cacheKey);
    const cached = cachedRaw && missing?.has(cachedRaw) ? undefined : cachedRaw;
    const codex = isCodex2apiBaseUrl(config.baseUrl);
    const xai = isXaiBaseUrl(config.baseUrl);
    const privateNewApi = isLikelyPrivateNewApiBaseUrl(config.baseUrl);
    const modelName = modelOptionName(model || config.videoModel || config.model || "").toLowerCase();
    const grokLike = modelName.includes("grok") || modelName.includes("imagine-video") || modelName.includes("imagine_video");
    // 多图参考仍走 generation；edits 是「已有视频 + 提示词」能力，禁止混用
    let ordered: string[];
    if (codex || xai) {
        ordered = ["/videos/generations"];
    } else if (grokLike && privateNewApi) {
        // 192.168 New API：/video/generations 存在；/videos/generations 404；/videos 易 platform 48
        ordered = ["/video/generations", "/videos"];
    } else if (grokLike) {
        // 公网/未知 Grok 中转：仍保留三代路径兜底，但 singular 优先
        ordered = ["/video/generations", "/videos/generations", "/videos"];
    } else if (privateNewApi) {
        ordered = ["/videos", "/video/generations"];
    } else {
        ordered = ["/videos", "/video/generations", "/videos/generations"];
    }
    if (missing?.size) {
        ordered = ordered.filter((path) => !missing.has(path));
        if (!ordered.length) {
            // 全部被负缓存时回退到原始首选，避免空列表卡死（例如后台刚开通路由）
            ordered = codex || xai ? ["/videos/generations"] : grokLike ? ["/video/generations"] : ["/videos"];
        }
    }
    if (!cached || !ordered.includes(cached)) return ordered;
    return [cached, ...ordered.filter((path) => path !== cached)];
}

/** New API：模型绑定的渠道类型与当前 API 路径不匹配（如 Grok 打到 OpenAI Videos）。 */
function isNewApiPlatformMismatchError(error: unknown) {
    if (!axios.isAxiosError(error) && !(error instanceof Error)) {
        return /invalid api platform/i.test(String(error || ""));
    }
    const data = axios.isAxiosError(error) ? (error.response?.data as { error?: { message?: string; code?: string }; msg?: string; message?: string } | string | undefined) : undefined;
    const raw = typeof data === "string" ? data : `${data?.error?.message || ""} ${data?.error?.code || ""} ${data?.msg || ""} ${data?.message || ""} ${axios.isAxiosError(error) ? error.message : (error as Error).message || ""}`;
    return /invalid api platform/i.test(raw);
}

function rememberGrokCreatePath(config: AiConfig, path: string, imageCount = 0) {
    const hostKey = hostKeyOf(config);
    const missing = grokCreatePathMissingState.get(hostKey);
    missing?.delete(path);
    if (missing && missing.size === 0) grokCreatePathMissingState.delete(hostKey);
    grokCreatePathState.set(grokCreatePathCacheKey(config, imageCount), path);
}

function rememberGrokCreatePathMissing(config: AiConfig, path: string) {
    // codex/xAI 只有单一 generation 路径，负缓存会让候选变空，无收益
    if (isCodex2apiBaseUrl(config.baseUrl) || isXaiBaseUrl(config.baseUrl)) return;
    const hostKey = hostKeyOf(config);
    const set = grokCreatePathMissingState.get(hostKey) || new Set<string>();
    set.add(path);
    grokCreatePathMissingState.set(hostKey, set);
    // 成功缓存若指向已确认不存在的路径，清掉以免下次又提到第一位
    for (const mode of ["img", "txt"] as const) {
        const key = `${hostKey}::${mode}`;
        if (grokCreatePathState.get(key) === path) grokCreatePathState.delete(key);
    }
}

/** 与 generation 缓存隔离：仅缓存 edits 路径。 */
const grokEditPathState = new Map<string, string>();

function grokEditPathCacheKey(config: AiConfig) {
    return `${hostKeyOf(config)}::edit`;
}

/**
 * Grok 视频编辑路径（仅 edits，永不混入 generation 候选）：
 * - codex2api 实测 POST /videos/edits 存在（无 Key 时 401）
 * - 内网 New API 当前无 /videos/edits、/video/edits（404 Invalid URL）→ 单路径 fail-fast
 */
export function grokEditPathCandidates(config: AiConfig) {
    const cacheKey = grokEditPathCacheKey(config);
    const cached = grokEditPathState.get(cacheKey);
    const ordered = ["/videos/edits"];
    if (!cached || !ordered.includes(cached)) return ordered;
    return [cached, ...ordered.filter((path) => path !== cached)];
}

function rememberGrokEditPath(config: AiConfig, path: string) {
    grokEditPathState.set(grokEditPathCacheKey(config), path);
}

/**
 * 单条参考视频 edits body 候选。
 * codex2api 实测：multipart → 415 Unsupported Media Type，只认 JSON（video/video_url data URI 或公网 URL）。
 * 其它中转：JSON 优先，multipart 仅作末位兜底。
 */
export async function buildGrokEditPayloadCandidates(config: AiConfig, model: string, prompt: string, video: ReferenceVideo) {
    const error = grokEditVideoReferenceError([video]);
    if (error) throw new Error(error);
    const modelName = modelOptionName(model);
    const duration = normalizeGrokDuration(config.videoSeconds);
    const aspectRatio = normalizeGrokAspectRatio(config.size);
    const resolution = normalizeGrokResolution(config.vquality);
    const channel = resolveModelChannel(config, model);
    const models = grokModelCandidates(modelName, 0, config.baseUrl, channel.models || []).slice(0, 2);
    const primaryModel = models[0] || modelName;
    // codex2api / xAI：不要发 multipart（415）
    const preferJsonOnly = isCodex2apiBaseUrl(config.baseUrl) || isXaiBaseUrl(config.baseUrl);

    const candidates: Array<Record<string, unknown> | FormData> = [];
    const pushJson = (payload: Record<string, unknown>) => {
        const key = JSON.stringify(payload);
        if (candidates.some((item) => !(item instanceof FormData) && JSON.stringify(item) === key)) return;
        candidates.push(payload);
    };

    // 1) JSON：公网 URL 或本地 data URI（codex2api 只认 JSON，本地文件必须转 data URI）
    let videoUrl = "";
    try {
        // 始终允许较大 data URI：codex 无 multipart 可退；其它中转 JSON 也优先
        videoUrl = await resolveGrokEditVideoUrl(video, { allowLargeDataUrl: true });
    } catch (resolveError) {
        // 体积硬顶等：codex 只能失败；非 codex 可再试 multipart
        if (resolveError instanceof Error && /超过|压缩|剪短|编码后过大/.test(resolveError.message)) {
            if (preferJsonOnly) throw resolveError;
            videoUrl = "";
        } else {
            videoUrl = "";
        }
    }
    if (videoUrl) {
        for (const nextModel of models) {
            // 优先带用户完整规格（比例 + 清晰度 + 时长）；去掉清晰度/比例只作创建失败兜底
            pushJson({ model: nextModel, prompt, video: { url: videoUrl }, duration, aspect_ratio: aspectRatio, resolution });
            pushJson({ model: nextModel, prompt, video_url: videoUrl, duration, aspect_ratio: aspectRatio, resolution });
            pushJson({ model: nextModel, prompt, video: videoUrl, duration, aspect_ratio: aspectRatio, resolution });
            pushJson({ model: nextModel, prompt, input_video: { url: videoUrl }, duration, aspect_ratio: aspectRatio, resolution });
            pushJson({ model: nextModel, prompt, video: { url: videoUrl }, seconds: String(duration), aspect_ratio: aspectRatio, resolution });
            pushJson({ model: nextModel, prompt, video_url: videoUrl, seconds: String(duration), aspect_ratio: aspectRatio, resolution });
            // 创建失败后再试：有比例无清晰度
            pushJson({ model: nextModel, prompt, video: { url: videoUrl }, duration, aspect_ratio: aspectRatio });
            pushJson({ model: nextModel, prompt, video_url: videoUrl, duration, aspect_ratio: aspectRatio });
            pushJson({ model: nextModel, prompt, video: videoUrl, duration, aspect_ratio: aspectRatio });
            // 末位兜底：无比例
            pushJson({ model: nextModel, prompt, video: { url: videoUrl }, duration });
            pushJson({ model: nextModel, prompt, video_url: videoUrl, duration });
            pushJson({ model: nextModel, prompt, video: videoUrl, duration });
            pushJson({ model: nextModel, prompt, video_url: videoUrl, seconds: String(duration) });
        }
    }

    // 2) multipart 仅非 codex 中转兜底（字段名多试几个）
    if (!preferJsonOnly) {
        let localFile: File | null = null;
        try {
            localFile = await resolveGrokEditVideoFile(video);
        } catch {
            localFile = null;
        }
        if (localFile) {
            for (const field of ["video", "input_video", "input_reference"] as const) {
                const body = new FormData();
                body.append("model", primaryModel);
                body.append("prompt", prompt);
                body.append("duration", String(duration));
                body.append("seconds", String(duration));
                body.append("aspect_ratio", aspectRatio);
                body.append("resolution", resolution);
                body.append(field, localFile, localFile.name || "reference.mp4");
                candidates.push(body);
            }
        }
    }

    if (!candidates.length) {
        throw new Error("参考视频无法读取：请重新上传本地 mp4（建议 ≤40MB 更稳），或提供公网可访问的视频 URL");
    }
    return candidates.slice(0, preferJsonOnly ? 10 : 12);
}

async function resolveGrokEditVideoUrl(video: ReferenceVideo, options?: { allowLargeDataUrl?: boolean }) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    if (video.url?.startsWith("data:")) {
        assertGrokEditDataUrlSize(video.url, video.name || "参考视频", Boolean(options?.allowLargeDataUrl));
        return video.url;
    }
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("参考视频必须是公网 URL、素材 ID，或本地已保存的视频");
    if (blob.size > GROK_EDIT_REFERENCE_LIMITS.videoMaxBytes) {
        throw new Error(`参考视频超过 ${Math.round(GROK_EDIT_REFERENCE_LIMITS.videoMaxBytes / 1024 / 1024)}MB（${Math.round(blob.size / 1024 / 1024)}MB），请压缩或剪短后再上传`);
    }
    // codex2api 等只吃 JSON 时允许较大 data URI；否则仍限制，避免无谓膨胀
    if (!options?.allowLargeDataUrl && blob.size > GROK_EDIT_REFERENCE_LIMITS.jsonDataUrlMaxBytes) {
        throw new Error("local-video-too-large-for-json");
    }
    const dataUrl = await blobToDataUrl(blob);
    assertGrokEditDataUrlSize(dataUrl, video.name || "参考视频", Boolean(options?.allowLargeDataUrl));
    return dataUrl;
}

async function resolveGrokEditVideoFile(video: ReferenceVideo): Promise<File | null> {
    let blob: Blob | null = null;
    const name = video.name || "reference.mp4";
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob && video.url?.startsWith("data:")) {
        const res = await fetch(video.url);
        blob = await res.blob();
    }
    if (!blob) return null;
    if (blob.size > GROK_EDIT_REFERENCE_LIMITS.videoMaxBytes) {
        throw new Error(`参考视频超过 ${Math.round(GROK_EDIT_REFERENCE_LIMITS.videoMaxBytes / 1024 / 1024)}MB（${Math.round(blob.size / 1024 / 1024)}MB），请压缩或剪短后再上传`);
    }
    const type = blob.type || video.type || "video/mp4";
    return new File([blob], name, { type });
}

function assertGrokEditDataUrlSize(dataUrl: string, label: string, allowLarge = false) {
    // rough decoded size ≈ 3/4 of base64 payload
    const comma = dataUrl.indexOf(",");
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const approxBytes = Math.floor((b64.length * 3) / 4);
    // codex JSON 路径允许接近上传硬顶；编码后体积会再大 ~33%
    const limit = allowLarge ? GROK_EDIT_REFERENCE_LIMITS.videoMaxBytes : GROK_EDIT_REFERENCE_LIMITS.jsonDataUrlMaxBytes;
    if (approxBytes > limit) {
        throw new Error(
            `${label} 编码后过大（约 ${Math.round(approxBytes / 1024 / 1024)}MB）。codex2api 的 /videos/edits 只接受 JSON，请将源文件压到约 ${Math.round(limit / 1024 / 1024)}MB 以内再试`,
        );
    }
}

function isUnsupportedMediaTypeError(error: unknown) {
    if (!axios.isAxiosError(error)) return /unsupported media type|415/i.test(String(error || ""));
    if (error.response?.status === 415) return true;
    const data = error.response?.data as { error?: { message?: string }; message?: string; msg?: string } | string | undefined;
    const raw = typeof data === "string" ? data : `${data?.error?.message || ""} ${data?.message || ""} ${data?.msg || ""} ${error.message || ""}`;
    return /unsupported media type/i.test(raw);
}

/** edits 专用：400/415/422 可换 body 字段；与 generation 的 isRetryableGrokPayloadError 分离。 */
function isRetryableGrokEditPayloadError(error: unknown) {
    if (!axios.isAxiosError(error)) return false;
    if (isInvalidUrlGrokError(error) || isNewApiPlatformMismatchError(error)) return false;
    const status = error.response?.status;
    if (status === 400 || status === 415 || status === 422) return true;
    return isRetryableGrokPayloadError(error);
}

function formatGrokEditCreateError(error: unknown, attemptCount: number, createUrl = "") {
    const base = readAxiosError(error, "Grok 视频编辑失败");
    const pathMissing = isGrokCreatePathMissingError(error, { hasImages: false }) || isInvalidUrlGrokError(error);
    const platformMismatch = isNewApiPlatformMismatchError(error);
    const unsupportedMedia = isUnsupportedMediaTypeError(error);
    const tips = [
        pathMissing
            ? "当前中转没有 /v1/videos/edits（例如内网 New API 常返回 Invalid URL）。请改用支持 edits 的公网中转（如 codex2api），或移除参考视频改走文生/图生 generation"
            : "",
        platformMismatch
            ? "渠道类型与 /videos/edits 不匹配（invalid api platform）。请在中转后台把 Grok 视频模型绑到支持 xAI video edits 的渠道，或换 codex2api"
            : "",
        unsupportedMedia
            ? "415 Unsupported Media Type：codex2api 的 /videos/edits 不接受 multipart/form-data。本应用会改发 JSON（video / video_url + data URI）。请硬刷新后再试；若仍 415，把响应 JSON 发我"
            : "",
        !pathMissing && !platformMismatch && !unsupportedMedia
            ? "Grok 参考视频编辑走 POST /v1/videos/edits（JSON，不是 multipart，也不是 /videos/generations）。请确认：① 仅 1 条 MP4 ② 未同时挂参考图 ③ 源文件建议 ≤40MB 更稳、约 1–15 秒 ④ 提示词已填写"
            : "",
        createUrl ? `请求：${createUrl}` : "",
        attemptCount > 1 ? `已尝试 ${attemptCount} 种 body 字段组合` : "",
    ].filter(Boolean);
    return tips.length ? `${base}\n${tips.join("\n")}` : base;
}

function grokCreateApiUrl(config: AiConfig, imageCount = 0) {
    const path = grokCreatePathCandidates(config, imageCount)[0] || "/videos/generations";
    return aiApiUrl(config, path);
}

/** New API 等对不存在的路由返回 404 + "Invalid URL"；codex2api 多图大 body 也可能假 404，不能一律当路径不存在。 */
function isGrokCreatePathMissingError(error: unknown, context?: { hasImages?: boolean; payload?: Record<string, unknown> }) {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    const data = error.response?.data as { error?: { code?: string; message?: string }; msg?: string; message?: string } | string | undefined;
    const rawText = typeof data === "string" ? data : `${data?.error?.code || ""} ${data?.error?.message || ""} ${data?.msg || ""} ${data?.message || ""} ${error.message || ""}`;
    const blob = rawText.toLowerCase();
    if (blob.includes("model_not_found") || blob.includes("模型不存在") || blob.includes("unknown model") || blob.includes("no such model")) {
        return false;
    }
    // New API：未知路由 → Invalid URL
    if (isInvalidUrlGrokError(error)) return true;
    if (status !== 404 && status !== 405) return false;
    // 多图/带图时，codex2api 对过大 payload 可能回纯文本 “404 page not found”，更像网关拒包，不是路由缺失
    if (context?.hasImages && /page not found|not found/.test(blob) && !/invalid url/.test(blob)) {
        return false;
    }
    return true;
}

function shouldTryOpenAiCompatibleGrokFallback(config: AiConfig, error: unknown, references: ReferenceImage[]) {
    // codex2api 的 /v1/videos 不存在，回退只会浪费请求
    if (isCodex2apiBaseUrl(config.baseUrl) || isXaiBaseUrl(config.baseUrl)) return false;
    if (!error) return true;
    return isGrokCreatePathMissingError(error, { hasImages: references.length > 0 }) || isInvalidUrlGrokError(error) || (axios.isAxiosError(error) && [400, 404, 405, 415, 422].includes(error.response?.status || 0));
}

export async function buildGrokPayloadCandidates(config: AiConfig, model: string, prompt: string, references: ReferenceImage[]) {
    if (references.length > 7) {
        throw new Error(`Grok 多参考图视频当前最多支持 7 张；已选择 ${references.length} 张，请删减后重试`);
    }
    const modelName = modelOptionName(model);
    const duration = normalizeGrokDuration(config.videoSeconds);
    const aspectRatio = normalizeGrokAspectRatio(config.size);
    const resolution = normalizeGrokResolution(config.vquality);
    // 长提示词 + data URI 时中转/xAI 更易 400：压图预算随 prompt 收紧（不截断提示词）
    const imageInputs = await Promise.all(references.map((image) => resolveGrokImageInput(image, config, references.length, prompt)));
    // 用当前渠道已拉取的模型列表约束候选，避免硬塞上游不存在的 grok-imagine-video-1.5
    const channel = resolveModelChannel(config, model);
    const models = grokModelCandidates(modelName, imageInputs.length, config.baseUrl, channel.models || []);
    const relay = isCodex2apiBaseUrl(config.baseUrl) || isLanAiBaseUrl(config.baseUrl);
    // 清晰度候选：用户所选优先（选 1080p 就先发 1080p）。失败再降 720/480；不再静默把图生 1080 改成先 720。
    const resolutions = grokResolutionCandidates(resolution, imageInputs.length, config.baseUrl);

    const candidates: Array<Record<string, unknown>> = [];
    const pushUnique = (payload: Record<string, unknown>) => {
        const key = JSON.stringify(payload);
        if (candidates.some((item) => JSON.stringify(item) === key)) return;
        candidates.push(payload);
    };

    // 用户选的比例/时长/清晰度必须进主候选。
    // 顺序硬约束：① 完整用户规格 ② 字段变体（仍保留用户规格）③ 仅创建失败后的降档/去字段兜底。
    // 禁止用无 resolution 或更低 resolution 的 body 抢先成功。
    if (!imageInputs.length) {
        // 1) 所有模型先完整用户规格
        for (const nextModel of models) {
            pushUnique({ model: nextModel, prompt, duration, aspect_ratio: aspectRatio, resolution });
            pushUnique({ model: nextModel, prompt, seconds: String(duration), aspect_ratio: aspectRatio, resolution });
            const openAiSize = openAiVideoSizeFromGrok(aspectRatio, resolution);
            if (openAiSize) pushUnique({ model: nextModel, prompt, seconds: String(duration), size: openAiSize });
        }
        // 2) 创建失败后再降清晰度（只降不升）
        for (const nextResolution of resolutions.slice(1)) {
            for (const nextModel of models) {
                pushUnique({ model: nextModel, prompt, duration, aspect_ratio: aspectRatio, resolution: nextResolution });
            }
        }
        // 3) 去掉清晰度 / 比例的兜底
        for (const nextModel of models) {
            pushUnique({ model: nextModel, prompt, duration, aspect_ratio: aspectRatio });
            pushUnique({ model: nextModel, prompt, duration });
            pushUnique({ model: nextModel, prompt, seconds: String(duration) });
        }
        return candidates.slice(0, relay ? 10 : 8);
    }

    // 图生视频 / 参考生视频
    // 官方：单图 image:{url}；多图 reference_images。中转站常还需兼容 images / image_url。
    // 勿混用 image + reference_images。
    if (imageInputs.length === 1) {
        const image = imageInputs[0];
        // 单图 I2V：完整用户规格必须先于任何降档/无 resolution 最小 body。
        // 多模型时也先让每个模型都试用户规格，再统一降档——禁止 modelA 的 720 抢在 modelB 的 1080 前。
        // 1) 用户所选清晰度 + 比例（所有模型 × 字段变体）
        for (const nextModel of models) {
            pushUnique({ model: nextModel, prompt, image, duration, aspect_ratio: aspectRatio, resolution });
            pushUnique({ model: nextModel, prompt, image: image.url, duration, aspect_ratio: aspectRatio, resolution });
            pushUnique({ model: nextModel, prompt, image_url: image.url, duration, aspect_ratio: aspectRatio, resolution });
            if (!relay) pushUnique({ model: nextModel, prompt, images: [image.url], duration, aspect_ratio: aspectRatio, resolution });
        }
        // 2) 创建失败后再降清晰度（只降不升）
        for (const nextResolution of resolutions.slice(1)) {
            for (const nextModel of models) {
                pushUnique({ model: nextModel, prompt, image, duration, aspect_ratio: aspectRatio, resolution: nextResolution });
            }
        }
        // 3) 有比例但无分辨率
        for (const nextModel of models) {
            pushUnique({ model: nextModel, prompt, image, duration, aspect_ratio: aspectRatio });
            pushUnique({ model: nextModel, prompt, image_url: image.url, duration, aspect_ratio: aspectRatio });
        }
        // 4) 最小成功面兜底——放最后
        for (const nextModel of models) {
            pushUnique({ model: nextModel, prompt, image, duration });
            pushUnique({ model: nextModel, prompt, image: image.url, duration });
            pushUnique({ model: nextModel, prompt, image_url: image.url, duration });
        }
    } else {
        // 多图参考生视频 = multi-reference generation（POST /videos/generations），不是 video edits
        // 顺序：① 完整用户规格 + 全量参考图（多种字段写法）
        //      ② 创建失败后降清晰度
        //      ③ 无分辨率 / 无比例兜底
        // 双模型仍用 round-robin interleave，避免某一模型把 slice 配额吃光
        const labeledPrompt = buildGrokReferencePrompt(prompt, imageInputs.length);
        const urls = imageInputs.map((item) => item.url);
        const perModel = models.map((nextModel) => {
            const payloads: Array<Record<string, unknown>> = [];
            const push = (payload: Record<string, unknown>) => {
                const key = JSON.stringify(payload);
                if (!payloads.some((item) => JSON.stringify(item) === key)) payloads.push(payload);
            };
            // 1) 用户所选清晰度 + 全量参考图（字段变体）
            push({
                model: nextModel,
                prompt: labeledPrompt,
                reference_images: imageInputs,
                duration,
                aspect_ratio: aspectRatio,
                resolution,
            });
            push({ model: nextModel, prompt: labeledPrompt, reference_images: urls, duration, aspect_ratio: aspectRatio, resolution });
            push({ model: nextModel, prompt: labeledPrompt, images: urls, duration, aspect_ratio: aspectRatio, resolution });
            push({ model: nextModel, prompt: labeledPrompt, image_urls: urls, duration, aspect_ratio: aspectRatio, resolution });
            push({ model: nextModel, prompt: labeledPrompt, images: imageInputs, duration, aspect_ratio: aspectRatio, resolution });
            // 2) 创建失败后再降清晰度（只降不升），仍保留全量参考图
            for (const nextResolution of resolutions.slice(1)) {
                push({
                    model: nextModel,
                    prompt: labeledPrompt,
                    reference_images: imageInputs,
                    duration,
                    aspect_ratio: aspectRatio,
                    resolution: nextResolution,
                });
            }
            // 3) 无分辨率 / 无比例兜底
            push({ model: nextModel, prompt: labeledPrompt, reference_images: imageInputs, duration, aspect_ratio: aspectRatio });
            push({ model: nextModel, prompt: labeledPrompt, reference_images: imageInputs, duration });
            if (!relay) {
                push({ model: nextModel, prompt: labeledPrompt, image: imageInputs, duration, aspect_ratio: aspectRatio, resolution });
                push({ model: nextModel, prompt: labeledPrompt, image: urls, duration, aspect_ratio: aspectRatio, resolution });
            }
            return payloads;
        });
        const maxPerModel = Math.max(0, ...perModel.map((payloads) => payloads.length));
        for (let payloadIndex = 0; payloadIndex < maxPerModel; payloadIndex += 1) {
            for (const payloads of perModel) {
                const payload = payloads[payloadIndex];
                if (payload) pushUnique(payload);
            }
        }
    }

    // multi relay 14：双模型 + 用户规格字段变体 + 降档后全图仍在。
    // 单图 relay 14：双模型用户规格（约 6）+ 降档 + 去字段/最小 body 兜底不被 slice 裁掉。
    const limit = imageInputs.length > 1 ? (relay ? 14 : 16) : relay ? 14 : 10;
    return candidates.slice(0, limit);
}

/**
 * Grok 模型候选：
 * - 用户当前选择永远第一（界面选 video 就不会先打 1.5）
 * - 1.5 / i2v 仅作渠道列表内的可选兜底，绝不插队
 * - 不硬塞列表里不存在的模型名（避免 model_not_found）
 * knownModels 来自当前渠道 models[]（拉取模型后的列表）。
 */
function grokModelCandidates(modelName: string, imageCount: number, baseUrl = "", knownModels: string[] = []) {
    const known = Array.from(
        new Set(
            knownModels
                .map((m) => modelOptionName(m).trim())
                .filter(Boolean),
        ),
    );
    const knownLower = new Map(known.map((m) => [m.toLowerCase(), m] as const));
    const resolveKnown = (name: string) => knownLower.get(name.toLowerCase()) || "";
    const pickKnown = (predicate: (n: string) => boolean) => known.find((m) => predicate(m.toLowerCase())) || "";

    const lower = modelName.toLowerCase();
    const relay = isCodex2apiBaseUrl(baseUrl);
    const models: string[] = [];

    const push = (name: string) => {
        const n = (name || "").trim();
        if (!n) return;
        if (!models.some((x) => x.toLowerCase() === n.toLowerCase())) models.push(n);
    };

    const isI2vSpecial = (n: string) => n.includes("1.5") || n.includes("i2v") || n.includes("image-to-video");
    const isGrokVideoLike = (n: string) => n.includes("grok") && (n.includes("video") || n.includes("imagine")) && !n.includes("image-quality") && !n.endsWith("-image");

    if (imageCount > 0) {
        // 1) 用户当前选择永远第一
        push(modelName);
        // 2) 同渠道其它基础 Grok 视频模型（不含 1.5/i2v）
        push(pickKnown((n) => isGrokVideoLike(n) && !isI2vSpecial(n)));
        // 3) 1.5 / i2v 仅作可选兜底（列表里有才加，绝不插到用户选择之前）
        push(pickKnown((n) => n.includes("grok") && n.includes("video") && isI2vSpecial(n)));
        // 4) 列表为空时才猜通用名；1.5 仅 relay 末位可选，仍不硬塞到第一
        if (!known.length) {
            push("grok-imagine-video");
            if (relay) push("grok-imagine-video-1.5");
        } else if (isI2vSpecial(lower)) {
            // 用户已选 1.5 时，基础 video 作失败回退
            push(resolveKnown("grok-imagine-video") || pickKnown((n) => n.includes("grok-imagine-video") && !isI2vSpecial(n)));
        }
    } else {
        // 文生视频：只用用户当前选择。中转 Invalid URL 时自动换 1.5 只会掩盖问题、制造误导请求。
        push(modelName);
        if (!known.length && !lower.includes("grok")) push("grok-imagine-video");
    }

    // 若 known 非空，过滤掉完全不在列表中的猜测名（保留用户当前选择即使列表暂未包含）
    if (known.length) {
        const filtered = models.filter((m) => m.toLowerCase() === lower || knownLower.has(m.toLowerCase()));
        if (filtered.length) return filtered;
    }
    return models.filter(Boolean);
}

function buildGrokReferencePrompt(prompt: string, imageCount: number) {
    if (imageCount <= 1) return prompt;
    if (/<IMAGE_\d+>|@Image\d+/i.test(prompt)) return prompt;
    const labels = Array.from({ length: imageCount }, (_, index) => `<IMAGE_${index + 1}>`).join("、");
    return `${prompt.trim()}\n\n请结合参考图 ${labels} 保持主体与风格一致。`;
}

async function resolveGrokImageInput(image: ReferenceImage, config?: AiConfig, imageCount = 1, prompt = ""): Promise<{ url: string }> {
    const url = await resolveGrokReferenceImageUrl(image, config, imageCount, prompt);
    return { url };
}

async function resolveGrokReferenceImageUrl(image: ReferenceImage, config?: AiConfig, imageCount = 1, prompt = "") {
    // codex2api / 多图 / 长提示词：过大 data URI 会 400，甚至网关直接 404 page not found
    const relay = Boolean(config && (isCodex2apiBaseUrl(config.baseUrl) || isLanAiBaseUrl(config.baseUrl)));
    const multi = imageCount > 1;
    const longPrompt = prompt.trim().length >= 900;
    // 中转单图默认就压紧一些；长提示词再收一档（不截断 prompt）
    let maxEdge = multi ? (relay ? 768 : 960) : relay ? 896 : 1280;
    let quality = multi ? (relay ? 0.68 : 0.74) : relay ? 0.72 : 0.8;
    // 多图总包体控制：单图约 70–90KB，2 张合计尽量 < 180KB
    let maxBytes = multi ? (relay ? 72 * 1024 : 96 * 1024) : relay ? 160 * 1024 : 360 * 1024;
    if (longPrompt) {
        maxEdge = multi ? (relay ? 640 : 768) : relay ? 720 : 960;
        quality = multi ? (relay ? 0.6 : 0.66) : relay ? 0.64 : 0.72;
        maxBytes = multi ? (relay ? 56 * 1024 : 72 * 1024) : relay ? 96 * 1024 : 180 * 1024;
    }

    // 1) 本地/blob 优先转压缩后的 data URI
    const binary = await resolveReferenceBinaryDataUrl(image);
    if (binary) return compressImageDataUrl(binary, maxEdge, quality, maxBytes);

    // 2) 已是 data URI
    const directUrl = (image.url || image.dataUrl || "").trim();
    if (directUrl.startsWith("data:")) return compressImageDataUrl(directUrl, maxEdge, quality, maxBytes);

    // 3) 公网 URL 直接透传（浏览器 CORS 读不了时，交给上游服务端拉取）
    if (isPublicMediaUrl(directUrl)) return directUrl;

    const fallback = await imageToDataUrl(image);
    if (fallback?.startsWith("data:")) return compressImageDataUrl(fallback, maxEdge, quality, maxBytes);
    if (fallback && isPublicMediaUrl(fallback)) return fallback;
    throw new Error("参考图读取失败，请改用本地上传的图片（远程 imgen.x.ai 图常因 CORS 无法在浏览器读取）");
}

async function resolveReferenceBinaryDataUrl(image: ReferenceImage) {
    const directUrl = (image.url || image.dataUrl || "").trim();
    if (directUrl.startsWith("data:")) return directUrl;
    if (image.storageKey || directUrl.startsWith("blob:")) {
        try {
            const dataUrl = await imageToDataUrl(image);
            return dataUrl.startsWith("data:") ? dataUrl : "";
        } catch {
            return "";
        }
    }
    // 远程 https 默认不在这里强转；CORS 失败很常见，留给调用方决定是否透传 URL。
    return "";
}

/**
 * Grok 分辨率候选顺序：始终用户选择优先，再**只降不升**。
 * - 选 1080p → [1080p, 720p, 480p]
 * - 选 720p  → [720p, 480p]（不会再试 1080）
 * - 选 480p  → [480p]（不会升到 720）
 * 不再在脆弱中转图生时静默把 1080p 改成先发 720p。
 * 降档仅在创建请求失败后发生；若中转“成功但实际低清”，靠结果分辨率校验提示。
 */
export function grokResolutionCandidates(resolution: string, imageCount: number, baseUrl = "") {
    void imageCount;
    void baseUrl;
    const primary = normalizeGrokResolution(resolution);
    if (primary === "1080p") return ["1080p", "720p", "480p"];
    if (primary === "480p") return ["480p"];
    return ["720p", "480p"];
}

function readPayloadResolution(payload: Record<string, unknown> | null | undefined) {
    if (!payload || typeof payload !== "object") return undefined;
    const raw = payload.resolution;
    if (typeof raw === "string" && raw.trim()) return normalizeGrokResolution(raw);
    return undefined;
}

function readFormDataResolution(body: FormData) {
    const raw = body.get("resolution");
    if (typeof raw === "string" && raw.trim()) return normalizeGrokResolution(raw);
    return undefined;
}

function openAiVideoSizeFromGrok(aspectRatio: string, resolution: string) {
    const height = resolution === "1080p" ? 1080 : resolution === "480p" ? 480 : 720;
    if (aspectRatio === "9:16") return height >= 1080 ? "1080x1920" : height <= 480 ? "480x854" : "720x1280";
    if (aspectRatio === "1:1") return height >= 1080 ? "1080x1080" : height <= 480 ? "480x480" : "720x720";
    // 16:9 及默认
    return height >= 1080 ? "1920x1080" : height <= 480 ? "854x480" : "1280x720";
}

function formatGrokCreateError(error: unknown, references: ReferenceImage[], attemptCount: number, createUrl = "") {
    const detail = readAxiosError(error, "Grok 视频任务创建失败");
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const requestUrl = createUrl || (axios.isAxiosError(error) ? String(error.config?.url || "") : "");
    const hasRemoteOnlyReference = references.some((image) => {
        const url = (image.url || image.dataUrl || "").trim();
        return isPublicMediaUrl(url) && !image.storageKey && !url.startsWith("data:") && !url.startsWith("blob:");
    });
    const hasLocalReference = references.some((image) => Boolean(image.storageKey) || (image.dataUrl || "").startsWith("blob:") || (image.dataUrl || "").startsWith("data:"));
    const multiReference = references.length > 1;
    const rateLimited = isGrokRateLimitError(error) || /rate.?limit|too many requests|限流|额度不足|quota/i.test(detail);
    const vagueUpstream = /upstream returned status 400|status 400|invalid_request_error/i.test(detail);
    const modelMissing = /model_not_found|模型不存在|unknown model/i.test(detail);
    const plain404 = /404 page not found|page not found/i.test(detail);
    const platformMismatch = isNewApiPlatformMismatchError(error) || /invalid api platform/i.test(detail);
    const pathMissing = ((status === 404 && !modelMissing) || isGrokCreatePathMissingError(error, { hasImages: references.length > 0 })) && !plain404 && !platformMismatch;
    const invalidUrl = isInvalidUrlGrokError(error);
    const newApiHint = /new_api|oneapi|x-new-api|invalid api platform/i.test(`${requestUrl} ${detail}`) || /192\.168\.\d+\.\d+:\d+/.test(requestUrl);
    const codexHint = /codex2api/i.test(requestUrl);
    const tips = [
        detail,
        requestUrl ? `请求地址：${requestUrl}` : "",
        attemptCount > 1 ? `已按多种创建路径/字段/模型组合重试 ${attemptCount} 次` : "",
        rateLimited
            ? "上游限流（rate_limit）：换字段/模型重试无效，请等待 1–3 分钟后再点一次生成，不要连续连点。此前多次失败重试会占用额度"
            : "",
        platformMismatch
            ? "New API「invalid api platform」= 模型绑定的渠道类型与请求路径不匹配（不是参考图字段问题）。本应用对内网 New API 的 Grok 只走 POST /v1/video/generations（跳过不存在的 /videos/generations），并避免在 /v1/videos 上反复刷 body。请在 New API 后台把 grok-imagine-video 配到支持 xAI/Grok 视频的渠道类型，且上游能处理 multi-reference generation；公网 codex2api 渠道请用 https://www.codex2api.com/v1 + /videos/generations"
            : "",
        multiReference && (plain404 || status === 400 || status === 404) && !platformMismatch && !rateLimited
            ? "多参考图生视频是 generation：公网 codex2api 用 /v1/videos/generations；内网 New API 只走 /v1/video/generations。常见失败：① data URI 过大 ② 模型未开通 multi-reference。本应用会压小本地参考图并只发完整多图字段"
            : "",
        invalidUrl || pathMissing
            ? "创建路径不被当前中转识别。双渠道约定：codex2api → /v1/videos/generations；内网 New API Grok → /v1/video/generations（不是 /videos/edits，也不试不存在的 /videos/generations）。Base URL 只写到主机或 /v1"
            : "",
        codexHint && multiReference
            ? "当前渠道为 codex2api：多图参考只打 /v1/videos/generations，不会回退到不存在的 /v1/videos，也不会误走 /videos/edits"
            : "",
        newApiHint && !platformMismatch
            ? "当前像 New API / 内网中转：Grok 只走 POST /v1/video/generations，OpenAI 视频模型才优先 /v1/videos"
            : "",
        multiReference
            ? `当前为 ${references.length} 张参考图：已只尝试真正的多图 generation 字段（reference_images / images / image_urls），不会静默改成只发第一张，也不会改走视频编辑接口`
            : "",
        multiReference && vagueUpstream && !rateLimited
            ? "若上游不支持多参考图，请减到 1 张本地小图，或换支持 multi-reference 的 Grok 视频模型/渠道"
            : "",
        modelMissing ? "模型名在上游不存在：请在渠道里「拉取模型」，选用列表中真实的视频模型；请求以你当前选择为先，1.5/i2v 仅作渠道内可选兜底，不会硬塞不存在的名字" : "",
        hasRemoteOnlyReference ? "当前参考图是远程地址（如 imgen.x.ai）。请改用本地上传的小图" : "",
        hasLocalReference && vagueUpstream && !multiReference && !invalidUrl && !platformMismatch && !rateLimited
            ? "本地参考图仍 400：长提示词会自动压小参考图并改试更精简字段（不截断提示词）；仍失败请换更小 jpg/png、分辨率 720p，或略缩短提示词；确认渠道模型列表含可用的 grok 视频模型"
            : "",
        vagueUpstream && !hasLocalReference && !hasRemoteOnlyReference && !invalidUrl && !platformMismatch && !rateLimited
            ? "纯文生 400：请确认模型在渠道列表中、时长 5–10 秒、分辨率 720p；套餐需开通该视频模型"
            : "",
        vagueUpstream && !invalidUrl && !platformMismatch && !rateLimited
            ? "中转只返回笼统 400 时：公网测 POST /v1/videos/generations；内网 New API 测 POST /v1/video/generations；多图在同一路径加 reference_images"
            : "",
    ].filter(Boolean);
    return tips.join("。");
}

/**
 * 多图 payload 是否携带全部参考图（用于单测，避免再引入「只发首图」回退）。
 * 单图 payload 或无图 payload 返回 true。
 */
export function payloadKeepsAllGrokVideoReferences(payload: Record<string, unknown>, expectedCount: number) {
    if (expectedCount <= 1) return true;
    const arrays = [payload.reference_images, payload.images, payload.image_urls, payload.image].filter(Array.isArray) as unknown[][];
    if (!arrays.length) return false;
    return arrays.every((items) => items.length === expectedCount);
}

async function resolveReferenceDataUrl(image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("data:")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    return dataUrl;
}

function agnesApiUrl(config: AiConfig, path: string) {
    const normalizedBaseUrl = normalizeAgnesBaseUrl(config.baseUrl);
    return `${normalizedBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizeAgnesBaseUrl(baseUrl: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    if (isAiProxyBaseUrl(normalizedBaseUrl)) return AI_PROXY_BASE_URL;
    if (isAgnesBaseUrl(normalizedBaseUrl)) return normalizedBaseUrl.replace(/\/v1$/i, "");
    return normalizedBaseUrl;
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    return dataUrl;
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("参考视频必须是公网 URL、素材 ID，或本地已保存的视频");
    return blobToDataUrl(blob);
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("参考音频必须是公网 URL、素材 ID，或本地已保存的音频");
    return blobToDataUrl(blob);
}

async function videoResultFromUrl(url: string, options?: RequestOptions, config?: AiConfig, waitUntilReady = false): Promise<VideoGenerationResult> {
    // 落盘优先走代理/内网中继；内网 content 必须带 Key 拉成 blob，不能只回 127.0.0.1 给 <video>。
    const originalUrl = unwrapMediaProxyUrl(url) || url;
    if (waitUntilReady) {
        try {
            const probeUrl = rewritePrivateVideoUrlToLanRelay(originalUrl, config) || originalUrl;
            if (!isBrowserCorsBlockedVideoHost(probeUrl) && !isPrivateOrLoopbackHost(safeHostname(probeUrl))) {
                await assertRemoteVideoReady(probeUrl, options);
            }
            // 就绪后仍走下载逻辑拿 blob
        } catch {
            throw new VideoOutputNotReadyError();
        }
    }

    const candidates = videoDownloadCandidates(originalUrl, config);
    for (const candidate of candidates) {
        try {
            const blob = await downloadVideoBlob(candidate, options, config);
            return { blob: ensureVideoBlob(blob), mimeType: "video/mp4" };
        } catch (error) {
            if (axios.isCancel(error) || options?.signal?.aborted) throw error;
            // try next candidate
        }
    }
    // 私网地址下载失败：不要回退 127.0.0.1（浏览器必 REFUSED）
    if (isPrivateOrLoopbackHost(safeHostname(originalUrl))) {
        throw new Error("无法从内网视频地址下载文件（需 /lan-ai + API Key）。请检查内网中继与 Key");
    }
    // 公网：仍返回原始远端 URL，避免把必 502 的 /ai-proxy/media 写进播放器
    return { url: originalUrl, mimeType: "video/mp4" };
}

async function downloadVideoBlob(url: string, options?: RequestOptions, config?: AiConfig) {
    // 同源 /lan-ai、/ai-proxy/media：可带鉴权。跨域 CDN 不要乱加 Authorization。
    if (url.startsWith("/") || url.includes("/ai-proxy/media") || url.includes("/lan-ai")) {
        const headers: Record<string, string> = {};
        const isLan = url.includes("/lan-ai") || url.startsWith(LAN_AI_BASE_URL);
        if (isLan && config?.apiKey?.trim()) {
            headers.Authorization = `Bearer ${config.apiKey.trim()}`;
        }
        const response = await fetch(url, {
            signal: options?.signal,
            headers,
            credentials: url.includes("token=") ? "include" : "same-origin",
        });
        if (!response.ok) throw new Error(`下载视频失败（${response.status}）`);
        const blob = await response.blob();
        await assertVideoBlob(blob);
        if (!blob.size) throw new Error("视频内容为空");
        return blob;
    }
    // 已知 CORS 封锁主机：浏览器 JS 永远读不到，避免无意义的 axios 报错刷屏
    if (isBrowserCorsBlockedVideoHost(url)) {
        throw new Error("远程视频禁止浏览器直读（CORS）");
    }
    // 私网绝对地址：不要让浏览器直连 127.0.0.1（页面在 3011 时必失败）
    if (isPrivateOrLoopbackHost(safeHostname(url))) {
        const lan = rewritePrivateVideoUrlToLanRelay(url, config);
        if (!lan) throw new Error("内网视频地址无法在浏览器直连");
        return downloadVideoBlob(lan, options, config);
    }
    const response = await axios.get<Blob>(url, { responseType: "blob", timeout: 120000, signal: options?.signal });
    await assertVideoBlob(response.data);
    if (!response.data.size) throw new Error("视频内容为空");
    return response.data;
}

function ensureVideoBlob(blob: Blob, mimeType = "video/mp4") {
    if (blob.type && blob.type.startsWith("video/")) return blob;
    return blob.slice(0, blob.size, mimeType || "video/mp4");
}

async function assertRemoteVideoReady(url: string, options?: RequestOptions) {
    const response = await axios.get<Blob>(url, { responseType: "blob", headers: { Range: "bytes=0-1048575" }, timeout: 30000, signal: options?.signal });
    await assertVideoBlob(response.data);
}

function videoDownloadCandidates(url: string, config?: AiConfig) {
    const list: string[] = [];
    const lanUrl = rewritePrivateVideoUrlToLanRelay(url, config);
    // 0) 内网/环回视频地址：优先同源 /lan-ai（需 LAN_AI_UPSTREAM）
    if (lanUrl) list.push(lanUrl);
    // 1) 当前渠道若是 ai-proxy，优先带 token 的媒体代理
    const channelProxy = mediaProxyUrl(url, config);
    if (channelProxy) list.push(channelProxy);
    // 2) 对 xAI 等 CORS 封锁 CDN：即使生成走中转站，也尝试同源 /ai-proxy/media 取字节（静默失败）
    //    这样本地可落盘 storageKey，云端上云才能成功。
    const sameOriginProxy = sameOriginMediaProxyUrl(url);
    if (sameOriginProxy && !list.includes(sameOriginProxy)) list.push(sameOriginProxy);
    // 3) 非封锁主机才尝试浏览器直连
    if (isPublicMediaUrl(url) && !isBrowserCorsBlockedVideoHost(url) && !list.includes(url)) list.push(url);
    if (!list.length && isPublicMediaUrl(url)) list.push(url);
    return list;
}

function mediaProxyCandidates(url: string, config?: AiConfig) {
    const list: string[] = [];
    const channelProxy = mediaProxyUrl(url, config);
    if (channelProxy) list.push(channelProxy);
    const sameOriginProxy = sameOriginMediaProxyUrl(url);
    if (sameOriginProxy && !list.includes(sameOriginProxy)) list.push(sameOriginProxy);
    return list;
}

function mediaProxyUrl(url: string, config?: AiConfig) {
    if (!isPublicMediaUrl(url)) return "";
    // 渠道级代理：仅当当前请求渠道本身是 /ai-proxy
    if (!config || !isAiProxyBaseUrl(config.baseUrl)) return "";
    const params = new URLSearchParams({ url });
    if (config.apiKey.trim()) params.set("token", config.apiKey.trim());
    return `${AI_PROXY_BASE_URL}/media?${params.toString()}`;
}

/** 不依赖当前 AI 渠道：对已知 CORS 封锁 CDN 尝试同源媒体代理（Docker 里 ai-proxy 能出网时最有用） */
function sameOriginMediaProxyUrl(url: string) {
    if (!isPublicMediaUrl(url) || !isBrowserCorsBlockedVideoHost(url)) return "";
    return `${AI_PROXY_BASE_URL}/media?${new URLSearchParams({ url }).toString()}`;
}

/** 若传入已是 /ai-proxy/media?url=...，还原出原始远端媒体地址 */
function unwrapMediaProxyUrl(url: string) {
    if (!url) return "";
    try {
        const parsed = url.startsWith("http") ? new URL(url) : new URL(url, "http://local.invalid");
        if (!parsed.pathname.includes("/ai-proxy/media") && !parsed.pathname.endsWith("/media")) return "";
        return parsed.searchParams.get("url") || "";
    } catch {
        return "";
    }
}

function isBrowserCorsBlockedVideoHost(url: string) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return (
            host === "vidgen.x.ai" ||
            host.endsWith(".vidgen.x.ai") ||
            host === "imgen.x.ai" ||
            host.endsWith(".imgen.x.ai") ||
            host === "cdn.x.ai" ||
            host.endsWith(".cdn.x.ai")
        );
    } catch {
        return /vidgen\.x\.ai|imgen\.x\.ai|cdn\.x\.ai/i.test(url);
    }
}

class VideoOutputNotReadyError extends Error {
    constructor() {
        super("视频文件还在准备中");
        this.name = "VideoOutputNotReadyError";
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim() && !isSameOriginRelayBaseUrl(config.baseUrl)) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持视频生成，请使用 OpenAI 格式渠道");
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

type UnwrapVideoOptions = {
    /** 轮询响应常不回 id，允许用 fallbackId */
    allowMissingId?: boolean;
    fallbackId?: string;
};

function unwrapVideoResponse(payload: ApiVideoResponse, options?: UnwrapVideoOptions): VideoResponse {
    if (!payload) throw new Error("接口没有返回视频任务");

    // 对齐可用脚本 veo-sora：响应可能是
    // {id} / {code,data:{id}} / {data:{data:{id,status,video_url}}}
    // 关键：外层只有 id/request_id，status/video_url 在 data 里 —— 必须合并嵌套字段，
    // 否则轮询会一直 pending 直到超时。
    // 只给 OpenAI/Sora/Veo 用；Seedance/Agnes/Grok 各自有解析器
    const layers: Record<string, unknown>[] = [];
    let node: unknown = payload;
    for (let depth = 0; depth < 6; depth += 1) {
        if (!node || typeof node !== "object" || Array.isArray(node)) break;
        const record = node as Record<string, unknown>;
        layers.push(record);

        if ("code" in record && record.code !== undefined) {
            const code = String(record.code).toLowerCase();
            if (code !== "0" && code !== "200" && code !== "ok" && code !== "success" && code !== "null" && code !== "") {
                // 有的轮询用 code 表示业务失败；排队/处理中文案不要当失败
                const errText = readErrorPayload(record);
                if (errText && !/success|ok|pending|processing|running|queued|queue|in[_ ]?progress|waiting|生成中|排队|处理中/i.test(errText)) {
                    throw new Error(errText || "视频任务创建失败");
                }
            }
        }

        const nested =
            (record.data && typeof record.data === "object" && !Array.isArray(record.data) && record.data) ||
            (record.result && typeof record.result === "object" && !Array.isArray(record.result) && record.result) ||
            (record.task && typeof record.task === "object" && !Array.isArray(record.task) && record.task) ||
            (record.response && typeof record.response === "object" && !Array.isArray(record.response) && record.response) ||
            (record.payload && typeof record.payload === "object" && !Array.isArray(record.payload) && record.payload) ||
            null;
        if (nested) {
            node = nested;
            continue;
        }
        break;
    }

    if (!layers.length) throw new Error("接口没有返回视频任务");

    // 从外到内合并：内层 status/url 覆盖外层；id 取第一个非空
    const merged: Record<string, unknown> = {};
    for (const layer of layers) {
        for (const [key, value] of Object.entries(layer)) {
            if (value === undefined || value === null || value === "") continue;
            // 不把外层空壳 data 盖住内层已展开字段
            if (key === "data" || key === "result" || key === "task" || key === "response" || key === "payload") continue;
            merged[key] = value;
        }
    }

    const id =
        pickOpenAiVideoTaskId(merged) ||
        layers.map((layer) => pickOpenAiVideoTaskId(layer)).find(Boolean) ||
        (options?.fallbackId || "").trim() ||
        "";
    if (!id) {
        // 创建必须有 id；轮询可仅有 status/url
        const hasPollSignal = Boolean(pickOpenAiVideoStatus(merged) || pickOpenAiVideoUrlFromRecord(merged));
        if (!(options?.allowMissingId && hasPollSignal)) {
            throw new Error("视频接口没有返回任务 ID");
        }
    }
    return normalizeOpenAiVideoResponse(merged, id || options?.fallbackId || "unknown");
}

/** 单测：嵌套 envelope / 无 id 轮询体解包 */
export function unwrapOpenAiVideoResponseForTest(payload: unknown, options?: UnwrapVideoOptions): VideoResponse {
    return unwrapVideoResponse(payload as ApiVideoResponse, options);
}

function pickOpenAiVideoTaskId(record: Record<string, unknown>): string {
    for (const key of ["id", "task_id", "request_id", "video_id", "job_id", "taskId", "requestId"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
}

function pickOpenAiVideoStatus(record: Record<string, unknown>): string | undefined {
    for (const key of ["status", "state", "task_status", "taskStatus", "video_status", "phase", "job_status", "jobStatus"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) {
            // 少数中转：1 成功 0 排队 2 失败；也有 100 表示进度完成
            if (value === 1 || value === 100) return "completed";
            if (value === 2 || value === -1 || value === 3) return "failed";
            if (value === 0) return "pending";
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const nested = value as Record<string, unknown>;
            for (const nestedKey of ["status", "state", "name", "value", "label"]) {
                const nestedValue = nested[nestedKey];
                if (typeof nestedValue === "string" && nestedValue.trim()) return nestedValue.trim();
            }
        }
    }
    // progress 字段：100 → completed
    const progress = record.progress ?? record.percent ?? record.percentage;
    if (typeof progress === "number" && progress >= 100) return "completed";
    if (typeof progress === "string" && /^\d+(\.\d+)?%?$/.test(progress.trim())) {
        const num = Number(progress.replace("%", ""));
        if (Number.isFinite(num) && num >= 100) return "completed";
    }
    return undefined;
}

function pickOpenAiVideoUrlFromRecord(record: Record<string, unknown>): string {
    const directKeys = ["video_url", "result_url", "output_url", "download_url", "url", "video", "output", "file_url", "mp4_url"];
    for (const key of directKeys) {
        const value = record[key];
        if (typeof value === "string" && (isPublicMediaUrl(value) || /\.mp4(\?|#|$)/i.test(value) || value.startsWith("blob:"))) {
            return value;
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const nested = value as Record<string, unknown>;
            for (const nestedKey of directKeys) {
                const nestedValue = nested[nestedKey];
                if (typeof nestedValue === "string" && (isPublicMediaUrl(nestedValue) || /\.mp4(\?|#|$)/i.test(nestedValue))) {
                    return nestedValue;
                }
            }
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === "string" && (isPublicMediaUrl(item) || /\.mp4(\?|#|$)/i.test(item))) return item;
                if (item && typeof item === "object") {
                    const nested = item as Record<string, unknown>;
                    for (const nestedKey of directKeys) {
                        const nestedValue = nested[nestedKey];
                        if (typeof nestedValue === "string" && (isPublicMediaUrl(nestedValue) || /\.mp4(\?|#|$)/i.test(nestedValue))) {
                            return nestedValue;
                        }
                    }
                }
            }
        }
    }
    if (record.content && typeof record.content === "object") {
        const content = record.content as Record<string, unknown>;
        for (const key of ["video_url", "url", "download_url", "result_url"]) {
            const value = content[key];
            if (typeof value === "string" && (isPublicMediaUrl(value) || /\.mp4(\?|#|$)/i.test(value))) return value;
        }
    }
    return "";
}

function normalizeOpenAiVideoResponse(record: Record<string, unknown>, id: string): VideoResponse {
    const status = pickOpenAiVideoStatus(record);
    const pickedUrl = pickOpenAiVideoUrlFromRecord(record);
    // message 在排队时常是 "ok"/"success"，不能当 error；仅明确失败词才收
    const messageLooksFailed = typeof record.message === "string" && /fail|error|invalid|cancel|拒绝|失败/i.test(record.message) && !/success|ok|pending|processing|queued|running/i.test(record.message);
    const error =
        record.error && typeof record.error === "object"
            ? (record.error as { message?: string })
            : typeof record.error === "string"
              ? { message: record.error }
              : messageLooksFailed
                ? { message: String(record.message) }
                : undefined;
    const content =
        record.content && typeof record.content === "object"
            ? (record.content as { video_url?: string; url?: string })
            : null;
    const progressRaw = record.progress ?? record.percent ?? record.percentage;
    const progress = typeof progressRaw === "number" ? progressRaw : typeof progressRaw === "string" ? Number(String(progressRaw).replace("%", "")) : undefined;
    return {
        id,
        status,
        error,
        url: typeof record.url === "string" ? record.url : pickedUrl || undefined,
        result_url: typeof record.result_url === "string" ? record.result_url : undefined,
        video_url: typeof record.video_url === "string" ? record.video_url : pickedUrl || undefined,
        content,
        ...(typeof progress === "number" && Number.isFinite(progress) ? { progress } : {}),
    } as VideoResponse;
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, "Seedance 接口没有返回任务");
}

function unwrapAgnesTask(payload: ApiAgnesResponse) {
    if (!payload) throw new Error("Agnes 接口没有返回任务");
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (String(payload.code) !== "0") throw new Error(payload.msg || payload.message || "Agnes 请求失败");
        if (!payload.data) throw new Error("Agnes 接口没有返回任务");
        return payload.data;
    }
    return payload as AgnesTaskResponse;
}

export function unwrapGrokVideoResponse(payload: ApiGrokVideoResponse): GrokVideoResponse {
    if (!payload) throw new Error("Grok 视频接口没有返回任务");
    const root = payload as Record<string, unknown>;

    // 中转常见包一层：{ code, data } / { data: { request_id, video } } / { result: {...} }
    if (typeof root.code !== "undefined") {
        if (String(root.code) !== "0" && String(root.code) !== "200" && String(root.code).toLowerCase() !== "ok" && String(root.code).toLowerCase() !== "success") {
            throw new Error(String(root.msg || root.message || "Grok 视频请求失败"));
        }
    }

    // HTTP 200 + OpenAI 风格 error（codex2api 常把 xAI 400 包成 200）：无任务 id 时当作创建失败，便于换 body 重试
    const embeddedError = readGrokEmbeddedCreateError(root);
    if (embeddedError) throw new Error(embeddedError);

    const nested =
        (root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : null) ||
        (root.result && typeof root.result === "object" ? (root.result as Record<string, unknown>) : null) ||
        (root.response && typeof root.response === "object" ? (root.response as Record<string, unknown>) : null);

    if (nested) {
        const nestedError = readGrokEmbeddedCreateError(nested);
        if (nestedError) throw new Error(nestedError);
    }

    const candidate = (nested || root) as GrokVideoResponse;
    // 再展开一层 data/result，兼容双重包装
    if (candidate && typeof candidate === "object") {
        const deeper = (candidate as Record<string, unknown>).data || (candidate as Record<string, unknown>).result;
        if (deeper && typeof deeper === "object" && (readGrokVideoUrl(deeper as GrokVideoResponse) || (deeper as GrokVideoResponse).request_id || (deeper as GrokVideoResponse).id || (deeper as GrokVideoResponse).status)) {
            return deeper as GrokVideoResponse;
        }
    }
    return candidate;
}

/** 仅在「没有任务 id / 视频 URL」时把 body 内 error 视为创建失败（轮询失败任务常带 id+error，不能当创建错误抛）。 */
function readGrokEmbeddedCreateError(root: Record<string, unknown>): string {
    if (readGrokTaskId(root) || readGrokVideoUrl(root as GrokVideoResponse)) return "";
    const status = String(root.status || "").toLowerCase();
    if (status && !["error", "failed", "failure"].includes(status)) return "";

    if (typeof root.error === "string" && root.error.trim()) return root.error.trim();
    if (root.error && typeof root.error === "object") {
        const nested = root.error as Record<string, unknown>;
        const msg = String(nested.message || nested.msg || "").trim();
        if (msg) return msg;
    }
    // 部分中转：{ type: "invalid_request_error", message: "..." } 顶层
    const type = String(root.type || "").toLowerCase();
    if (type.includes("invalid_request") || type.includes("error")) {
        const msg = String(root.message || root.msg || "").trim();
        if (msg) return msg;
    }
    return "";
}

function readAgnesError(payload: AgnesTaskResponse) {
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.message || payload.message || payload.msg || "";
}

/**
 * 从 Grok 创建/轮询响应里抠可播放 URL。
 * 官方完成态常见：`{ status:"done", progress:100, video:{ url, duration, respect_moderation } }`
 * 注意：status=done 时 video.url 可能仍是空串，调用方需 grace 等待。
 */
export function readGrokVideoUrl(payload: GrokVideoResponse | Record<string, unknown> | null | undefined) {
    if (!payload || typeof payload !== "object") return "";
    const record = payload as Record<string, unknown>;

    // 官方嵌套优先：video.url / video.video_url（避免被其它同名 url 干扰）
    const nestedVideo = record.video;
    if (typeof nestedVideo === "string") {
        const direct = coercePlayableMediaUrl(nestedVideo);
        if (direct) return direct;
    } else if (nestedVideo && typeof nestedVideo === "object" && !Array.isArray(nestedVideo)) {
        const videoRecord = nestedVideo as Record<string, unknown>;
        for (const key of ["url", "video_url", "videoUrl", "download_url", "output_url", "result_url", "signed_url", "file_url", "play_url", "playUrl", "mp4", "uri"]) {
            const direct = coercePlayableMediaUrl(videoRecord[key]);
            if (direct) return direct;
        }
    }

    return (
        coercePlayableMediaUrl(record.video_url) ||
        coercePlayableMediaUrl(record.url) ||
        coercePlayableMediaUrl(record.output_url) ||
        coercePlayableMediaUrl(record.download_url) ||
        coercePlayableMediaUrl(record.result_url) ||
        coercePlayableMediaUrl(record.videoUrl) ||
        coercePlayableMediaUrl(record.video_uri) ||
        coercePlayableMediaUrl(record.uri) ||
        coercePlayableMediaUrl(record.signed_url) ||
        coercePlayableMediaUrl(record.file_url) ||
        readGrokUnknownUrl(record.data) ||
        readGrokUnknownUrl(record.content) ||
        readGrokUnknownUrl(record.response) ||
        readGrokUnknownUrl(record.result) ||
        readGrokUnknownUrl(Array.isArray(record.videos) ? record.videos[0] : undefined) ||
        readGrokUnknownUrl(record.output) ||
        readGrokUnknownUrl(record.outputs) ||
        readGrokUnknownUrl(record.choices) ||
        findFirstVideoUrl(payload) ||
        ""
    );
}

function asHttpUrl(value: unknown): string {
    if (typeof value !== "string") return "";
    const text = value.trim();
    if (!text) return "";
    if (/^https?:\/\//i.test(text)) return text;
    // 少数中转返回协议相对地址
    if (text.startsWith("//") && text.includes(".")) return `https:${text}`;
    return "";
}

/** 比 asHttpUrl 更宽松：接受常见 CDN 无扩展名链接；仍拒绝空串与明显非媒体路径 */
function coercePlayableMediaUrl(value: unknown): string {
    if (typeof value !== "string") return "";
    const text = value.trim();
    if (!text) return "";
    const direct = asHttpUrl(text);
    if (!direct) return "";
    if (isLikelyVideoUrl(direct) || isLooseMediaUrl(direct)) return direct;
    return "";
}

function readGrokUnknownUrl(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") return coercePlayableMediaUrl(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            const url = readGrokUnknownUrl(item);
            if (url) return url;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    for (const key of ["video_url", "videoUrl", "url", "output_url", "download_url", "result_url", "signed_url", "file_url", "media_url", "uri", "video_uri", "href", "src", "mp4", "play_url", "playUrl"]) {
        const direct = coercePlayableMediaUrl(record[key]);
        if (direct) return direct;
        const nested = record[key];
        if (nested && typeof nested === "object") {
            const url = readGrokUnknownUrl(nested);
            if (url) return url;
        }
    }
    for (const key of ["video", "videos", "data", "result", "response", "output", "outputs", "content", "file", "asset", "media", "message", "choices"]) {
        const url = readGrokUnknownUrl(record[key]);
        if (url) return url;
    }
    return "";
}

function findFirstVideoUrl(value: unknown, depth = 0): string {
    if (!value || depth > 8) return "";
    if (typeof value === "string") {
        const direct = asHttpUrl(value);
        if (!direct) return "";
        return isLikelyVideoUrl(direct) || isLooseMediaUrl(direct) ? direct : "";
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const url = findFirstVideoUrl(item, depth + 1);
            if (url) return url;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    for (const item of Object.values(value as Record<string, unknown>)) {
        const url = findFirstVideoUrl(item, depth + 1);
        if (url) return url;
    }
    return "";
}

function isLikelyVideoUrl(value: string) {
    const text = value.trim();
    if (!/^https?:\/\//i.test(text)) return false;
    if (/\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(text)) return true;
    if (/vidgen|video|x\.ai|cdn\.x\.ai|imgen\.x\.ai|cloudfront|blob\.core|amazonaws|oss-|cos\./i.test(text)) return true;
    return false;
}

/** 完成态嵌套对象里的 https 链接，放宽识别（中转 CDN 路径常无 video 关键字） */
function isLooseMediaUrl(value: string) {
    const text = value.trim();
    if (!/^https?:\/\//i.test(text)) return false;
    if (/\.(json|js|css|html?)(?:[?#]|$)/i.test(text)) return false;
    if (/\/(auth|login|docs|pricing)(?:\/|$)/i.test(text)) return false;
    return true;
}

function readGrokError(payload: GrokVideoResponse) {
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.message || payload.message || payload.msg || "";
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readErrorPayload(payload) || "请求失败");
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

/** OpenAI / Seedance 兼容：从任务响应里尽量抠可播 URL（不碰 Grok 专用解析） */
function openAiCompatibleVideoUrl(payload: VideoResponse | SeedanceTask) {
    const candidates = [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url];
    const hit = candidates.find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url) || url.startsWith("blob:")));
    if (hit) return hit;
    // 兜底：整包再扫一遍（兼容 normalize 漏掉的别名字段）
    if (payload && typeof payload === "object") {
        return pickOpenAiVideoUrlFromRecord(payload as unknown as Record<string, unknown>);
    }
    return "";
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError(error)) {
        const responseData = error.response?.data as unknown;
        const detail = readErrorPayload(responseData);
        const status = error.response?.status;
        // 保留 422 原文（含 Supported models），便于 Sora 模型别名诊断
        if (detail) {
            if (status && status >= 400 && !/\(status=\d+\)/i.test(detail)) return `${detail} (status=${status})`;
            return detail;
        }
        if (!error.response) return readNetworkError(error.code, fallback);
        return statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? error.message : fallback;
}

function readErrorPayload(payload: unknown): string {
    if (!payload) return "";
    if (typeof payload === "string") {
        const text = payload.trim();
        if (!text) return "";
        try {
            return readErrorPayload(JSON.parse(text));
        } catch {
            return text.slice(0, 300);
        }
    }
    if (typeof payload !== "object") return "";
    const record = payload as Record<string, unknown>;
    if (typeof record.msg === "string" && record.msg.trim()) return record.msg.trim();
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    if (record.error && typeof record.error === "object") {
        const nested = record.error as Record<string, unknown>;
        if (typeof nested.message === "string" && nested.message.trim()) return nested.message.trim();
        if (typeof nested.msg === "string" && nested.msg.trim()) return nested.msg.trim();
    }
    if (typeof record.detail === "string" && record.detail.trim()) return record.detail.trim();
    try {
        return JSON.stringify(record).slice(0, 300);
    } catch {
        return "";
    }
}

function isInvalidUrlGrokError(error: unknown) {
    if (!axios.isAxiosError(error)) return /invalid url/i.test(String((error as Error)?.message || error || ""));
    const data = error.response?.data as { error?: { message?: string; code?: string }; msg?: string; message?: string } | undefined;
    const blob = `${data?.error?.message || ""} ${data?.error?.code || ""} ${data?.msg || ""} ${data?.message || ""} ${error.message || ""}`;
    return /invalid url/i.test(blob);
}

/** 上游/中转限流：换 body 只会刷额度，必须立刻停。 */
export function isGrokRateLimitError(error: unknown) {
    if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) return true;
        const data = error.response?.data as { error?: { message?: string; type?: string; code?: string }; msg?: string; message?: string } | undefined;
        const blob = `${data?.error?.message || ""} ${data?.error?.type || ""} ${data?.error?.code || ""} ${data?.msg || ""} ${data?.message || ""} ${error.message || ""}`;
        if (/rate.?limit|too many requests|限流|quota exceeded|额度不足/i.test(blob)) return true;
    }
    const message = String((error as Error)?.message || error || "");
    return /rate.?limit|too many requests|限流|quota exceeded|额度不足/i.test(message);
}

export function isRetryableGrokPayloadError(error: unknown) {
    // 中转上游地址坏掉时，换 model/duration/字段都没用，继续重试只会刷屏并误切到 1.5
    if (isInvalidUrlGrokError(error)) return false;
    // New API 渠道类型不匹配：换 body/模型候选无意义，必须换路径或改后台渠道类型
    if (isNewApiPlatformMismatchError(error)) return false;
    // 限流：立刻停，禁止继续刷多种 body
    if (isGrokRateLimitError(error)) return false;

    if (!axios.isAxiosError(error)) {
        // HTTP 200 + {error:...} 经 unwrap 抛出的普通 Error，仍应换 body 重试
        const message = String((error as Error)?.message || error || "");
        return /upstream returned status 400|invalid_request_error|status 400|没有返回 request_id|没有返回任务|bad request|invalid request/i.test(message);
    }

    const status = error.response?.status;
    if (status === 400 || status === 422) {
        // 400 里若是 platform 文案，上面已拦截；其余可换字段
        return true;
    }
    const data = error.response?.data as { error?: { code?: string; message?: string }; msg?: string; reason?: string } | undefined;
    const blob = `${data?.error?.code || ""} ${data?.error?.message || ""} ${data?.msg || ""} ${data?.reason || ""} ${error.message || ""}`.toLowerCase();
    // 仅「模型不存在」类 404 值得换候选模型；路径 404 换 body 重试只会刷屏
    if (status === 404) {
        return blob.includes("model_not_found") || blob.includes("模型不存在") || blob.includes("unknown model") || blob.includes("no such model");
    }
    // HTTP 200 但 axios 拦截器/调用方已转成错误对象时
    if (!status || status === 200) {
        if (/upstream returned status 400|invalid_request_error|status 400|bad request|invalid request/.test(blob)) return true;
    }
    return blob.includes("model_not_found") || blob.includes("模型不存在") || blob.includes("unknown model");
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 400) return `${fallback}（400），请检查视频模型、尺寸/时长参数和参考素材是否被当前渠道支持`;
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 404) return `${fallback}（404），当前渠道可能不支持该视频接口路径或所选模型，请确认视频模型与 Base URL 匹配`;
    if (status === 429) return "请求被限流或额度不足，请稍后重试；Agnes Video 建议通过服务器代理串行提交，避免浏览器重复点击或多个任务并发";
    return status ? `${fallback}（${status}）` : fallback;
}

function readNetworkError(code: string | undefined, fallback: string) {
    if (code === "ECONNABORTED" || code === "ETIMEDOUT") return `${fallback}：连接超时，请检查中转站网络或稍后重试`;
    if (code === "ERR_NETWORK" || code === "ECONNRESET") return `${fallback}：连接被中断（常见于错误轮询路径或中转站瞬时断连），请重试`;
    return `${fallback}：无法连接中转站，请确认 Base URL 可从浏览器访问`;
}

async function requestWithRateLimitRetry<T>(request: () => Promise<T>, signal?: AbortSignal) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return await request();
        } catch (error) {
            if (axios.isCancel(error) || signal?.aborted || !isRateLimitError(error) || attempt === 2) throw error;
            lastError = error;
            await delay((attempt + 1) * 3000, signal);
        }
    }
    throw lastError;
}

function isRateLimitError(error: unknown) {
    return axios.isAxiosError(error) && error.response?.status === 429;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number | string; msg?: string; message?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number | string; msg?: string; message?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (payload.code !== undefined && payload.code !== 0 && payload.code !== "0") throw new Error(readErrorPayload(payload) || "视频下载失败");
    if (payload.error?.message) throw new Error(readErrorPayload(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取本地素材失败"));
        reader.readAsDataURL(blob);
    });
}
