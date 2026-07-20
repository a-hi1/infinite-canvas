import localforage from "localforage";

export type Prompt = {
    id: string;
    title: string;
    coverUrl: string;
    prompt: string;
    tags: string[];
    category: string;
    githubUrl: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
    /** 一句话摘要，帮助快速理解用途 */
    summary?: string;
    /** 0-100，越高越适合直接拿去生成 */
    qualityScore?: number;
    hasCover?: boolean;
    topic?: string;
};

type PromptCategory = {
    category: string;
    label: string;
    githubUrl: string;
    build: () => Promise<Omit<Prompt, "category" | "githubUrl">[]>;
};

export const ALL_PROMPTS_OPTION = "全部";
export const PROMPT_QUALITY_MODES = [
    { value: "featured", label: "精选（有图优先）" },
    { value: "with-cover", label: "仅有预览图" },
    { value: "all", label: "全部" },
] as const;
export type PromptQualityMode = (typeof PROMPT_QUALITY_MODES)[number]["value"];

export type PromptSourceStatus = {
    category: string;
    label: string;
    githubUrl: string;
    count: number;
    ok: boolean;
    error?: string;
};

export type PromptListResponse = {
    items: Prompt[];
    tags: string[];
    categories: string[];
    categoryLabels: Record<string, string>;
    total: number;
    featuredTotal: number;
    sources: PromptSourceStatus[];
    fetchedAt: number;
    fromCache: boolean;
};

const awesomeGptImageRawBase = "https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main";
const awesomeGpt4oImagePromptsBase = "https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main";
const youMindGptImage2RawBase = "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main";
const youMindNanoBananaProRawBase = "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main";
const davidWuGptImage2RawBase = "https://raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main";
const cacheTtlMs = 1000 * 60 * 60;
const promptCacheKey = "third-party-prompts";
const recentPromptKey = "recent-prompts";
const favoritePromptKey = "favorite-prompts";
const myPromptKey = "my-prompts";
const recentPromptLimit = 20;
const favoritePromptLimit = 200;
const myPromptLimit = 300;
const promptCacheStore = localforage.createInstance({ name: "infinite-canvas", storeName: "prompt_cache" });
export const MY_PROMPTS_CATEGORY = "my-prompts";
export const FAVORITES_CATEGORY = "favorites";

const categories: PromptCategory[] = [
    { category: "awesome-gpt-image", label: "GPT 图像精选", githubUrl: "https://github.com/ZeroLu/awesome-gpt-image", build: buildAwesomeGptImagePrompts },
    { category: "awesome-gpt4o-image-prompts", label: "GPT-4o 图像", githubUrl: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts", build: buildAwesomeGpt4oImagePrompts },
    { category: "youmind-gpt-image-2", label: "GPT Image 2", githubUrl: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2", build: () => buildYouMindPrompts(youMindGptImage2RawBase, "youmind-gpt-image-2", "gpt-image-2") },
    { category: "youmind-nano-banana-pro", label: "Nano Banana Pro", githubUrl: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts", build: () => buildYouMindPrompts(youMindNanoBananaProRawBase, "youmind-nano-banana-pro", "nano-banana-pro") },
    { category: "davidwu-gpt-image2-prompts", label: "GPT Image2 合集", githubUrl: "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts", build: buildDavidWuGptImage2Prompts },
];

const categoryLabelMap = Object.fromEntries(categories.map((item) => [item.category, item.label]));

let loadingPrompts: Promise<{ items: Prompt[]; sources: PromptSourceStatus[]; fetchedAt: number; fromCache: boolean }> | null = null;
let memoryBundle: { items: Prompt[]; sources: PromptSourceStatus[]; fetchedAt: number; fromCache: boolean } | null = null;

export async function fetchPrompts({
    keyword = "",
    tag = [],
    category = ALL_PROMPTS_OPTION,
    qualityMode = "featured",
    page = 1,
    pageSize = 20,
    forceRefresh = false,
}: {
    keyword?: string;
    tag?: string[];
    category?: string;
    qualityMode?: PromptQualityMode;
    page?: number;
    pageSize?: number;
    forceRefresh?: boolean;
} = {}) {
    const bundle = await getPromptBundle(forceRefresh);
    const normalizedKeyword = keyword.trim().toLowerCase();
    const normalizedPage = Math.max(1, page);
    const normalizedPageSize = Math.max(1, Math.min(100, pageSize));
    const enriched = bundle.items.map(enrichPrompt);
    const withoutTagFilter = filterPrompts(enriched, { keyword: normalizedKeyword, category, tags: [], qualityMode });
    const filtered = sortPrompts(filterPrompts(enriched, { keyword: normalizedKeyword, category, tags: tag, qualityMode }));
    const featuredTotal = enriched.filter((item) => matchesQualityMode(item, "featured")).length;

    return {
        items: filtered.slice((normalizedPage - 1) * normalizedPageSize, normalizedPage * normalizedPageSize),
        tags: collectTags(withoutTagFilter).slice(0, 40),
        categories: categories.map((item) => item.category),
        categoryLabels: categoryLabelMap,
        total: filtered.length,
        featuredTotal,
        sources: bundle.sources,
        fetchedAt: bundle.fetchedAt,
        fromCache: bundle.fromCache,
    };
}

export function getCategoryLabel(category: string) {
    if (!category || category === ALL_PROMPTS_OPTION) return ALL_PROMPTS_OPTION;
    if (category === MY_PROMPTS_CATEGORY) return "我的提示词";
    if (category === FAVORITES_CATEGORY) return "收藏夹";
    return categoryLabelMap[category] || category;
}

export function getPromptSummary(prompt: Prompt) {
    if (prompt.summary) return prompt.summary;
    return buildPromptSummary(prompt.prompt, prompt.title);
}

export function getPromptQualityLabel(score = 0) {
    if (score >= 80) return "优质";
    if (score >= 60) return "可用";
    if (score >= 40) return "一般";
    return "偏弱";
}

export async function refreshPromptLibrary() {
    memoryBundle = null;
    loadingPrompts = null;
    return fetchPrompts({ page: 1, pageSize: 1, forceRefresh: true });
}

export async function getRecentPrompts() {
    const items = (await promptCacheStore.getItem<Prompt[]>(recentPromptKey)) || [];
    return items.filter((item) => item?.id && item?.prompt).map(enrichPrompt);
}

export async function rememberRecentPrompt(prompt: Prompt) {
    const current = await getRecentPrompts();
    const next = [enrichPrompt(prompt), ...current.filter((item) => item.id !== prompt.id)].slice(0, recentPromptLimit);
    await promptCacheStore.setItem(recentPromptKey, next);
    return next;
}

export async function getFavoritePrompts() {
    const items = (await promptCacheStore.getItem<Prompt[]>(favoritePromptKey)) || [];
    return items.filter((item) => item?.id && item?.prompt).map(enrichPrompt);
}

export async function isFavoritePrompt(id: string) {
    const items = await getFavoritePrompts();
    return items.some((item) => item.id === id);
}

export async function toggleFavoritePrompt(prompt: Prompt) {
    const current = await getFavoritePrompts();
    const exists = current.some((item) => item.id === prompt.id);
    const next = exists
        ? current.filter((item) => item.id !== prompt.id)
        : [enrichPrompt(prompt), ...current].slice(0, favoritePromptLimit);
    await promptCacheStore.setItem(favoritePromptKey, next);
    return { favorited: !exists, items: next };
}

export async function getMyPrompts() {
    const items = (await promptCacheStore.getItem<Prompt[]>(myPromptKey)) || [];
    return items.filter((item) => item?.id && item?.prompt).map(enrichPrompt);
}

export async function saveMyPrompt(input: { id?: string; title: string; prompt: string; tags?: string[]; coverUrl?: string; sourcePromptId?: string }) {
    const title = input.title.trim();
    const content = input.prompt.trim();
    if (!title) throw new Error("请填写标题");
    if (!content) throw new Error("请填写提示词内容");

    const current = await getMyPrompts();
    const now = new Date().toISOString();
    if (input.id) {
        const index = current.findIndex((item) => item.id === input.id);
        if (index < 0) throw new Error("未找到要编辑的提示词");
        const nextItem = enrichPrompt({
            ...current[index],
            title,
            prompt: content,
            tags: normalizePromptTags(input.tags || current[index].tags || []),
            coverUrl: input.coverUrl || current[index].coverUrl || "",
            updatedAt: now,
        });
        const next = [...current];
        next[index] = nextItem;
        await promptCacheStore.setItem(myPromptKey, next);
        return nextItem;
    }

    const created = enrichPrompt({
        id: `my-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title,
        prompt: content,
        coverUrl: input.coverUrl || "",
        tags: normalizePromptTags(input.tags || ["我的模板"]),
        category: MY_PROMPTS_CATEGORY,
        githubUrl: "",
        preview: "",
        createdAt: now,
        updatedAt: now,
        summary: buildPromptSummary(content, title),
    });
    const next = [created, ...current].slice(0, myPromptLimit);
    await promptCacheStore.setItem(myPromptKey, next);
    return created;
}

export async function deleteMyPrompt(id: string) {
    const current = await getMyPrompts();
    const next = current.filter((item) => item.id !== id);
    await promptCacheStore.setItem(myPromptKey, next);
    return next;
}

export async function savePromptToMine(prompt: Prompt) {
    return saveMyPrompt({
        title: prompt.title,
        prompt: prompt.prompt,
        tags: [...(prompt.tags || []), "来自提示词库"],
        coverUrl: prompt.coverUrl,
        sourcePromptId: prompt.id,
    });
}

export function listPromptSources() {
    return categories.map((item) => ({ category: item.category, label: item.label, githubUrl: item.githubUrl }));
}

async function getPromptBundle(forceRefresh = false) {
    if (!forceRefresh && memoryBundle?.items.length) return memoryBundle;

    const cached = await promptCacheStore.getItem<{ items?: Prompt[]; sources?: PromptSourceStatus[]; fetchedAt?: number }>(promptCacheKey);
    if (!forceRefresh && cached?.items?.length && cached.fetchedAt && Date.now() - cached.fetchedAt < cacheTtlMs) {
        memoryBundle = {
            items: cached.items,
            sources: cached.sources || buildFallbackSources(cached.items),
            fetchedAt: cached.fetchedAt,
            fromCache: true,
        };
        return memoryBundle;
    }

    if (loadingPrompts) return loadingPrompts;
    loadingPrompts = loadPromptBundle()
        .then(async (bundle) => {
            if (bundle.items.length) {
                await promptCacheStore.setItem(promptCacheKey, {
                    items: bundle.items,
                    sources: bundle.sources,
                    fetchedAt: bundle.fetchedAt,
                });
                memoryBundle = { ...bundle, fromCache: false };
                return memoryBundle;
            }
            if (cached?.items?.length) {
                memoryBundle = {
                    items: cached.items,
                    sources: cached.sources || buildFallbackSources(cached.items),
                    fetchedAt: cached.fetchedAt || Date.now(),
                    fromCache: true,
                };
                return memoryBundle;
            }
            memoryBundle = { ...bundle, fromCache: false };
            return memoryBundle;
        })
        .finally(() => {
            loadingPrompts = null;
        });
    return loadingPrompts;
}

async function loadPromptBundle() {
    const settled = await Promise.all(
        categories.map(async (category) => {
            try {
                const items = await category.build();
                const mapped = items.map((item) => enrichPrompt({ ...item, category: category.category, githubUrl: category.githubUrl }));
                return {
                    items: mapped,
                    source: { category: category.category, label: category.label, githubUrl: category.githubUrl, count: mapped.length, ok: true } satisfies PromptSourceStatus,
                };
            } catch (error) {
                return {
                    items: [] as Prompt[],
                    source: {
                        category: category.category,
                        label: category.label,
                        githubUrl: category.githubUrl,
                        count: 0,
                        ok: false,
                        error: error instanceof Error ? error.message : "同步失败",
                    } satisfies PromptSourceStatus,
                };
            }
        }),
    );

    return {
        items: settled.flatMap((item) => item.items),
        sources: settled.map((item) => item.source),
        fetchedAt: Date.now(),
        fromCache: false,
    };
}

function buildFallbackSources(items: Prompt[]): PromptSourceStatus[] {
    return categories.map((category) => {
        const count = items.filter((item) => item.category === category.category).length;
        return {
            category: category.category,
            label: category.label,
            githubUrl: category.githubUrl,
            count,
            ok: count > 0,
            error: count > 0 ? undefined : "缓存中无数据",
        };
    });
}

function filterPrompts(items: Prompt[], options: { keyword: string; category: string; tags: string[]; qualityMode?: PromptQualityMode }) {
    return items.filter((item) => {
        if (isActiveOption(options.category) && item.category !== options.category) return false;
        if (options.tags.length && !options.tags.some((tag) => item.tags.includes(tag))) return false;
        if (options.qualityMode && !matchesQualityMode(item, options.qualityMode)) return false;
        if (!options.keyword) return true;
        return [item.title, item.prompt, item.summary || "", item.topic || "", item.category, getCategoryLabel(item.category), ...item.tags].join(" ").toLowerCase().includes(options.keyword);
    });
}

function matchesQualityMode(item: Prompt, mode: PromptQualityMode) {
    if (mode === "all") return true;
    if (mode === "with-cover") return promptHasUsableCover(item);
    // featured: 真正可用封面优先；无可用封面时仅保留正文质量够高的条目
    return promptHasUsableCover(item) || (item.qualityScore || 0) >= 70;
}

function sortPrompts(items: Prompt[]) {
    return [...items].sort((a, b) => {
        // 真正有可用预览图的排前面；坏链/空串/占位不算有图
        const coverDelta = Number(promptHasUsableCover(b)) - Number(promptHasUsableCover(a));
        if (coverDelta) return coverDelta;
        const scoreDelta = (b.qualityScore || 0) - (a.qualityScore || 0);
        if (scoreDelta) return scoreDelta;
        return a.title.localeCompare(b.title, "zh-CN");
    });
}

/** 仅当 coverUrl 像真实图片地址时才算「有预览图」；1x1/占位/非图片链接不算。 */
export function isUsablePromptCoverUrl(coverUrl: string | undefined | null) {
    const url = (coverUrl || "").trim();
    if (!url) return false;
    if (url.startsWith("data:image/")) {
        // 极短 data URI 多半是 1x1 占位
        if (url.length < 80) return false;
        return true;
    }
    if (!/^https?:\/\//i.test(url) && !url.startsWith("blob:")) return false;
    const lower = url.toLowerCase();
    // 常见占位 / 追踪像素 / 空图
    if (/(placeholder|no[-_]?image|no[-_]?cover|default[-_]?cover|blank|spacer|pixel\.|1x1|transparent\.gif|spacer\.gif)/i.test(lower)) return false;
    if (/\/(avatar|favicon)s?\//i.test(lower) && !/\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(lower)) return false;
    return true;
}

export function promptHasUsableCover(item: Pick<Prompt, "coverUrl" | "hasCover">) {
    if (item.hasCover === false) return false;
    return isUsablePromptCoverUrl(item.coverUrl);
}

function enrichPrompt(item: Prompt): Prompt {
    const rawCover = (item.coverUrl || "").trim();
    const coverUrl = isUsablePromptCoverUrl(rawCover) ? rawCover : "";
    const tags = normalizePromptTags(item.tags);
    const summary = buildPromptSummary(item.prompt, item.title);
    const topic = inferPromptTopic(item.title, item.prompt, tags);
    const qualityScore = scorePromptQuality({ ...item, coverUrl, tags, summary, topic });
    return {
        ...item,
        coverUrl,
        tags,
        summary,
        topic,
        qualityScore,
        hasCover: Boolean(coverUrl),
    };
}

function buildPromptSummary(prompt: string, title: string) {
    const text = (prompt || "").replace(/\s+/g, " ").trim();
    if (!text) return title.slice(0, 36);
    // 取前半句，尽量像“用途说明”
    const sentence = text.split(/[。！？.!?；;\n]/).map((item) => item.trim()).find(Boolean) || text;
    return sentence.length > 48 ? `${sentence.slice(0, 48)}…` : sentence;
}

function scorePromptQuality(item: Pick<Prompt, "title" | "prompt" | "coverUrl" | "tags" | "summary" | "topic">) {
    const prompt = (item.prompt || "").trim();
    const title = (item.title || "").trim();
    let score = 0;

    // 只给「看起来可用」的封面加分，避免坏链把精选池刷满
    if (isUsablePromptCoverUrl(item.coverUrl)) score += 35;
    if (prompt.length >= 40) score += 15;
    if (prompt.length >= 80) score += 10;
    if (prompt.length >= 140) score += 5;
    if (title.length >= 4 && title.length <= 40) score += 8;
    if ((item.tags || []).length > 0) score += 6;
    if ((item.tags || []).length >= 2) score += 4;
    if (item.topic) score += 6;

    // 结构信号：包含风格/光线/构图等关键词更适合直接生成
    const structureHits = ["style", "lighting", "composition", "camera", "风格", "光线", "构图", "镜头", "质感", "氛围", "细节"].filter((key) => prompt.toLowerCase().includes(key)).length;
    score += Math.min(12, structureHits * 3);

    // 过短或过脏降权
    if (prompt.length < 24) score -= 20;
    if (/^https?:\/\//i.test(prompt)) score -= 25;
    if ((prompt.match(/[a-z]/gi) || []).length > 0 && (prompt.match(/[一-鿿]/g) || []).length === 0 && prompt.length < 50) score -= 6;

    return Math.max(0, Math.min(100, score));
}

function inferPromptTopic(title: string, prompt: string, tags: string[]) {
    const text = `${title} ${prompt} ${tags.join(" ")}`.toLowerCase();
    const rules: Array<[string, RegExp]> = [
        ["人像", /portrait|person|people|girl|boy|man|woman|人像|人物|美女|帅哥|肖像/],
        ["产品", /product|packaging|商业|产品|包装|电商|展示/],
        ["场景", /landscape|city|street|room|interior|场景|风景|城市|室内|街景/],
        ["风格", /style|anime|cinematic|watercolor|oil painting|风格|动漫|电影感|水彩|油画/],
        ["设计", /logo|poster|ui|brand|设计|海报|标志|界面/],
        ["动物", /animal|cat|dog|bird|动物|猫|狗|鸟/],
        ["美食", /food|dish|cuisine|美食|食物|料理/],
    ];
    for (const [topic, pattern] of rules) {
        if (pattern.test(text)) return topic;
    }
    return tags[0] || "通用";
}

function normalizePromptTags(tags: string[]) {
    const mapped = (tags || [])
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .map((tag) => TAG_ALIAS[tag] || tag)
        .filter((tag) => !NOISE_TAGS.has(tag));
    return Array.from(new Set(mapped)).slice(0, 6);
}

const TAG_ALIAS: Record<string, string> = {
    portrait: "人像",
    "product photography": "产品",
    product: "产品",
    landscape: "场景",
    cinematic: "电影感",
    anime: "动漫",
    "gpt-image-2": "gpt-image",
    "nano-banana-pro": "nano-banana",
    gpt4o: "gpt-4o",
};

const NOISE_TAGS = new Set(["null", "undefined", "test", "demo", "misc", "other", "未分类"]);

async function buildAwesomeGptImagePrompts() {
    const markdown = await fetchText(awesomeGptImageRawBase, "README.zh-CN.md");
    const items: Omit<Prompt, "category" | "githubUrl">[] = [];
    for (const section of splitBeforeHeading(markdown, "## ")) {
        const tags = tagsFromHeading(firstMatch(section, /^##\s+(.+)$/m));
        for (const block of splitBeforeHeading(section, "### ")) {
            const title = firstMatch(block, /^###\s+(.+)$/m).replace(/\[([^\]]+)]\([^)]+\)/g, "$1").trim();
            const prompt = firstMatch(block, /\*\*提示词:\*\*\s*\r?\n\s*```[\w-]*\r?\n(.*?)\r?\n```/s).trim();
            if (!title || !prompt) continue;
            const images = extractMarkdownImages(awesomeGptImageRawBase, block);
            items.push(defaultPrompt(`awesome-gpt-image-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", tags, markdownPreview(images)));
        }
    }
    return items;
}

async function buildAwesomeGpt4oImagePrompts() {
    const markdown = await fetchText(awesomeGpt4oImagePromptsBase, "README.zh-CN.md");
    const items: Omit<Prompt, "category" | "githubUrl">[] = [];
    for (const block of splitBeforeHeading(markdown, "### ")) {
        const title = firstMatch(block, /^###\s+(.+)$/m).trim();
        const prompt = firstMatch(block, /- \*\*提示词文本：\*\*\s*`(.*?)`/s).trim();
        if (!title || !prompt) continue;
        const images = extractMarkdownImages(awesomeGpt4oImagePromptsBase, block);
        items.push(defaultPrompt(`awesome-gpt4o-image-prompts-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", ["gpt4o"], markdownPreview(images)));
    }
    return items;
}

async function buildYouMindPrompts(baseUrl: string, idPrefix: string, modelTag: string) {
    const markdown = await fetchText(baseUrl, "README_zh.md");
    const items: Omit<Prompt, "category" | "githubUrl">[] = [];
    for (const block of splitBeforeHeading(markdown, "### ")) {
        const title = firstMatch(block, /^###\s+No\.\s*\d+:\s*(.+)$/m).trim();
        const prompt = firstMatch(block, /#### .*?提示词\s*\r?\n\s*```[\w-]*\r?\n(.*?)\r?\n```/s).trim();
        if (!title || !prompt) continue;
        const images = extractMarkdownImages(baseUrl, block);
        items.push(defaultPrompt(`${idPrefix}-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", youMindTags(title, modelTag), markdownPreview(images)));
    }
    return items;
}

async function buildDavidWuGptImage2Prompts() {
    const data = await fetchJson<Array<{ id?: number; title_en?: string; title_cn?: string; category?: string; category_cn?: string; prompt?: string; note?: string; author?: string; source?: string; needs_ref?: boolean; image?: string }>>(davidWuGptImage2RawBase, "prompts.json");
    return data
        .map((item, index) => {
            const title = (item.title_cn || item.title_en || "").trim();
            const prompt = (item.prompt || "").trim();
            if (!title || !prompt) return null;
            const image = absoluteImage(davidWuGptImage2RawBase, item.image || "");
            const preview = [item.title_en, item.note, image ? `![](${image})` : ""].filter(Boolean).join("\n\n");
            return defaultPrompt(`davidwu-gpt-image2-prompts-${leftPad(item.id || index + 1)}`, title, prompt, image, davidWuTags(item), preview);
        })
        .filter((item): item is Omit<Prompt, "category" | "githubUrl"> => Boolean(item));
}

function defaultPrompt(id: string, title: string, prompt: string, coverUrl: string, tags: string[], preview: string): Omit<Prompt, "category" | "githubUrl"> {
    const normalizedTags = normalizePromptTags(tags);
    const summary = buildPromptSummary(prompt, title);
    const topic = inferPromptTopic(title, prompt, normalizedTags);
    const usableCover = isUsablePromptCoverUrl(coverUrl) ? coverUrl.trim() : "";
    const qualityScore = scorePromptQuality({ title, prompt, coverUrl: usableCover, tags: normalizedTags, summary, topic });
    return {
        id,
        title,
        coverUrl: usableCover,
        prompt,
        tags: normalizedTags,
        preview,
        createdAt: "",
        updatedAt: "",
        summary,
        topic,
        qualityScore,
        hasCover: Boolean(usableCover),
    };
}

async function fetchText(baseUrl: string, file: string) {
    const response = await fetch(`${baseUrl}/${file}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${file} 拉取失败`);
    return response.text();
}

async function fetchJson<T>(baseUrl: string, file: string) {
    return JSON.parse(await fetchText(baseUrl, file)) as T;
}

function splitBeforeHeading(markdown: string, prefix: string) {
    const blocks: string[] = [];
    let current: string[] = [];
    for (const line of markdown.split("\n")) {
        if (line.startsWith(prefix) && current.length) {
            blocks.push(current.join("\n"));
            current = [];
        }
        current.push(line);
    }
    blocks.push(current.join("\n"));
    return blocks;
}

function firstMatch(value: string, pattern: RegExp) {
    return pattern.exec(value)?.[1] || "";
}

function extractMarkdownImages(baseUrl: string, markdown: string) {
    return Array.from(markdown.matchAll(/!\[[^\]]*]\(([^)]+)\)/g), (match) => absoluteImage(baseUrl, match[1])).filter(Boolean);
}

function absoluteImage(baseUrl: string, image: string) {
    if (!image) return "";
    if (/^https?:\/\//i.test(image)) return image;
    return `${baseUrl}/${image.replace(/^\.?\//, "")}`;
}

function tagsFromCategory(category: string) {
    return splitTags(category.replace(/\s+Cases$/i, ""), /\s*(?:&|and)\s*/);
}

function tagsFromHeading(heading: string) {
    return splitTags(heading.replace(/[^\p{L}\p{N}/&、与 ]/gu, ""), /\s*(?:\/|&|、|与)\s*/);
}

function youMindTags(title: string, modelTag: string) {
    const [, prefix] = title.match(/^(.+?) - /) || [];
    return [modelTag, ...tagsFromHeading(prefix || "")];
}

function davidWuTags(item: { category_cn?: string; category?: string; author?: string; source?: string; needs_ref?: boolean }) {
    const tags = splitTags([item.category_cn, item.category, item.author, item.source].filter(Boolean).join("/"), /\//);
    if (item.needs_ref) tags.push("需要参考图");
    return tags;
}

function splitTags(value: string, pattern: RegExp) {
    return value
        .split(pattern)
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);
}

function markdownPreview(images: string[]) {
    return images.filter(Boolean).map((image) => `![](${image})`).join("\n\n");
}

function collectTags(items: Prompt[]) {
    const counter = new Map<string, number>();
    for (const item of items) {
        for (const tag of item.tags || []) {
            if (!tag) continue;
            counter.set(tag, (counter.get(tag) || 0) + 1);
        }
    }
    return Array.from(counter.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
        .map(([tag]) => tag);
}

function leftPad(value: number) {
    return String(value).padStart(4, "0");
}

function isActiveOption(value: string) {
    return value && value !== "全部" && value !== "all";
}

export function formatPromptDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
