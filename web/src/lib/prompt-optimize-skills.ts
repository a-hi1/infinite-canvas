/**
 * 画布 / 工作台 AI 润色的内置「生产手册」。
 * 结构借鉴 Toonflow art_skills（角色/场景/道具/分镜 + 衍生一致性），
 * 但刻意做成风格无关：不锁死某一画风包，只补全可执行维度。
 */

export type PromptOptimizeIntent = "auto" | "character" | "scene" | "prop" | "storyboard" | "generic";

const CHARACTER_SKILL = `【人物/角色生产手册】
当描述像人物、角色、人像、定妆、立绘时优先遵循：
1. 身份锚点：性别/年龄段/气质/职业或身份，从原文提炼，不另编主角。
2. 可辨认特征：发型发色、五官气质、体型头身比、肤色质感、标志性细节（疤/痣/饰品仅当原文有）。
3. 着装默认态：按身份给「日常默认定妆」，颜色与材质可读；禁止无故暴露/内衣打底。
4. 一致性：若原文像设定图/多角度/四视图，写明同一人跨视角一致（特写+正/侧/背或等价表述），中性背景、柔和主光。
5. 若原文是单镜头人像：补构图景别、姿态、表情微差与光位，不要强行改成四视图。
6. 严禁：换脸式重设、与原文冲突的年龄/性别、夸张畸形肢体、无来由的现代网红脸（除非原文要求）。`;

const SCENE_SKILL = `【场景生产手册】
当描述像场景、环境、背景、室内外空间时优先遵循：
1. 空间叙事：场景服务情绪与故事，不是空背景板。
2. 纵深层次：明确前/中/后景元素与空气透视。
3. 时空：时间（晨昏昼夜）、天气/季节、光源方向与色温逻辑。
4. 材质与使用痕迹：墙地面材质、磨损/潮湿/烟火气等「被使用过」的细节（按原文世界观）。
5. 构图：机位高度、景别、引导线；避免只有扁平贴图描述。
6. 严禁：与原文时代/地点冲突的建筑服饰；无来由塞满无关现代元素。`;

const PROP_SKILL = `【道具生产手册】
当描述像道具、物件、武器、器物、产品静物时优先遵循：
1. 功能可读：造型服务用途，一眼能看懂是什么。
2. 材质纹理：金属/木/布/玉/塑料等质感与反光层次清晰。
3. 尺度：用参照或比例词暗示真实尺寸。
4. 独立陈列：若是设定/产品图，默认静物展示；非原文要求不要出现手持人物肢体。
5. 多角度：若原文像设定板，可写正/侧/背/细节特写同一物件一致。
6. 使用感：按剧情新旧程度写包浆、磨损或崭新，不无故脏污。
7. 严禁：道具变成角色主视觉；材质前后矛盾。`;

const STORYBOARD_SKILL = `【分镜/镜头生产手册】
当描述像分镜、镜头、运镜、镜头语言、故事板时优先遵循：
1. 单镜头可读：景别、机位、主体动作、环境、光影、情绪各有一句可执行信息。
2. 运动：主体动作 + 镜头运动（推拉摇移跟/固定），避免静态海报腔。
3. 连续性：若有前后帧关系，保持人物/服装/场景锚点一致。
4. 参考意识：若用户提到参考角色/场景/道具，用文字锚定特征，不吞掉这些约束。
5. 时长感：用节奏词暗示几秒内发生什么，但不编造具体秒数除非原文有。
6. 严禁：堆砌无关风格标签；丢掉镜头主体只写空氛围。`;

const IMAGE_GENERIC_SKILL = `【通用画面生产手册】
1. 主体优先，再补场景、构图、光影、色彩、材质、氛围、画质。
2. 保留用户已写风格；用户未写风格时，用克制的画质词，不要强行绑定某一动漫/写实包。
3. 信息密度高，删空话；中文为主，必要时可夹关键锚词。
4. 若同时像人物+场景，以原文重心为准，次要信息压缩为从属短语。`;

const VIDEO_GENERIC_SKILL = `【通用视频生产手册】
1. 连续运动：主体动作链清晰，避免只有静帧形容词。
2. 镜头语言：景别变化或运镜至少一项可执行。
3. 光影与节奏服务情绪；风格词与画面内容一致。
4. 图生视频时强调「保持参考主体与服装一致，只补运动与镜头」。
5. 不要写成分集剧本或旁白台词墙，除非用户在写文案。`;

const TEXT_GENERIC_SKILL = `【文本生成手册】
1. 明确目标、受众、语气、结构、必含信息与禁止项。
2. 可执行：让下游模型直接按提示产出正文，而不是再猜用途。
3. 不写成绘画镜头词，除非用户在要「提示词文案」本身。`;

const AUDIO_GENERIC_SKILL = `【音频/旁白手册】
1. 可朗读：语句通顺，节奏与情绪明确。
2. 点明用途（旁白/对白/解说）与语气，不写画面构图。
3. 避免过长从句；适合 TTS 分段呼吸。`;

const OUTPUT_CONTRACT = `【输出契约】
1. 只输出优化后的提示词正文，不要解释、标题、编号列表、markdown 代码块。
2. 保留用户原意与已点名的专有名词、风格、角色名、地点；禁止推翻原主体。
3. 不要删除用户写的关键/中文关键词；可整理语序与去重。
4. 若原文含 @ 引用、节点名、URL、storage 标记等占位，原样保留。
5. 未要求负面提示词时，不要单独输出 negative prompt 区块。`;

export function detectPromptOptimizeIntent(prompt: string, fallback: PromptOptimizeIntent = "generic"): PromptOptimizeIntent {
    const text = prompt.toLowerCase();
    const has = (re: RegExp) => re.test(prompt) || re.test(text);

    // 更具体的分镜/运镜优先
    if (has(/分镜|故事板|storyboard|镜头语言|运镜|推拉摇移|景别|首尾帧|关键镜|缓缓推进|镜头推进|镜头拉远/)) return "storyboard";
    if (has(/道具|物件|武器|兵器|器物|静物|产品图|铁锚|prop\b|item\b|weapon/)) return "prop";
    if (has(/场景|背景|环境|室内|室外|街景|风景|夜景|日景|港湾|渔港|外景|内景|landscape|environment|background|scene\b/)) return "scene";
    if (has(/人物|角色|人像|肖像|立绘|定妆|四视图|半身|全身像|女主|男主|女孩|男孩|女人|男人|老人|少女|少年|character|portrait|girl|boy|woman|man/)) return "character";
    return fallback;
}

export function resolvePromptOptimizeIntent(prompt: string, preferred?: PromptOptimizeIntent | null): PromptOptimizeIntent {
    if (preferred && preferred !== "auto") return preferred;
    return detectPromptOptimizeIntent(prompt, "generic");
}

function skillForIntent(intent: PromptOptimizeIntent) {
    switch (intent) {
        case "character":
            return CHARACTER_SKILL;
        case "scene":
            return SCENE_SKILL;
        case "prop":
            return PROP_SKILL;
        case "storyboard":
            return STORYBOARD_SKILL;
        default:
            return "";
    }
}

export type BuildOptimizeSystemPromptInput = {
    mode: "image" | "video" | "text" | "audio";
    intent?: PromptOptimizeIntent | null;
    prompt: string;
    /** 额外上下文：画布已连接素材摘要、项目备注等 */
    contextNotes?: string[];
};

/**
 * 组装润色 system prompt：模式基线 + 自动识别的内容手册 + 输出契约。
 * 不注入具体 IP/项目画风包，避免污染通用工作台。
 */
export function buildOptimizeSystemPrompt(input: BuildOptimizeSystemPromptInput) {
    const intent = resolvePromptOptimizeIntent(input.prompt, input.intent);
    const modeBase = modeBaseInstruction(input.mode);
    const modeSkill = modeSkillInstruction(input.mode);
    const intentSkill = input.mode === "image" || input.mode === "video" ? skillForIntent(intent) : "";
    const contextBlock = formatContextNotes(input.contextNotes);

    return [modeBase, modeSkill, intentSkill, contextBlock, OUTPUT_CONTRACT].filter(Boolean).join("\n\n");
}

export function describeOptimizeIntent(intent: PromptOptimizeIntent) {
    switch (intent) {
        case "character":
            return "人物/定妆";
        case "scene":
            return "场景";
        case "prop":
            return "道具";
        case "storyboard":
            return "分镜/镜头";
        case "auto":
            return "自动识别";
        default:
            return "通用";
    }
}

function modeBaseInstruction(mode: BuildOptimizeSystemPromptInput["mode"]) {
    switch (mode) {
        case "video":
            return `你是资深 AI 视频提示词优化助手，也熟悉短剧/分镜生产中的镜头写法。把用户的简短描述扩写成更准确、流畅、可执行的中文视频提示词。`;
        case "text":
            return `你是资深中文写作与提示词优化助手。把用户的简短描述扩写成更清晰、具体、可执行的中文文本生成提示词。`;
        case "audio":
            return `你是资深语音合成与旁白提示词优化助手。把用户的简短描述扩写成更清晰、可朗读、可执行的中文音频提示词。`;
        case "image":
        default:
            return `你是资深 AI 绘图提示词优化助手，也熟悉角色/场景/道具设定图的生产写法。把用户的简短描述扩写成更准确、美观、可执行的中文图片提示词。`;
    }
}

function modeSkillInstruction(mode: BuildOptimizeSystemPromptInput["mode"]) {
    switch (mode) {
        case "video":
            return `${VIDEO_GENERIC_SKILL}

字数：通常 80-240 字；信息密度高，避免空话。`;
        case "text":
            return `${TEXT_GENERIC_SKILL}

字数：通常 60-180 字；信息密度高，避免空话。`;
        case "audio":
            return `${AUDIO_GENERIC_SKILL}

字数：通常 40-160 字；信息密度高，避免空话。`;
        case "image":
        default:
            return `${IMAGE_GENERIC_SKILL}

字数：通常 80-240 字；信息密度高，避免空话。适合文生图/图生图，非视频时不要堆运镜时长术语。`;
    }
}

function formatContextNotes(notes?: string[]) {
    const items = (notes || []).map((item) => item.trim()).filter(Boolean);
    if (!items.length) return "";
    return `【附加上下文】\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n请把上下文当作约束，不要忽略，也不要逐条解释。`;
}
