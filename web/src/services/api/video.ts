import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { AGNES_VIDEO_HEIGHT, AGNES_VIDEO_WIDTH, agnesFrameCount, agnesVideoRequestError, isAgnesBaseUrl, isAgnesVideoConfig, normalizeAgnesDuration } from "@/lib/agnes-video";
import { isGrokVideoConfig, normalizeGrokAspectRatio, normalizeGrokDuration, normalizeGrokResolution } from "@/lib/grok-video";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { AI_PROXY_BASE_URL, buildApiUrl, isAiProxyBaseUrl, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; status?: string; error?: { message?: string } };
type ApiVideoResponse = VideoResponse | { code?: number; data?: VideoResponse | null; msg?: string };
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
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; last_frame_url?: string } | null;
};
type ApiEnvelope<T> = T | { code?: number; data?: T | null; msg?: string };
type RequestOptions = { signal?: AbortSignal };

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "agnes" | "grok"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

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

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
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
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "agnes") return pollAgnesTask(requestConfig, task, options);
    if (task.provider === "seedance") return pollSeedanceTask(requestConfig, task, options);
    if (task.provider === "grok") return pollGrokTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
    throw new Error("视频接口没有返回可播放的视频");
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
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: video.error?.message || "视频生成失败" };
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
            const created = unwrapGrokVideoResponse((await axios.post<ApiGrokVideoResponse>(grokCreateApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
            const id = created.request_id || created.id;
            if (!id) throw new Error("Grok 视频接口没有返回 request_id");
            return { id, provider: "grok", model };
        } catch (error) {
            lastError = error;
            // 只在字段兼容候选之间切换；鉴权/限流/404 等直接结束。
            if (!isRetryableGrokPayloadError(error)) break;
        }
    }

    // codex2api 等中转常见：有 /videos/generations，但没有 OpenAI /videos。
    // 对 Grok 路径不再回退 /videos，避免连续 400 后再多一次 404 噪音。
    throw new Error(formatGrokCreateError(lastError, references, payloads.length));
}

async function pollGrokTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapGrokVideoResponse((await axios.get<ApiGrokVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const status = String(state.status || "").toLowerCase();
        const url = readGrokVideoUrl(state);
        const completed = status === "done" || status === "completed" || status === "succeeded";
        if (completed && url) return { status: "completed", result: await videoResultFromUrl(url, options, config) };
        if (completed) return { status: "failed", error: "Grok 任务完成但没有返回视频 URL，请在浏览器 Network 中查看 /v1/videos/{id} 响应体并发我" };
        if (url && !["pending", "queued", "running", "processing"].includes(status)) return { status: "completed", result: await videoResultFromUrl(url, options, config) };
        if (["failed", "fail", "error", "expired", "cancelled", "canceled"].includes(status)) return { status: "failed", error: readGrokError(state) || "Grok 视频生成失败" };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "Grok 视频任务查询失败"));
    }
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
        if (state.status === "succeeded") {
            const url = state.content?.video_url;
            if (!url) return { status: "failed", error: "Seedance 任务成功但没有返回视频 URL" };
            return { status: "completed", result: await videoResultFromUrl(url, options) };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: state.error?.message || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}` };
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
    const imageInputs = await Promise.all(references.slice(0, 7).map(resolveGrokImageInput));

    const basePayload: Record<string, unknown> = {
        model: modelName,
        prompt,
        duration,
        aspect_ratio: aspectRatio,
        resolution,
    };
    if (!imageInputs.length) {
        // 部分中转同时认 seconds
        return [basePayload, { ...basePayload, seconds: String(duration) }];
    }

    const candidates: Array<Record<string, unknown>> = [];
    const pushUnique = (payload: Record<string, unknown>) => {
        const key = JSON.stringify(payload);
        if (candidates.some((item) => JSON.stringify(item) === key)) return;
        candidates.push(payload);
    };

    // 控制候选数量：先最小官方字段，再补 duration/比例；避免 5 次 400 刷屏。
    if (imageInputs.length === 1) {
        // 最小 image-to-video（很多中转对 resolution/aspect_ratio 更挑）
        pushUnique({ model: modelName, prompt, image: imageInputs[0] });
        pushUnique({ model: modelName, prompt, duration, image: imageInputs[0] });
        pushUnique({ ...basePayload, image: imageInputs[0] });
    } else {
        const labeledPrompt = buildGrokReferencePrompt(prompt, imageInputs.length);
        pushUnique({ model: modelName, prompt: labeledPrompt, reference_images: imageInputs });
        pushUnique({ model: modelName, prompt: labeledPrompt, duration, reference_images: imageInputs });
        pushUnique({ ...basePayload, prompt: labeledPrompt, reference_images: imageInputs });
    }

    return candidates;
}

function buildGrokReferencePrompt(prompt: string, imageCount: number) {
    if (imageCount <= 1) return prompt;
    if (/<IMAGE_\d+>|@Image\d+/i.test(prompt)) return prompt;
    const labels = Array.from({ length: imageCount }, (_, index) => `<IMAGE_${index + 1}>`).join("、");
    return `${prompt.trim()}\n\n请结合参考图 ${labels} 保持主体与风格一致。`;
}

async function resolveGrokImageInput(image: ReferenceImage): Promise<{ url: string }> {
    const url = await resolveGrokReferenceImageUrl(image);
    return { url };
}

async function resolveGrokReferenceImageUrl(image: ReferenceImage) {
    // 1) 本地/blob 优先转 data URI，让中转站不依赖外网拉 imgen.x.ai
    const binary = await resolveReferenceBinaryDataUrl(image);
    if (binary) return binary;

    // 2) 已是 data URI
    const directUrl = (image.url || image.dataUrl || "").trim();
    if (directUrl.startsWith("data:")) return directUrl;

    // 3) 公网 URL 直接透传（浏览器 CORS 读不了时，交给上游服务端拉取）
    if (isPublicMediaUrl(directUrl)) return directUrl;

    const fallback = await imageToDataUrl(image);
    if (fallback && (fallback.startsWith("data:") || isPublicMediaUrl(fallback))) return fallback;
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
    const tips = [
        detail,
        attemptCount > 1 ? `已尝试 ${attemptCount} 种请求格式` : "",
        hasRemoteOnlyReference ? "当前参考图是远程地址（如 imgen.x.ai）。若中转站无法访问该地址，请改用本地上传的参考图" : "",
        "请打开 Network 查看 /v1/videos/generations 的 Response 原文；若仍失败，把 Response JSON（可打码 Key）发我",
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
    const playableUrl = mediaProxyUrl(url, config) || url;
    if (waitUntilReady) {
        try {
            await assertRemoteVideoReady(playableUrl, options);
            return { url: playableUrl, mimeType: "video/mp4" };
        } catch {
            throw new VideoOutputNotReadyError();
        }
    }

    try {
        const response = await axios.get<Blob>(playableUrl, { responseType: "blob", timeout: 45000, signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url: playableUrl, mimeType: "video/mp4" };
    }
}

async function assertRemoteVideoReady(url: string, options?: RequestOptions) {
    const response = await axios.get<Blob>(url, { responseType: "blob", headers: { Range: "bytes=0-1048575" }, timeout: 30000, signal: options?.signal });
    await assertVideoBlob(response.data);
}

function mediaProxyUrl(url: string, config?: AiConfig) {
    if (!config || !isAiProxyBaseUrl(config.baseUrl)) return "";
    const params = new URLSearchParams({ url });
    if (config.apiKey.trim()) params.set("token", config.apiKey.trim());
    return `${AI_PROXY_BASE_URL}/media?${params.toString()}`;
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
    if (!config.apiKey.trim() && !isAiProxyBaseUrl(config.baseUrl)) throw new Error("请先配置 API Key");
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
    const envelope = payload as { code?: number | string; data?: GrokVideoResponse | null; msg?: string; message?: string };
    if (typeof payload === "object" && "code" in payload && envelope.code !== undefined) {
        if (String(envelope.code) !== "0") throw new Error(envelope.msg || envelope.message || "Grok 视频请求失败");
        if (!envelope.data) throw new Error("Grok 视频接口没有返回任务");
        return envelope.data;
    }
    return payload as GrokVideoResponse;
}

function readAgnesError(payload: AgnesTaskResponse) {
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.message || payload.message || payload.msg || "";
}

function readGrokVideoUrl(payload: GrokVideoResponse) {
    return (
        payload.video_url ||
        payload.url ||
        payload.output_url ||
        payload.download_url ||
        payload.result_url ||
        readGrokUnknownUrl(payload.video) ||
        readGrokUnknownUrl(payload.data) ||
        readGrokUnknownUrl(payload.content) ||
        readGrokUnknownUrl(payload.response) ||
        readGrokUnknownUrl(payload.result) ||
        readGrokUnknownUrl(payload.videos?.[0]) ||
        readGrokUnknownUrl(payload.response?.videos?.[0]) ||
        readGrokUnknownUrl(payload.result?.videos?.[0]) ||
        readGrokUnknownUrl(payload.output) ||
        findFirstVideoUrl(payload) ||
        ""
    );
}

function readGrokUnknownUrl(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") return isLikelyVideoUrl(value) ? value : "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const url = readGrokUnknownUrl(item);
            if (url) return url;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    for (const key of ["video_url", "url", "output_url", "download_url", "result_url", "signed_url", "file_url", "media_url", "href", "src"]) {
        const url = readGrokUnknownUrl(record[key]);
        if (url) return url;
    }
    for (const key of ["video", "videos", "data", "result", "response", "output", "content", "file", "asset", "media"]) {
        const url = readGrokUnknownUrl(record[key]);
        if (url) return url;
    }
    return "";
}

function findFirstVideoUrl(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") return isLikelyVideoUrl(value) ? value : "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const url = findFirstVideoUrl(item);
            if (url) return url;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    for (const item of Object.values(value as Record<string, unknown>)) {
        const url = findFirstVideoUrl(item);
        if (url) return url;
    }
    return "";
}

function isLikelyVideoUrl(value: string) {
    return /^https?:\/\//i.test(value) && (/\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(value) || value.includes("vidgen") || value.includes("video"));
}

function readGrokError(payload: GrokVideoResponse) {
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.message || payload.message || payload.msg || "";
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && typeof payload.code === "number") {
        if (payload.code !== 0) throw new Error(payload.msg || "请求失败");
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError(error)) {
        const responseData = error.response?.data as unknown;
        const detail = readErrorPayload(responseData);
        if (detail) return detail;
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
    return status === 400 || status === 422;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 400) return `${fallback}（400），请检查视频模型、尺寸/时长参数和参考素材是否被当前渠道支持`;
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 404) return `${fallback}（404），当前渠道可能不支持该视频接口路径或所选模型，请确认视频模型与 Base URL 匹配`;
    if (status === 429) return "请求被限流或额度不足，请稍后重试；Agnes Video 建议通过服务器代理串行提交，避免浏览器重复点击或多个任务并发";
    return status ? `${fallback}（${status}）` : fallback;
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
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "视频下载失败");
    if (payload.error?.message) throw new Error(payload.error.message);
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
