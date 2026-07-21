import axios from "axios";
import { nanoid } from "nanoid";

import { compressImageDataUrl, dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { AGNES_VIDEO_HEIGHT, AGNES_VIDEO_WIDTH, agnesFrameCount, agnesVideoRequestError, isAgnesBaseUrl, isAgnesVideoConfig, normalizeAgnesDuration } from "@/lib/agnes-video";
import { isCodex2apiBaseUrl, isGrokVideoConfig, normalizeGrokAspectRatio, normalizeGrokDuration, normalizeGrokResolution } from "@/lib/grok-video";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
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
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "agnes" | "grok" | "script"; model: string; readyResult?: VideoGenerationResult };
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

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    const delayMs = task.provider === "seedance" || task.provider === "agnes" || task.provider === "grok" ? 5000 : 2500;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === 119) throw new Error(`${task.provider === "seedance" ? "Seedance " : task.provider === "agnes" ? "Agnes " : ""}视频生成超时，请稍后重试`);
        await delay(delayMs, options?.signal);
    }
    throw new Error("视频生成超时，请稍后重试");
}

/**
 * 有参考图时：在同渠道视频模型列表中自动选用更适合 I2V 的 Grok 模型（不硬塞不存在的 1.5）。
 */
export function resolveVideoModelForReferences(config: AiConfig, selectedModelValue: string): { modelValue: string; switched: boolean; from: string; to: string } {
    const selected = (selectedModelValue || config.videoModel || config.model || "").trim();
    const channel = resolveModelChannel(config, selected);
    const fromName = modelOptionName(selected);
    const fromLower = fromName.toLowerCase();
    const isGrok =
        isGrokVideoConfig({ ...config, model: selected, videoModel: selected, baseUrl: channel.baseUrl }) ||
        (fromLower.includes("grok") && (fromLower.includes("video") || fromLower.includes("imagine")));
    if (!isGrok) return { modelValue: selected, switched: false, from: fromName, to: fromName };

    const raw = (channel.models || []).map((m) => modelOptionName(m).trim()).filter(Boolean);
    const pick = (pred: (n: string) => boolean) => raw.find((m) => pred(m.toLowerCase())) || "";
    // 已是明确视频模型则保留
    if (fromLower.includes("video") || fromLower.includes("imagine-video")) {
        return { modelValue: selected, switched: false, from: fromName, to: fromName };
    }
    const preferred =
        pick((n) => n.includes("grok") && n.includes("video") && (n.includes("1.5") || n.includes("i2v"))) ||
        pick((n) => n.includes("grok") && n.includes("video")) ||
        pick((n) => n.includes("grok") && n.includes("imagine") && !n.includes("image-quality"));
    if (!preferred || preferred.toLowerCase() === fromLower) {
        return { modelValue: selected, switched: false, from: fromName, to: fromName };
    }
    return { modelValue: encodeChannelModel(channel.id, preferred), switched: true, from: fromName, to: preferred };
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    let selectedModel = (config.model || config.videoModel).trim();
    // 有参考图：自动偏向渠道列表内真实存在的 Grok 视频模型
    if (references.length) {
        const auto = resolveVideoModelForReferences(config, selectedModel);
        if (auto.switched) selectedModel = auto.modelValue;
    }
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
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
    if (videoReferences.length || audioReferences.length) {
        throw new Error("当前视频接口不支持参考视频或参考音频，请切换到 Seedance 2.0 / 火山 Agent Plan 模型，或移除参考素材");
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
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
            },
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
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
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
    files.forEach((file) => body.append("input_reference", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务创建失败"));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        // 部分中转在 status 未完成或没有 /content 时直接返回可播 URL
        const directUrl = openAiCompatibleVideoUrl(video);
        if (directUrl) return { status: "completed", result: await videoResultFromUrl(directUrl, options, config) };
        if (video.status === "completed") {
            try {
                // 优先走渠道 Base（/lan-ai）+ Authorization 拉 content，避免返回 127.0.0.1 给浏览器
                const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal, timeout: 120000 });
                await assertVideoBlob(content.data);
                return { status: "completed", result: { blob: content.data } };
            } catch (contentError) {
                // /content 不存在时，再尝试从任务体里抠 URL（内网 URL 会再经 /lan-ai + Key 下载）
                const fallbackUrl = openAiCompatibleVideoUrl(video);
                if (fallbackUrl) return { status: "completed", result: await videoResultFromUrl(fallbackUrl, options, config) };
                // 任务已完成但 content 暂不可用时，用任务 id 拼 content 路径再试一次（同源渠道）
                if (isSameOriginRelayBaseUrl(config.baseUrl) || task.id) {
                    try {
                        const contentUrl = aiApiUrl(config, `/videos/${task.id}/content`);
                        const content = await axios.get<Blob>(contentUrl, { headers: aiHeaders(config), responseType: "blob", signal: options?.signal, timeout: 120000 });
                        await assertVideoBlob(content.data);
                        return { status: "completed", result: { blob: content.data } };
                    } catch {
                        // fall through
                    }
                }
                throw contentError;
            }
        }
        if (video.status === "failed" || video.status === "cancelled") {
            return { status: "failed", error: readErrorPayload(video.error?.message) || readErrorPayload(video) || "视频生成失败" };
        }
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务查询失败"));
    }
}

async function createGrokTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const payloads = await buildGrokPayloadCandidates(config, model, prompt, references);
    let lastError: unknown;
    for (const payload of payloads) {
        try {
            // 中转站图生视频可能较慢，创建超时放宽，尽量等同步结果
            const created = unwrapGrokVideoResponse(
                (
                    await axios.post<ApiGrokVideoResponse>(grokCreateApiUrl(config), payload, {
                        headers: aiHeaders(config, "application/json"),
                        timeout: 180000,
                        signal: options?.signal,
                    })
                ).data,
            );
            const id = created.request_id || created.id || "grok-inline";
            const ready = extractGrokReadyResult(created);
            if (ready) {
                return {
                    id,
                    provider: "grok",
                    model: String(payload.model || model),
                    readyResult: await videoResultFromUrl(ready, options, config),
                };
            }
            if (!created.request_id && !created.id) throw new Error("Grok 视频接口没有返回 request_id");
            // 新任务清掉该 host 的“不支持查询”缓存，避免上次 404 影响本次
            grokPollHostState.delete(hostKeyOf(config));
            grokPollMissCount.delete(pollMissKey(config, id));
            return { id, provider: "grok", model: String(payload.model || model) };
        } catch (error) {
            lastError = error;
            // 只在字段兼容候选之间切换；鉴权/限流等直接结束。
            if (!isRetryableGrokPayloadError(error)) break;
        }
    }

    throw new Error(formatGrokCreateError(lastError, references, payloads.length));
}

// host 探测：ok=查询可用；missing=确认不支持。任务级 404 先累计，不立刻判死。
const grokPollHostState = new Map<string, "ok" | "missing">();
const grokPollMissCount = new Map<string, number>();
const GROK_POLL_NOT_FOUND_GRACE = 18; // 约 18*5s ≈ 90s，给中转站任务落库时间

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

// 中转有时 status=done 但 video URL 晚几拍才写入；先宽容等待再失败
const grokDoneWithoutUrlCount = new Map<string, number>();
const GROK_DONE_WITHOUT_URL_GRACE = 12; // ~12*5s

async function pollGrokTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        // 官方：POST /videos/generations + GET /videos/{request_id}
        // 见 https://docs.x.ai/docs/guides/video-generation
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
            const keys = summarizeGrokPayloadKeys(raw);
            return {
                status: "failed",
                error: `Grok 任务显示已完成，但响应里没有可播放的视频地址。查询响应顶层字段：${keys || "（空）"}。请打开 Network 里 GET …/videos/…（不是 POST generations）的「响应」JSON 发我`,
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

async function fetchGrokTaskState(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions) {
    const hostKey = hostKeyOf(config);
    if (grokPollHostState.get(hostKey) === "missing") {
        throw new Error(formatGrokPollUnsupportedError(config));
    }

    // 官方路径优先；codex2api 等中转可能用 generations 前缀或 query
    const id = encodeURIComponent(task.id);
    const paths = [
        `/videos/${id}`,
        `/videos/generations/${id}`,
        `/video/generations/${id}`,
        `/videos/generations?request_id=${id}`,
        `/videos?request_id=${id}`,
        `/videos/generations?id=${id}`,
    ];
    let sawNotFound = false;
    let lastError: unknown;

    for (const path of paths) {
        try {
            const response = await axios.get<ApiGrokVideoResponse>(aiApiUrl(config, path), {
                headers: aiHeaders(config),
                timeout: 60000,
                signal: options?.signal,
            });
            grokPollHostState.set(hostKey, "ok");
            grokPollMissCount.delete(pollMissKey(config, task.id));
            return response.data;
        } catch (error) {
            if (axios.isCancel(error) || options?.signal?.aborted) throw error;
            lastError = error;
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            if (status === 404 || status === 405) {
                sawNotFound = true;
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
                    grokPollHostState.set(hostKey, "ok");
                    grokPollMissCount.delete(pollMissKey(config, task.id));
                    return response.data;
                } catch (retryError) {
                    lastError = retryError;
                    const retryStatus = axios.isAxiosError(retryError) ? retryError.response?.status : undefined;
                    if (retryStatus === 404 || retryStatus === 405) {
                        sawNotFound = true;
                        continue;
                    }
                }
            }
        }
    }

    if (sawNotFound) {
        const key = pollMissKey(config, task.id);
        const misses = (grokPollMissCount.get(key) || 0) + 1;
        grokPollMissCount.set(key, misses);
        // 前几次 404：任务可能还没落库，继续 pending
        if (misses < GROK_POLL_NOT_FOUND_GRACE) {
            throw new GrokPollNotReadyError("Grok 任务查询暂不可用，继续等待");
        }
        // 长时间一直 404：判定中转站未实现查询接口
        grokPollHostState.set(hostKey, "missing");
        throw new Error(formatGrokPollUnsupportedError(config));
    }

    throw lastError instanceof Error ? lastError : new Error("Grok 视频任务查询失败");
}

async function tryFetchGrokVideoContent(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult | null> {
    const id = encodeURIComponent(task.id);
    const paths = [`/videos/${id}/content`, `/videos/generations/${id}/content`, `/videos/${id}/download`];
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

function formatGrokPollUnsupportedError(config: AiConfig) {
    return [
        "当前中转站长时间无法查询 Grok 视频状态",
        "官方路径是 GET /v1/videos/{request_id}",
        `你的 Base URL：${config.baseUrl.trim() || "（空）"}`,
        "若 POST /v1/videos/generations 能创建但查询持续 404/405，需要中转站补齐查询接口",
        "参考图生视频请确认创建请求使用本地小图，并优先模型 grok-imagine-video-1.5",
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

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
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

function grokCreateApiUrl(config: AiConfig) {
    return aiApiUrl(config, "/videos/generations");
}

async function buildGrokPayloadCandidates(config: AiConfig, model: string, prompt: string, references: ReferenceImage[]) {
    const modelName = modelOptionName(model);
    const duration = normalizeGrokDuration(config.videoSeconds);
    const aspectRatio = normalizeGrokAspectRatio(config.size);
    const resolution = normalizeGrokResolution(config.vquality);
    // codex2api 等中转对 1080p / 过大 data URI 更敏感：候选里主动降到 720p 再试
    const resolutions = Array.from(new Set([resolution, "720p", "480p"].filter(Boolean)));
    const imageInputs = await Promise.all(references.slice(0, 7).map((image) => resolveGrokImageInput(image, config)));
    // 用当前渠道已拉取的模型列表约束候选，避免硬塞上游不存在的 grok-imagine-video-1.5
    const channel = resolveModelChannel(config, model);
    const models = grokModelCandidates(modelName, imageInputs.length, config.baseUrl, channel.models || []);
    const relay = isCodex2apiBaseUrl(config.baseUrl) || isLanAiBaseUrl(config.baseUrl);

    const candidates: Array<Record<string, unknown>> = [];
    const pushUnique = (payload: Record<string, unknown>) => {
        const key = JSON.stringify(payload);
        if (candidates.some((item) => JSON.stringify(item) === key)) return;
        candidates.push(payload);
    };

    if (!imageInputs.length) {
        for (const nextModel of models) {
            // 文生视频：中转优先「官方最小字段」，再补全 aspect/resolution，最后 seconds 兼容
            // 文档：https://docs.x.ai/docs/guides/video-generation
            pushUnique({ model: nextModel, prompt, duration });
            for (const nextResolution of resolutions) {
                pushUnique({ model: nextModel, prompt, duration, aspect_ratio: aspectRatio, resolution: nextResolution });
            }
            pushUnique({ model: nextModel, prompt, duration, aspect_ratio: aspectRatio });
            if (relay) {
                pushUnique({ model: nextModel, prompt, seconds: duration, aspect_ratio: aspectRatio, resolution: "720p" });
            } else {
                pushUnique({ model: nextModel, prompt, seconds: String(duration), aspect_ratio: aspectRatio, resolution });
            }
        }
        return candidates.slice(0, relay ? 8 : 6);
    }

    // 图生视频 / 参考生视频
    // 官方：单图 image:{url}；多图 reference_images。中转站常还需兼容 images / image_url。
    // 勿混用 image + reference_images。
    if (imageInputs.length === 1) {
        const image = imageInputs[0];
        for (const nextModel of models) {
            // 最小成功面：image 对象 + duration（codex2api 最稳）
            pushUnique({ model: nextModel, prompt, image, duration });
            for (const nextResolution of resolutions) {
                pushUnique({ model: nextModel, prompt, image, duration, aspect_ratio: aspectRatio, resolution: nextResolution });
            }
            pushUnique({ model: nextModel, prompt, image, duration, aspect_ratio: aspectRatio });
            // 部分中转只认扁平字段
            pushUnique({ model: nextModel, prompt, image: image.url, duration });
            pushUnique({ model: nextModel, prompt, image_url: image.url, duration });
            if (!relay) pushUnique({ model: nextModel, prompt, images: [image.url], duration });
        }
    } else {
        const labeledPrompt = buildGrokReferencePrompt(prompt, imageInputs.length);
        const urls = imageInputs.map((item) => item.url);
        const multiDuration = Math.min(duration, 10);
        for (const nextModel of models) {
            // 多图：官方 reference_images 对象数组优先
            pushUnique({ model: nextModel, prompt: labeledPrompt, reference_images: imageInputs, duration: multiDuration });
            pushUnique({ model: nextModel, prompt: labeledPrompt, reference_images: imageInputs, duration: multiDuration, aspect_ratio: aspectRatio });
            pushUnique({ model: nextModel, prompt: labeledPrompt, reference_images: urls, duration: multiDuration });
            // 中转退化：只取首图走 I2V，比整组 reference 更容易过
            pushUnique({ model: nextModel, prompt, image: imageInputs[0], duration: multiDuration });
            if (!relay) pushUnique({ model: nextModel, prompt: labeledPrompt, images: urls, duration: multiDuration });
        }
    }

    return candidates.slice(0, relay ? 10 : 6);
}

/**
 * Grok 模型候选：优先用渠道列表里真实存在的名字，避免硬塞 grok-imagine-video-1.5 导致 model_not_found。
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

    if (imageCount > 0) {
        // 图生视频：同渠道内自动选更合适的 I2V 模型（不必用户手动切换）
        // 1) 列表里带 1.5 / i2v / image-to-video 的
        push(pickKnown((n) => n.includes("grok") && n.includes("video") && (n.includes("1.5") || n.includes("i2v") || n.includes("image-to-video"))));
        // 2) 任意 grok*video / grok*imagine（非纯 image 文生图模型）
        push(pickKnown((n) => n.includes("grok") && (n.includes("video") || n.includes("imagine")) && !n.includes("image-quality") && !n.endsWith("-image")));
        // 3) 用户当前选择
        push(modelName);
        // 4) 仅当列表为空或用户已选 1.5 时，才尝试通用名（避免 Grok2API 上硬塞不存在的 1.5）
        if (!known.length) {
            push("grok-imagine-video");
            if (relay) push("grok-imagine-video-1.5");
        } else if (lower.includes("1.5")) {
            push(resolveKnown("grok-imagine-video") || pickKnown((n) => n.includes("grok-imagine-video") && !n.includes("1.5")));
        }
    } else {
        // 文生视频：用户选择优先，再回退列表里的基础名
        push(modelName);
        push(pickKnown((n) => n.includes("grok") && n.includes("video") && !n.includes("1.5")));
        push(resolveKnown("grok-imagine-video"));
        // 列表完全没有时再猜官方名；1.5 仅作可选回退且须在列表中
        if (!known.length) push("grok-imagine-video");
        push(resolveKnown("grok-imagine-video-1.5"));
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

async function resolveGrokImageInput(image: ReferenceImage, config?: AiConfig): Promise<{ url: string }> {
    const url = await resolveGrokReferenceImageUrl(image, config);
    return { url };
}

async function resolveGrokReferenceImageUrl(image: ReferenceImage, config?: AiConfig) {
    // codex2api / 内网中转：过大 data URI 极易 400，本地图压到更小
    const maxEdge = config && (isCodex2apiBaseUrl(config.baseUrl) || isLanAiBaseUrl(config.baseUrl)) ? 1024 : 1280;
    // 1) 本地/blob 优先转压缩后的 data URI
    const binary = await resolveReferenceBinaryDataUrl(image);
    if (binary) return compressImageDataUrl(binary, maxEdge, 0.78);

    // 2) 已是 data URI
    const directUrl = (image.url || image.dataUrl || "").trim();
    if (directUrl.startsWith("data:")) return compressImageDataUrl(directUrl, maxEdge, 0.78);

    // 3) 公网 URL 直接透传（浏览器 CORS 读不了时，交给上游服务端拉取）
    if (isPublicMediaUrl(directUrl)) return directUrl;

    const fallback = await imageToDataUrl(image);
    if (fallback?.startsWith("data:")) return compressImageDataUrl(fallback, maxEdge, 0.78);
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

function formatGrokCreateError(error: unknown, references: ReferenceImage[], attemptCount: number) {
    const detail = readAxiosError(error, "Grok 视频任务创建失败");
    const hasRemoteOnlyReference = references.some((image) => {
        const url = (image.url || image.dataUrl || "").trim();
        return isPublicMediaUrl(url) && !image.storageKey && !url.startsWith("data:") && !url.startsWith("blob:");
    });
    const hasLocalReference = references.some((image) => Boolean(image.storageKey) || (image.dataUrl || "").startsWith("blob:") || (image.dataUrl || "").startsWith("data:"));
    const vagueUpstream = /upstream returned status 400|status 400|invalid_request_error/i.test(detail);
    const modelMissing = /model_not_found|模型不存在|unknown model/i.test(detail);
    const tips = [
        detail,
        attemptCount > 1 ? `已按多种字段/模型组合重试 ${attemptCount} 次` : "",
        modelMissing ? "模型名在上游不存在：请在渠道里「拉取模型」，选用列表中真实的视频模型；图生视频会自动优先用渠道内已有模型，不再硬塞 grok-imagine-video-1.5" : "",
        hasRemoteOnlyReference ? "当前参考图是远程地址（如 imgen.x.ai）。请改用本地上传的小图" : "",
        hasLocalReference && vagueUpstream ? "本地参考图仍 400：请换更小 jpg/png，分辨率先选 720p；确认渠道模型列表含可用的 grok 视频模型" : "",
        vagueUpstream && !hasLocalReference && !hasRemoteOnlyReference
            ? "纯文生 400：请确认模型在渠道列表中、时长 5–10 秒、分辨率 720p；套餐需开通该视频模型"
            : "",
        vagueUpstream ? "中转只返回笼统 400 时，可在其控制台用同一 Key 测最小 body：{model,prompt,duration:8}" : "",
    ].filter(Boolean);
    return tips.join("。");
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

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, "接口没有返回视频任务");
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

function unwrapGrokVideoResponse(payload: ApiGrokVideoResponse): GrokVideoResponse {
    if (!payload) throw new Error("Grok 视频接口没有返回任务");
    const root = payload as Record<string, unknown>;

    // 中转常见包一层：{ code, data } / { data: { request_id, video } } / { result: {...} }
    if (typeof root.code !== "undefined") {
        if (String(root.code) !== "0" && String(root.code) !== "200" && String(root.code).toLowerCase() !== "ok" && String(root.code).toLowerCase() !== "success") {
            throw new Error(String(root.msg || root.message || "Grok 视频请求失败"));
        }
    }

    const nested =
        (root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : null) ||
        (root.result && typeof root.result === "object" ? (root.result as Record<string, unknown>) : null) ||
        (root.response && typeof root.response === "object" ? (root.response as Record<string, unknown>) : null);

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

function readAgnesError(payload: AgnesTaskResponse) {
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.message || payload.message || payload.msg || "";
}

function readGrokVideoUrl(payload: GrokVideoResponse) {
    const record = payload as Record<string, unknown>;
    return (
        asHttpUrl(payload.video_url) ||
        asHttpUrl(payload.url) ||
        asHttpUrl(payload.output_url) ||
        asHttpUrl(payload.download_url) ||
        asHttpUrl(payload.result_url) ||
        asHttpUrl(record.videoUrl) ||
        asHttpUrl(record.video_uri) ||
        asHttpUrl(record.uri) ||
        asHttpUrl(record.signed_url) ||
        asHttpUrl(record.file_url) ||
        readGrokUnknownUrl(payload.video) ||
        readGrokUnknownUrl(payload.data) ||
        readGrokUnknownUrl(payload.content) ||
        readGrokUnknownUrl(payload.response) ||
        readGrokUnknownUrl(payload.result) ||
        readGrokUnknownUrl(payload.videos?.[0]) ||
        readGrokUnknownUrl(payload.response?.videos?.[0]) ||
        readGrokUnknownUrl(payload.result?.videos?.[0]) ||
        readGrokUnknownUrl(payload.output) ||
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

function readGrokUnknownUrl(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") return isLikelyVideoUrl(value) ? value : asHttpUrl(value) && isLooseMediaUrl(value) ? value.trim() : "";
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
        const raw = record[key];
        if (typeof raw === "string") {
            const direct = asHttpUrl(raw);
            if (direct && (isLikelyVideoUrl(direct) || isLooseMediaUrl(direct))) return direct;
        }
        const url = readGrokUnknownUrl(raw);
        if (url) return url;
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
    return candidates.find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url))) || "";
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError(error)) {
        const responseData = error.response?.data as unknown;
        const detail = readErrorPayload(responseData);
        if (detail) return detail;
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

function isRetryableGrokPayloadError(error: unknown) {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    if (status === 400 || status === 422) return true;
    // 部分网关：不存在的模型名返回 404 / model_not_found，应换候选模型继续试
    if (status === 404) return true;
    const data = error.response?.data as { error?: { code?: string; message?: string }; msg?: string; reason?: string } | undefined;
    const blob = `${data?.error?.code || ""} ${data?.error?.message || ""} ${data?.msg || ""} ${data?.reason || ""}`.toLowerCase();
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
