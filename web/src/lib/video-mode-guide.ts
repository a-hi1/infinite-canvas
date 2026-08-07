/** Compact, user-facing mode guide for the video workbench banner. */

export type VideoModeGuide = {
    /** Short product label, e.g. "Grok 视频". */
    title: string;
    /** One-line what-it-does. */
    summary: string;
    /** Small chips for at-a-glance modes / limits. */
    tags?: string[];
    /** Max ~4 short practical tips. No raw API path dumps. */
    bullets?: string[];
};

/** Flatten guide to a single line (canvas / logs / legacy callers). */
export function formatVideoModeGuide(guide: VideoModeGuide) {
    const parts = [guide.title, guide.summary];
    if (guide.tags?.length) parts.push(guide.tags.join(" · "));
    if (guide.bullets?.length) parts.push(guide.bullets.join("；"));
    return parts.filter(Boolean).join(" — ");
}

export const GROK_VIDEO_MODE_GUIDE: VideoModeGuide = {
    title: "Grok 视频",
    summary: "按参考类型自动选路径，规格优先原样请求。",
    tags: ["文生", "多图 generation", "单视频 edits"],
    bullets: [
        "参考图最多 7 张，不会静默只发第一张",
        "参考视频限 1 条 · 约 1–15s · 建议 ≤40MB",
        "不要图+视频混用",
        "创建失败才会降档；结果偏低会提示，不虚标",
    ],
};

/**
 * openai2api.com 上跑 Grok 时的额外说明。
 * 本机已按主机 profile 自动适配：Grok → /video/generations；多图发完整 reference_images。
 * platform 48 仍表示后台「模型所属渠道类型」未绑 xAI/Grok。
 */
export const GROK_ON_OPENAI2API_MODE_GUIDE: VideoModeGuide = {
    title: "Grok · openai2api",
    summary: "本机只打 /video/generations；/videos/generations=404，/videos=平台 48。",
    tags: ["仅 /video/generations", "多图完整参考", "渠道类型"],
    bullets: [
        "Grok 路径仅 /v1/video/generations（不再试会 404 的 /videos/generations）",
        "多图最多 7 张，完整 reference_images，不静默只发第一张",
        "该路径仍 platform 48 → 后台把 grok-imagine-video* 绑 xAI/Grok 视频渠道类型",
        "多图也可改 Seedance（清空 modelScripts 用内置 Comfy 字段）；Grok 可另建 codex2api",
    ],
};

export const SORA_VEO_MODE_GUIDE: VideoModeGuide = {
    title: "Sora / Veo",
    summary: "支持文生与图生，不支持参考视频/音频。",
    tags: ["Sora 首帧 1 张", "Veo 参考最多 3 张"],
    bullets: [
        "请用本地可读参考图（远程 imgen 常因 CORS 读不到）",
        "Sora 秒数 4/8/12 · Veo 4/6/8",
        "sora-2 尺寸仅 1280×720 / 720×1280",
    ],
};

export const AGNES_VIDEO_MODE_GUIDE: VideoModeGuide = {
    title: "Agnes Video",
    summary: "仅纯文本生视频，不支持参考素材。",
    tags: ["1152×768", "2s / 5s"],
    bullets: ["上传参考图/视频/音频会被拦截"],
};

export const SEEDANCE_VIDEO_MODE_GUIDE: VideoModeGuide = {
    title: "Seedance",
    summary: "支持参考图与参考视频；OpenAI 中转与火山 Agent Plan 路径不同。",
    tags: ["单图 I2V", "双图首尾帧", "多图参考", "参考视频×1"],
    bullets: [
        "OpenAI2API/New API（对齐 Comfy 成功形态）：单图 images[]；2 张=首帧+尾帧；3+ 张=主图+补充参考图",
        "参考视频中转仅 1 条（顶层 video，可再加 1 张角色图）；参考音频仍需火山 Agent Plan",
        "参考视频建议 mp4/mov · H.264/H.265 · 2–15s · ≤50MB",
        "该模型若配置了本地调用脚本会绕过内置多参考，需清空脚本",
    ],
};

/** Agent Plan (火山) — multi reference_image identity path. */
export const SEEDANCE_AGENT_PLAN_MODE_GUIDE: VideoModeGuide = {
    title: "Seedance · Agent Plan",
    summary: "火山 Agent Plan 支持多参考图/视频/音频（content 全 reference_*）。",
    tags: ["多图参考", "参考视频", "参考音频"],
    bullets: [
        "参考图按 图片1/2… 编号写入提示词，可多角色/多素材同时参考",
        "参考视频 mp4/mov · 2–15s · ≤50MB；真人人脸素材请用授权 asset://",
        "参考音频可与图/视频同用，不能单独只传音频",
    ],
};

export const GENERIC_OPENAI_VIDEO_MODE_GUIDE: VideoModeGuide = {
    title: "OpenAI 视频",
    summary: "当前接口主要支持参考图。",
    tags: ["参考图"],
    bullets: ["参考视频/音频请改用 Seedance 或火山 Agent Plan"],
};
