import { nanoid } from "nanoid";

export type PromptSource = {
    id: string;
    name: string;
    /** 自定义或 registry JSON 地址；有 URL 时优先走 JSON 拉取 */
    url: string;
    homepage: string;
    enabled: boolean;
    builtIn: boolean;
};

/** 与上游 yukkcat/image-prompts registry 对齐的内置源 id */
export const BUILTIN_PROMPT_SOURCE_IDS = [
    "banana-prompt-quicker",
    "davidwu-gpt-image2-prompts",
    "awesome-gpt-image",
    "awesome-gpt4o-image-prompts",
    "youmind-gpt-image-2",
    "youmind-nano-banana-pro",
] as const;

export type BuiltinPromptSourceId = (typeof BUILTIN_PROMPT_SOURCE_IDS)[number];

/** 本地 GitHub markdown 解析器仍可用的 id（无 registry 或 registry 失败时可回退） */
export const LOCAL_PARSER_PROMPT_SOURCE_IDS = [
    "awesome-gpt-image",
    "awesome-gpt4o-image-prompts",
    "youmind-gpt-image-2",
    "youmind-nano-banana-pro",
    "davidwu-gpt-image2-prompts",
] as const;

export type LocalParserPromptSourceId = (typeof LOCAL_PARSER_PROMPT_SOURCE_IDS)[number];

export const PROMPT_REGISTRY_HOMEPAGE = "https://github.com/yukkcat/image-prompts";
const PROMPT_REGISTRY_SOURCE_BASE = "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources";

export function createPromptSource(source?: Partial<PromptSource>): PromptSource {
    return {
        id: source?.id?.trim() || nanoid(),
        name: source?.name?.trim() || "新来源",
        url: source?.url?.trim() || "",
        homepage: source?.homepage?.trim() || "",
        enabled: source?.enabled ?? true,
        builtIn: source?.builtIn ?? false,
    };
}

export const DEFAULT_PROMPT_SOURCES: PromptSource[] = [
    registrySource("banana-prompt-quicker", "Banana Prompt Quicker", "https://glidea.github.io/banana-prompt-quicker/"),
    registrySource("davidwu-gpt-image2-prompts", "DavidWu GPT Image 2", "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts"),
    registrySource("awesome-gpt-image", "Awesome GPT Image", "https://github.com/ZeroLu/awesome-gpt-image"),
    registrySource("awesome-gpt4o-image-prompts", "Awesome GPT-4o", "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts"),
    registrySource("youmind-gpt-image-2", "YouMind GPT Image 2", "https://github.com/YouMind-OpenLab/awesome-gpt-image-2"),
    registrySource("youmind-nano-banana-pro", "YouMind Nano Banana Pro", "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts"),
];

function registrySource(id: string, name: string, homepage: string): PromptSource {
    return {
        id,
        name,
        url: `${PROMPT_REGISTRY_SOURCE_BASE}/${id}.json`,
        homepage,
        enabled: true,
        builtIn: true,
    };
}

export function isBuiltinPromptSourceId(id: string): id is BuiltinPromptSourceId {
    return (BUILTIN_PROMPT_SOURCE_IDS as readonly string[]).includes(id);
}

export function isLocalParserPromptSourceId(id: string): id is LocalParserPromptSourceId {
    return (LOCAL_PARSER_PROMPT_SOURCE_IDS as readonly string[]).includes(id);
}
