export const openAiAudioVoiceOptions = [
    { value: "alloy", label: "Alloy" },
    { value: "ash", label: "Ash" },
    { value: "ballad", label: "Ballad" },
    { value: "coral", label: "Coral" },
    { value: "echo", label: "Echo" },
    { value: "fable", label: "Fable" },
    { value: "nova", label: "Nova" },
    { value: "onyx", label: "Onyx" },
    { value: "sage", label: "Sage" },
    { value: "shimmer", label: "Shimmer" },
    { value: "verse", label: "Verse" },
    { value: "marin", label: "Marin" },
    { value: "cedar", label: "Cedar" },
];

export const minimaxAudioVoiceOptions = [
    { value: "male-qn-qingse", label: "MiniMax 青涩男声" },
    { value: "male-qn-jingying", label: "MiniMax 精英男声" },
    { value: "male-qn-badao", label: "MiniMax 霸道男声" },
    { value: "female-shaonv", label: "MiniMax 少女音" },
    { value: "female-yujie", label: "MiniMax 御姐音" },
    { value: "female-chengshu", label: "MiniMax 成熟女声" },
    { value: "audiobook_male_1", label: "MiniMax 有声书男声" },
    { value: "audiobook_female_1", label: "MiniMax 有声书女声" },
    { value: "English_expressive_narrator", label: "MiniMax English Narrator" },
];

export const audioVoiceOptions = [...openAiAudioVoiceOptions, ...minimaxAudioVoiceOptions];

export const audioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "aac", label: "AAC" },
    { value: "flac", label: "FLAC" },
    { value: "pcm", label: "PCM" },
];

export function normalizeAudioVoiceValue(value: string) {
    return audioVoiceOptions.some((item) => item.value === value) ? value : "alloy";
}

export function normalizeOpenAiAudioVoiceValue(value: string) {
    return openAiAudioVoiceOptions.some((item) => item.value === value) ? value : "alloy";
}

export function normalizeMiniMaxAudioVoiceValue(value: string) {
    return minimaxAudioVoiceOptions.some((item) => item.value === value) ? value : "male-qn-qingse";
}

export function normalizeAudioFormatValue(value: string) {
    return audioFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

export function normalizeMiniMaxAudioFormatValue(value: string) {
    const format = normalizeAudioFormatValue(value);
    return ["mp3", "wav", "flac", "pcm"].includes(format) ? format : "mp3";
}

export function normalizeAudioSpeedValue(value: string) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) return "1";
    return String(Math.max(0.25, Math.min(4, Number(speed.toFixed(2)))));
}

export function audioVoiceLabel(value: string) {
    const voice = normalizeAudioVoiceValue(value);
    return audioVoiceOptions.find((item) => item.value === voice)?.label || voice;
}

export function audioFormatLabel(value: string) {
    const format = normalizeAudioFormatValue(value);
    return audioFormatOptions.find((item) => item.value === format)?.label || format;
}

export function audioSpeedLabel(value: string) {
    return `${normalizeAudioSpeedValue(value)}x`;
}

export function audioMimeType(format: string) {
    if (format === "wav") return "audio/wav";
    if (format === "opus") return "audio/opus";
    if (format === "aac") return "audio/aac";
    if (format === "flac") return "audio/flac";
    if (format === "pcm") return "audio/pcm";
    return "audio/mpeg";
}
