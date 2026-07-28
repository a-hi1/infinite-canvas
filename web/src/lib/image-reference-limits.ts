/**
 * 图片参考图数量上限（仅应用层 UI / 内置 edits 入口）。
 * 上游中转真实能力因渠道而异；超限时由上游错误可读返回，禁止静默只发第一张。
 */

/** BYOK 内置图生图 / 工作台参考图（无自定义脚本时 requestEdit 也会校验） */
export const BYOK_IMAGE_REFERENCE_LIMIT = 6;

/** 平台积分图生图（与 api PLATFORM_IMAGE_REF_LIMIT 对齐，勿单独抬高前端） */
export const PLATFORM_IMAGE_REFERENCE_LIMIT = 4;

/** 自定义调用脚本：与 BYOK 同上限，由脚本自行决定如何消费 */
export const SCRIPT_IMAGE_REFERENCE_LIMIT = BYOK_IMAGE_REFERENCE_LIMIT;

export function resolveImageReferenceLimit(options: { platform?: boolean; script?: boolean }) {
    if (options.platform) return PLATFORM_IMAGE_REFERENCE_LIMIT;
    if (options.script) return SCRIPT_IMAGE_REFERENCE_LIMIT;
    return BYOK_IMAGE_REFERENCE_LIMIT;
}
