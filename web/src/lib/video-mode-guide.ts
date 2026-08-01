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
    summary: "支持参考图、参考视频与参考音频。",
    tags: ["多模态参考"],
    bullets: ["参考视频建议 mp4/mov · H.264/H.265 · 24–60 FPS"],
};

export const GENERIC_OPENAI_VIDEO_MODE_GUIDE: VideoModeGuide = {
    title: "OpenAI 视频",
    summary: "当前接口主要支持参考图。",
    tags: ["参考图"],
    bullets: ["参考视频/音频请改用 Seedance 或火山 Agent Plan"],
};
