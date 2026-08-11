import axios from "axios";

import { audioMimeType, isMiniMaxAudioModel, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeMiniMaxAudioFormatValue, normalizeMiniMaxAudioVoiceValue, normalizeOpenAiAudioVoiceValue } from "@/lib/audio-generation";
import { inferGrokTtsLanguage, normalizeGrokVoiceId, resolveAudioHostProfile, usesNativeGrokVoiceApi } from "@/lib/audio-host-profile";
import { resolveGrokModelProfile } from "@/lib/grok-model-profile";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { runModelPlugin } from "@/services/api/model-plugin";
import { buildApiUrl, isSameOriginRelayBaseUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";

type RequestOptions = { signal?: AbortSignal };
type MiniMaxT2AResponse = {
    data?: { audio?: string; status?: number };
    base_resp?: { status_code?: number; status_msg?: string };
    msg?: string;
    message?: string;
};

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    return {
        ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        "Content-Type": "application/json",
    };
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    const profile = resolveGrokModelProfile(model);
    if (profile && profile.task !== "tts") {
        throw new Error("当前模型不是语音合成模型；请选择 TTS 模型或使用音频节点的转文字功能");
    }
    const format = normalizeAudioFormatValue(config.audioFormat);
    const script = resolveModelScript(config, config.model || config.audioModel);
    if (script) {
        if (!model) throw new Error("请先配置音频模型");
        if (!requestConfig.baseUrl.trim()) throw new Error("请先配置 Base URL");
        if (!requestConfig.apiKey.trim() && !isSameOriginRelayBaseUrl(requestConfig.baseUrl)) throw new Error("请先配置 API Key");
        try {
            const result = await runModelPlugin({
                capability: "audio",
                script,
                config: requestConfig,
                prompt,
                params: {
                    voice: normalizeOpenAiAudioVoiceValue(config.audioVoice),
                    format,
                    speed: normalizeAudioSpeedValue(config.audioSpeed),
                    instructions: config.audioInstructions.trim(),
                },
                signal: options?.signal,
            });
            return await audioPluginBlob(result, format);
        } catch (error) {
            throw new Error(readAxiosError(error, "音频生成失败"));
        }
    }
    assertAudioConfig(requestConfig, model);
    if (isMiniMaxAudioModel(requestConfig.baseUrl, model)) return requestMiniMaxAudioGeneration(requestConfig, prompt, options);
    if (usesNativeGrokVoiceApi(requestConfig.baseUrl, model, "tts")) return requestNativeGrokTts(requestConfig, prompt, options);
    return requestOpenAiAudioGeneration(requestConfig, prompt, options);
}

async function audioPluginBlob(result: unknown, format: string): Promise<Blob> {
    if (result instanceof Blob) return result.type.startsWith("audio/") ? result : new Blob([result], { type: audioMimeType(format) });
    let source = "";
    if (typeof result === "string") source = result;
    else if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        source = typeof record.b64_json === "string" ? record.b64_json : typeof record.data === "string" ? record.data : typeof record.url === "string" ? record.url : "";
    }
    if (!source) throw new Error("模型调用脚本没有返回音频");
    const url = source.startsWith("data:") || /^https?:/i.test(source) ? source : `data:${audioMimeType(format)};base64,${source}`;
    const blob = await (await fetch(url)).blob();
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
}

async function requestNativeGrokTts(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const endpoint = resolveAudioHostProfile(config.baseUrl).ttsPath;
    try {
        const response = await axios.post<Blob>(
            aiApiUrl(config, endpoint),
            {
                text: prompt,
                language: inferGrokTtsLanguage(prompt),
                voice_id: normalizeGrokVoiceId(config.audioVoice),
            },
            { headers: { ...aiHeaders(config), Accept: "audio/*, application/json" }, responseType: "blob", signal: options?.signal },
        );
        await assertAudioBlob(response.data);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: "audio/mpeg" });
    } catch (error) {
        throw new Error(readAxiosError(error, "Grok 音频生成失败", endpoint));
    }
}

async function requestOpenAiAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const format = normalizeAudioFormatValue(config.audioFormat);
    const instructions = config.audioInstructions.trim();

    try {
        const response = await axios.post<Blob>(
            aiApiUrl(config, "/audio/speech"),
            {
                model: config.model.trim(),
                input: prompt,
                voice: normalizeOpenAiAudioVoiceValue(config.audioVoice),
                response_format: format,
                speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
                ...(instructions ? { instructions } : {}),
            },
            { headers: aiHeaders(config), responseType: "blob", signal: options?.signal },
        );
        await assertAudioBlob(response.data);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
    } catch (error) {
        throw new Error(readAxiosError(error, "音频生成失败", "/audio/speech"));
    }
}

async function requestMiniMaxAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const format = normalizeMiniMaxAudioFormatValue(config.audioFormat);
    const speed = Number(normalizeAudioSpeedValue(config.audioSpeed));
    const voiceId = normalizeMiniMaxAudioVoiceValue(config.audioVoice);

    try {
        const response = await axios.post<MiniMaxT2AResponse>(
            miniMaxT2AApiUrl(config),
            {
                model: modelOptionName(config.model),
                text: prompt,
                stream: false,
                language_boost: "auto",
                output_format: "hex",
                voice_setting: {
                    voice_id: voiceId,
                    speed,
                    vol: 1,
                    pitch: 0,
                },
                audio_setting: {
                    sample_rate: 32000,
                    bitrate: 128000,
                    format,
                    channel: 1,
                },
            },
            { headers: aiHeaders(config), signal: options?.signal },
        );
        return miniMaxAudioBlob(response.data, format);
    } catch (error) {
        throw new Error(readAxiosError(error, "MiniMax 音频生成失败", "/v1/t2a_v2"));
    }
}

export async function requestAudioTranscription(config: AiConfig, storageKey: string, options?: RequestOptions): Promise<string> {
    const selectedModel = config.transcriptionModel.trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const model = requestConfig.model.trim();
    assertAudioConfig(requestConfig, model);
    const profile = resolveGrokModelProfile(model);
    if (profile && profile.task !== "stt") {
        throw new Error("当前模型不是语音转文字模型；请选择 STT 模型");
    }
    const blob = await getMediaBlob(storageKey);
    if (!blob) throw new Error("本地音频文件不存在，请重新上传后再转文字");

    const nativeGrokVoice = usesNativeGrokVoiceApi(requestConfig.baseUrl, model, "stt");
    const formData = new FormData();
    formData.append("file", blob, audioFileName(blob.type));
    formData.append("model", nativeGrokVoice ? "grok-stt" : model);
    if (nativeGrokVoice) {
        formData.append("language", "auto");
    } else {
        formData.append("response_format", "json");
    }

    try {
        const endpoint = nativeGrokVoice ? resolveAudioHostProfile(requestConfig.baseUrl).sttPath : "/audio/transcriptions";
        const response = await axios.post<unknown>(aiApiUrl(requestConfig, endpoint), formData, {
            headers: nativeGrokVoice
                ? { ...(requestConfig.apiKey.trim() ? { Authorization: `Bearer ${requestConfig.apiKey}` } : {}), Accept: "application/json" }
                : requestConfig.apiKey.trim()
                  ? { Authorization: `Bearer ${requestConfig.apiKey}` }
                  : undefined,
            signal: options?.signal,
        });
        const text = transcriptionText(response.data);
        if (!text) throw new Error("语音转文字接口没有返回文本");
        return text;
    } catch (error) {
        const endpoint = nativeGrokVoice ? resolveAudioHostProfile(requestConfig.baseUrl).sttPath : "/audio/transcriptions";
        throw new Error(readAxiosError(error, "语音转文字失败", endpoint));
    }
}

function transcriptionText(payload: unknown) {
    if (typeof payload === "string") return payload.trim();
    if (!payload || typeof payload !== "object") return "";
    const text = (payload as { text?: unknown }).text;
    return typeof text === "string" ? text.trim() : "";
}

function audioFileName(type: string) {
    const extension = type.includes("wav") ? "wav" : type.includes("mpeg") || type.includes("mp3") ? "mp3" : type.includes("ogg") ? "ogg" : type.includes("webm") ? "webm" : type.includes("mp4") || type.includes("m4a") ? "m4a" : "audio";
    return `canvas-audio.${extension}`;
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置音频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim() && !isSameOriginRelayBaseUrl(config.baseUrl)) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持音频生成，请使用 OpenAI 格式渠道");
}

function miniMaxT2AApiUrl(config: AiConfig) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const withoutVersion = normalizedBaseUrl.replace(/\/v1$/i, "");
    return `${withoutVersion}/v1/t2a_v2`;
}

function miniMaxAudioBlob(payload: MiniMaxT2AResponse, format: string) {
    const statusCode = payload.base_resp?.status_code;
    if (typeof statusCode === "number" && statusCode !== 0) throw new Error(payload.base_resp?.status_msg || "MiniMax 音频生成失败");
    const audio = payload.data?.audio;
    if (!audio) throw new Error(payload.msg || payload.message || "MiniMax 接口没有返回音频数据");
    return new Blob([hexToUint8Array(audio)], { type: audioMimeType(format) });
}

function hexToUint8Array(hex: string) {
    const normalized = hex.trim();
    if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) throw new Error("MiniMax 返回的音频数据格式无效");
    const bytes = new Uint8Array(normalized.length / 2);
    for (let index = 0; index < normalized.length; index += 2) {
        bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
    }
    return bytes;
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "音频生成失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function readAxiosError(error: unknown, fallback: string, endpoint?: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || statusMessage(error.response?.status, fallback, endpoint);
    }
    return error instanceof Error ? error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string, endpoint?: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 404 && endpoint) return `当前渠道未提供 ${endpoint} 端点（404），请确认该模型是否支持 OpenAI 兼容音频接口`;
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}
