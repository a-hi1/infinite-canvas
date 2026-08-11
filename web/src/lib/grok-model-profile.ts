export type GrokModelTask = "text" | "web-search" | "image-generation" | "image-edit" | "video" | "tts" | "stt" | "voice";
export type GrokModelCapability = "image" | "video" | "text" | "audio";

export type GrokModelProfile = {
    model: string;
    task: GrokModelTask;
    capability: GrokModelCapability;
};

export const GROK_MODEL_PROFILES: readonly GrokModelProfile[] = [
    { model: "grok", task: "text", capability: "text" },
    { model: "grok-build", task: "text", capability: "text" },
    { model: "grok-4.5", task: "text", capability: "text" },
    { model: "grok-composer", task: "text", capability: "text" },
    { model: "grok-web-search", task: "web-search", capability: "text" },
    { model: "grok-imagine-image", task: "image-generation", capability: "image" },
    { model: "grok-imagine-image-quality", task: "image-generation", capability: "image" },
    { model: "grok-imagine-edit", task: "image-edit", capability: "image" },
    { model: "grok-imagine-video", task: "video", capability: "video" },
    { model: "grok-imagine-video-1.5", task: "video", capability: "video" },
    { model: "grok-imagine-video-1.5-preview", task: "video", capability: "video" },
    { model: "grok-voice-stt", task: "stt", capability: "audio" },
    { model: "grok-voice-tts", task: "tts", capability: "audio" },
    { model: "grok-voice-latest", task: "voice", capability: "audio" },
] as const;

const profileByModel = new Map(GROK_MODEL_PROFILES.map((profile) => [profile.model, profile]));

export function grokModelName(value: string) {
    const separatorIndex = value.indexOf("::");
    return (separatorIndex >= 0 ? value.slice(separatorIndex + 2) : value).trim().toLowerCase();
}

export function resolveGrokModelProfile(value: string) {
    return profileByModel.get(grokModelName(value));
}

export function isGrokModelTask(value: string, ...tasks: GrokModelTask[]) {
    const profile = resolveGrokModelProfile(value);
    return Boolean(profile && tasks.includes(profile.task));
}
