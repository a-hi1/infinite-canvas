import axios from "axios";

import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeMiniMaxAudioFormatValue, normalizeMiniMaxAudioVoiceValue, normalizeOpenAiAudioVoiceValue } from "@/lib/audio-generation";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, isAiProxyBaseUrl, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

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
    assertAudioConfig(requestConfig, model);
    if (isMiniMaxAudioConfig(requestConfig, model)) return requestMiniMaxAudioGeneration(requestConfig, prompt, options);
    return requestOpenAiAudioGeneration(requestConfig, prompt, options);
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
        throw new Error(readAxiosError(error, "音频生成失败"));
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
        throw new Error(readAxiosError(error, "MiniMax 音频生成失败"));
    }
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置音频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim() && !isAiProxyBaseUrl(config.baseUrl)) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持音频生成，请使用 OpenAI 格式渠道");
}

function isMiniMaxAudioConfig(config: AiConfig, model: string) {
    const normalizedBaseUrl = config.baseUrl.trim().toLowerCase();
    const normalizedModel = modelOptionName(model).toLowerCase();
    return normalizedBaseUrl.includes("minimax") || normalizedBaseUrl.includes("minimaxi") || normalizedModel.startsWith("speech-");
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

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || statusMessage(error.response?.status, fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}
