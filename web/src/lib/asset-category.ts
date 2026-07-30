/** 资产分类：与 kind（文本/图片/视频）正交，按内容用途划分。 */

export const UNCATEGORIZED_LABEL = "未分类";
export const ALL_CATEGORIES_VALUE = "all";
export const UNCATEGORIZED_VALUE = "__uncategorized__";

/** 固定主分类：筛选条始终展示，便于按人物/场景/道具等管理。 */
export const STANDARD_ASSET_CATEGORIES = ["人物", "场景", "道具", "风格参考", "分镜", "其他"] as const;
export type StandardAssetCategory = (typeof STANDARD_ASSET_CATEGORIES)[number];

/** 历史/别名 → 标准分类（不写回存储，仅规范化读取与筛选）。 */
const CATEGORY_ALIASES: Record<string, StandardAssetCategory> = {
    角色: "人物",
    人物角色: "人物",
    角色设定: "人物",
    character: "人物",
    characters: "人物",
    person: "人物",
    people: "人物",
    场景图: "场景",
    背景: "场景",
    scene: "场景",
    background: "场景",
    prop: "道具",
    props: "道具",
    item: "道具",
    items: "道具",
    物件: "道具",
    style: "风格参考",
    风格: "风格参考",
    storyboard: "分镜",
    分镜图: "分镜",
    other: "其他",
    misc: "其他",
};

/** 智能分类关键词（标题/标签/来源/备注/正文/提示词/文件名）。 */
const CATEGORY_KEYWORDS: Record<StandardAssetCategory, string[]> = {
    人物: ["人物", "角色", "人像", "肖像", "半身", "全身像", "脸部", "面部", "女孩", "男孩", "少女", "少年", "女人", "男人", "美女", "帅哥", "老人", "儿童", "小孩", "人设", "角色设定", "portrait", "character", "girl", "boy", "woman", "man", "lady", "person", "face", "selfie", "actor", "actress"],
    场景: ["场景", "背景", "环境", "室内", "室外", "风景", "街景", "城市", "街道", "房间", "卧室", "客厅", "厨房", "森林", "海边", "沙滩", "山脉", "夜景", "外景", "内景", "landscape", "scenery", "scene", "background", "environment", "city", "street", "room", "forest", "beach", "mountain", "skyline"],
    道具: ["道具", "物件", "物品", "武器", "刀具", "枪", "剑", "工具", "车辆", "汽车", "摩托", "自行车", "家具", "椅子", "桌子", "杯子", "瓶子", "手机", "电脑", "包", "帽子", "鞋", "首饰", "prop", "props", "item", "object", "weapon", "car", "bike", "furniture", "product", "gadget"],
    风格参考: ["风格", "画风", "风格参考", "色板", "配色", "材质", "光影参考", "moodboard", "style", "reference", "aesthetic", "palette", "texture", "lookbook"],
    分镜: ["分镜", "分镜图", "镜头", "镜号", "故事板", "关键镜", "运镜", "storyboard", "story board", "shot list", "frame", "panel"],
    其他: [],
};

export type AssetCategorySuggestInput = {
    title?: string;
    tags?: string[];
    source?: string;
    note?: string;
    content?: string;
    prompt?: string;
    fileName?: string;
    kind?: "text" | "image" | "video" | string;
};

export function normalizeAssetCategory(value?: string | null) {
    return String(value || "").trim();
}

/** 读侧规范化：别名落到标准分类；未知自定义名原样保留。 */
export function canonicalizeAssetCategory(value?: string | null) {
    const raw = normalizeAssetCategory(value);
    if (!raw) return "";
    const lower = raw.toLowerCase();
    if (CATEGORY_ALIASES[raw]) return CATEGORY_ALIASES[raw];
    if (CATEGORY_ALIASES[lower]) return CATEGORY_ALIASES[lower];
    const standard = STANDARD_ASSET_CATEGORIES.find((item) => item === raw);
    return standard || raw;
}

export function assetCategoryLabel(value?: string | null) {
    return canonicalizeAssetCategory(value) || UNCATEGORIZED_LABEL;
}

export function assetCategoryFilterKey(value?: string | null) {
    const normalized = canonicalizeAssetCategory(value);
    return normalized || UNCATEGORIZED_VALUE;
}

/**
 * 筛选/下拉用分类列表：
 * 1) 固定主分类（人物/场景/道具…）始终在前
 * 2) 资产里出现的自定义分类追加在后
 */
export function collectAssetCategories(assets: Array<{ category?: string | null }> = []) {
    const custom = new Set<string>();
    for (const asset of assets) {
        const name = canonicalizeAssetCategory(asset.category);
        if (!name) continue;
        if (!(STANDARD_ASSET_CATEGORIES as readonly string[]).includes(name)) custom.add(name);
    }
    const customSorted = Array.from(custom).sort((a, b) => a.localeCompare(b, "zh-CN"));
    return [...STANDARD_ASSET_CATEGORIES, ...customSorted];
}

/** 资产页/选择器筛选 chips：全部分类 + 标准分类 + 自定义 + 未分类。 */
export function buildAssetCategoryFilterOptions(assets: Array<{ category?: string | null }> = []) {
    const names = collectAssetCategories(assets);
    return [
        { label: "全部分类", value: ALL_CATEGORIES_VALUE },
        ...names.map((name) => ({ label: name, value: name })),
        { label: UNCATEGORIZED_LABEL, value: UNCATEGORIZED_VALUE },
    ];
}

export function matchesAssetCategoryFilter(assetCategory: string | null | undefined, filter: string) {
    if (!filter || filter === ALL_CATEGORIES_VALUE) return true;
    const key = assetCategoryFilterKey(assetCategory);
    return key === filter;
}

/** 表单保存：标准名规范化，别名写入标准分类，空白清空。 */
export function resolveAssetCategoryForSave(value?: string | string[] | null) {
    const raw = Array.isArray(value) ? value[0] : value;
    return canonicalizeAssetCategory(raw) || undefined;
}

export function standardAssetCategoryOptions() {
    return STANDARD_ASSET_CATEGORIES.map((name) => ({ label: name, value: name }));
}

/**
 * 根据标题/标签/来源/备注/正文/提示词/文件名推断分类。
 * 无把握时返回 undefined（保持未分类），避免乱贴标签。
 */
export function suggestAssetCategory(input: AssetCategorySuggestInput): StandardAssetCategory | undefined {
    const blob = [
        input.title,
        input.source,
        input.note,
        input.content,
        input.prompt,
        input.fileName,
        ...(input.tags || []),
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    if (!blob.trim()) return undefined;

    // 已是标准名/别名时直接采用
    const direct = canonicalizeAssetCategory(input.title) || canonicalizeAssetCategory(input.source);
    if (direct && (STANDARD_ASSET_CATEGORIES as readonly string[]).includes(direct)) {
        // 仅当 title/source 本身就是分类词时
        if (normalizeAssetCategory(input.title) === direct || normalizeAssetCategory(input.source) === direct) {
            return direct as StandardAssetCategory;
        }
        if (CATEGORY_ALIASES[normalizeAssetCategory(input.title)] || CATEGORY_ALIASES[normalizeAssetCategory(input.source)]) {
            return direct as StandardAssetCategory;
        }
    }

    const scores = Object.fromEntries(STANDARD_ASSET_CATEGORIES.map((name) => [name, 0])) as Record<StandardAssetCategory, number>;
    for (const category of STANDARD_ASSET_CATEGORIES) {
        for (const keyword of CATEGORY_KEYWORDS[category]) {
            const key = keyword.toLowerCase();
            if (!key) continue;
            if (blob.includes(key)) {
                // 更长关键词权重更高
                scores[category] += Math.max(1, Math.min(4, Math.ceil(key.length / 2)));
            }
        }
    }

    // 提示词库进资产：默认偏文本「其他」仅在完全无命中时
    let best: StandardAssetCategory | undefined;
    let bestScore = 0;
    for (const category of STANDARD_ASSET_CATEGORIES) {
        if (scores[category] > bestScore) {
            best = category;
            bestScore = scores[category];
        }
    }
    // 至少命中一个有意义关键词
    if (!best || bestScore < 2) {
        if (/prompt|提示词|文案|台词|脚本/.test(blob)) return "其他";
        return undefined;
    }
    return best;
}

/** 已有分类则保留；否则尝试智能推断。 */
export function resolveCategoryOrSuggest(existing: string | string[] | null | undefined, input: AssetCategorySuggestInput) {
    const resolved = resolveAssetCategoryForSave(existing);
    if (resolved) return resolved;
    return suggestAssetCategory(input);
}

export function isUncategorizedAsset(category?: string | null) {
    return !canonicalizeAssetCategory(category);
}
