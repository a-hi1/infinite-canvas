import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

/**
 * OpenAI Videos 兼容路径（Sora / 中转 Veo）的字段约束。
 *
 * 对齐 New API（QuantumNous）与常见 OpenAI 兼容中转：
 * - Sora adaptor：ValidateMultipartDirect 要求 sora-2 尺寸仅 720x1280 / 1280x720；
 *   sora-2-pro 另可 1792x1024 / 1024x1792；默认 size=720x1280、seconds=4。
 * - 创建转发：JSON 与 multipart 都支持；上游非 200 时网关包装为 fail_to_fetch_task。
 * - 文生优先 JSON（少踩 multipart 重建边界问题）。
 * - 图生：multipart `input_reference` 文件 + JSON `images`/`input_reference`/URL 字段；
 *   **有用户参考时禁止无参考文生回退**（避免 HTTP 成功但结果不跟图）。
 *
 * 本模块只服务 Sora/Veo；Grok/Seedance/Agnes 与通用 OpenAI 兼容路径保持原样。
 */

/** sora-2 官方/New API 允许的尺寸 */
export const SORA2_SIZE_OPTIONS = [
    { value: "1280x720", label: "横屏 720p" },
    { value: "720x1280", label: "竖屏 720p" },
] as const;

/** sora-2-pro 额外高清尺寸 */
export const SORA2_PRO_EXTRA_SIZE_OPTIONS = [
    { value: "1792x1024", label: "横屏 高清" },
    { value: "1024x1792", label: "竖屏 高清" },
] as const;

export const SORA_SIZE_OPTIONS = [...SORA2_SIZE_OPTIONS, ...SORA2_PRO_EXTRA_SIZE_OPTIONS] as const;

export const SORA_SECONDS_OPTIONS = [4, 8, 12] as const;

/** Veo 经 OpenAI 兼容中转时常见像素尺寸；比例会映射到这里。 */
export const VEO_SIZE_OPTIONS = [
    { value: "1280x720", label: "横屏 16:9" },
    { value: "720x1280", label: "竖屏 9:16" },
    { value: "1024x1024", label: "方形 1:1" },
] as const;

export const VEO_SECONDS_OPTIONS = [4, 6, 8] as const;

/** Sora 图生通常只吃首帧；多图会被忽略或拒收。 */
export const SORA_REFERENCE_LIMITS = {
    images: 1,
    imageMaxBytes: 20 * 1024 * 1024,
} as const;

/** Veo 3.1 等经 OpenAI 兼容中转时，常见最多 3 张参考图（JSON images / reference_images）。 */
export const VEO_REFERENCE_LIMITS = {
    images: 3,
    imageMaxBytes: 20 * 1024 * 1024,
} as const;

/**
 * 兼容旧导入：默认按 Sora 1 张。
 * 新代码请用 {@link soraVeoReferenceImageLimit} / {@link VEO_REFERENCE_LIMITS}。
 */
export const SORA_VEO_REFERENCE_LIMITS = {
    images: SORA_REFERENCE_LIMITS.images,
    veoImages: VEO_REFERENCE_LIMITS.images,
    imageMaxBytes: SORA_REFERENCE_LIMITS.imageMaxBytes,
} as const;

/** 按模型返回图生参考图张数上限：Sora=1，Veo=3。 */
export function soraVeoReferenceImageLimit(model: string): number {
    const name = modelOptionName(model);
    // 纯 Veo（含 veo-*-i2v）支持多参考；Sora / azure-sora 仍只吃首帧
    if (isVeoVideoModel(name) && !isSoraVideoModel(name)) return VEO_REFERENCE_LIMITS.images;
    if (isSoraVideoModel(name)) return SORA_REFERENCE_LIMITS.images;
    if (isVeoVideoModel(name)) return VEO_REFERENCE_LIMITS.images;
    return SORA_REFERENCE_LIMITS.images;
}

export function soraVeoReferenceImageMaxBytes(model: string): number {
    void model;
    return SORA_REFERENCE_LIMITS.imageMaxBytes;
}

const SORA2_SIZE_SET = new Set<string>(SORA2_SIZE_OPTIONS.map((item) => item.value));
const SORA_PRO_SIZE_SET = new Set<string>([...SORA2_SIZE_SET, ...SORA2_PRO_EXTRA_SIZE_OPTIONS.map((item) => item.value)]);
const VEO_SIZE_SET = new Set<string>(VEO_SIZE_OPTIONS.map((item) => item.value));

export function isSoraVideoModel(model: string) {
    const value = modelOptionName(model).toLowerCase();
    // azure-sora / sora-2 / sora-2-pro 等；排除无关串（当前无）
    return value.includes("sora");
}

export function isSora2ProModel(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return value.includes("sora") && value.includes("pro");
}

/** Azure OpenAI 中转上的 Sora 视频模型名（部分网关 VIDEO 端点只认这个，不认 sora-2）。 */
export function isAzureSoraModel(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return value.includes("azure-sora") || value === "azure_sora";
}

/**
 * 渠道「拉取模型」常只返回 sora-2，但 openai2api 一类 VIDEO 端点有时要 azure-sora。
 * 在本地模型列表里补上可选别名，方便用户勾选；真正请求时**先发用户选择**，422/无渠道再回退 azure-sora。
 * 不删除上游返回的任何名字。
 */
export function withSoraRelayModelAliases(models: string[]): string[] {
    const cleaned = models.map((item) => String(item || "").trim()).filter(Boolean);
    if (!cleaned.length) return cleaned;

    const lower = cleaned.map((item) => modelOptionName(item).toLowerCase());
    const hasClassicSora = lower.some((item) => item === "sora-2" || item.startsWith("sora-2") || item === "sora");
    const hasClassicSoraPro = lower.some((item) => (item.includes("sora") && item.includes("pro") && !item.includes("azure")) || item === "sora-2-pro");
    const hasAzure = lower.some((item) => item.includes("azure-sora") || item === "azure_sora");
    const hasAzurePro = lower.some((item) => item.includes("azure-sora") && item.includes("pro"));

    const next = [...cleaned];
    const push = (name: string) => {
        if (next.some((item) => modelOptionName(item).toLowerCase() === name.toLowerCase())) return;
        next.push(name);
    };

    // 有 sora-2 系列但没有 azure 别名 → 补 azure-sora，便于 UI 勾选
    if (hasClassicSora && !hasAzure) push("azure-sora");
    if (hasClassicSoraPro && !hasAzurePro) push("azure-sora-pro");
    return next;
}

/**
 * 部分中转（如 openai2api / Azure 视频网关）的 ModelModality.VIDEO
 * 只接受 `azure-sora` / `firefly-video` / `kling*`，直接发 `sora-2` 会 422 validation_error。
 *
 * 规则：
 * - 用户已选渠道列表里真实存在的名字 → 不改
 * - 选了 sora-2 / sora-2-pro，但列表里没有该名、却有 azure-sora* → 映射过去
 * - 列表完全没有可用别名 → 原样返回（请求层再试候选 / 报错提示）
 */
export function preferSoraRelayModelName(selectedModelName: string, channelModels: string[]): string {
    const fromName = modelOptionName(selectedModelName).trim();
    if (!fromName || !isSoraVideoModel(fromName)) return fromName;

    const inventory = channelModels.map((item) => modelOptionName(item).trim()).filter(Boolean);
    if (!inventory.length) return fromName;

    const fromLower = fromName.toLowerCase();
    const inventoryLower = inventory.map((item) => item.toLowerCase());
    // 渠道清单里已有用户所选原名 → 保留
    if (inventoryLower.includes(fromLower)) return fromName;

    const pick = (pred: (n: string) => boolean) => {
        const idx = inventoryLower.findIndex(pred);
        return idx >= 0 ? inventory[idx] : "";
    };

    if (fromLower.includes("pro")) {
        return (
            pick((n) => n.includes("azure-sora") && n.includes("pro")) ||
            pick((n) => n === "azure-sora-pro" || n === "azure_sora_pro") ||
            pick((n) => n.includes("azure-sora")) ||
            pick((n) => n.includes("sora") && n.includes("pro")) ||
            fromName
        );
    }

    return (
        pick((n) => n === "azure-sora" || n === "azure_sora") ||
        pick((n) => n.includes("azure-sora") && !n.includes("pro")) ||
        pick((n) => n.includes("azure-sora")) ||
        // 列表里其它 sora 视频名（排除用户已失败的 sora-2 原名）
        pick((n) => n.includes("sora") && n !== fromLower) ||
        fromName
    );
}

/**
 * Sora 请求时的 model 名候选。
 *
 * 规则（用户上游常就叫 sora-2）：
 * 1. **永远先发用户当前选择**（sora-2 / sora-2-pro / azure-sora …）
 * 2. 再把 azure-sora* 等别名放进后续候选：仅当首发 422 ModelModality / 503 无渠道时才换名重试
 * 3. 不改 Veo / Grok / Seedance / Agnes
 *
 * 历史背景：部分 openai2api 网关 VIDEO 白名单只认 azure-sora；但用户确认上游就叫 sora-2 时，
 * 强制先发 azure-sora 会误伤（503 无渠道）。故改为「选择优先 + 别名回退」。
 */
export function soraRequestModelCandidates(selectedModelName: string, channelModels: string[] = []): string[] {
    const fromName = modelOptionName(selectedModelName).trim();
    if (!fromName) return [];
    if (!isSoraVideoModel(fromName)) return [fromName];

    const fromLower = fromName.toLowerCase();
    const inventory = channelModels.map((item) => modelOptionName(item).trim()).filter(Boolean);
    const preferred = preferSoraRelayModelName(fromName, inventory);
    const list: string[] = [];
    const push = (name: string) => {
        const value = modelOptionName(name).trim();
        if (!value) return;
        if (list.some((item) => item.toLowerCase() === value.toLowerCase())) return;
        list.push(value);
    };

    const looksLikeOpenAiSoraId =
        /^sora([-_.]|$)/i.test(fromName) || fromLower === "sora-2" || fromLower.startsWith("sora-2") || fromLower === "sora";
    const alreadyAzure = isAzureSoraModel(fromName);

    // 1) 用户选择永远第一
    push(fromName);

    if (alreadyAzure) {
        // 用户选 azure-sora*：再带清单里其它 sora 名作兜底
        for (const item of inventory) {
            if (isSoraVideoModel(item) || isAzureSoraModel(item)) push(item);
        }
        if (!list.some((item) => item.toLowerCase() === "sora-2")) push("sora-2");
        return list;
    }

    // 2) 经典 sora-2*：azure 别名仅作后续回退（422/无渠道时 create 循环会换到）
    if (looksLikeOpenAiSoraId) {
        if (preferred && preferred.toLowerCase() !== fromLower && isAzureSoraModel(preferred)) push(preferred);
        if (fromLower.includes("pro")) {
            push("azure-sora-pro");
            push("azure-sora");
        } else {
            push("azure-sora");
            push("azure_sora");
        }
        for (const item of inventory) {
            if (isSoraVideoModel(item) || isAzureSoraModel(item)) push(item);
        }
        return list;
    }

    // 3) 其它 sora 变体：选择优先，再 azure / 清单兜底
    if (preferred && preferred.toLowerCase() !== fromLower) push(preferred);
    push("azure-sora");
    for (const item of inventory) {
        if (isSoraVideoModel(item) || isAzureSoraModel(item)) push(item);
    }
    return list;
}

/** 从 422 validation 文案里抠 Supported models 列表（兼容未闭合括号的截断响应） */
export function parseSupportedVideoModelsFromError(errorText: string): string[] {
    const text = String(errorText || "");
    // 完整: Supported models: ['azure-sora', 'kling']
    // 截断: Supported models: ['azure-sora', 'firefly-video', 'kling', 'kling' (status=422)
    const match =
        text.match(/Supported models:\s*\[([^\]]*)\]/i) ||
        text.match(/Supported models:\s*\[([^\n\r]*)/i) ||
        text.match(/supported models[:：]\s*([^\n\r]+)/i);
    if (!match) return [];
    const raw = match[1] || "";
    return Array.from(
        new Set(
            raw
                .split(/[,，]/)
                .map((item) =>
                    item
                        .replace(/^[\s'"`\[]+|[\s'"`\]\)]+$/g, "")
                        .replace(/\(status=\d+\)/gi, "")
                        .trim(),
                )
                .filter((item) => item && !/^(status|error|message|validation)/i.test(item)),
        ),
    );
}

export function isUnsupportedVideoModelError(error: unknown) {
    const blob = collectErrorBlob(error);
    if (!blob) return false;
    // openai2api 原文：sora sora-2 is not supported for ModelModality.VIDEO endpoint. Supported models: ['azure-sora', ...]
    // 以及 video submit failed: 422 {...}
    if (
        /not supported for modelmodality\.video|not supported for.*video endpoint|modelmodality\.video|unsupported model|model .* is not supported|模型不支持|不支持该模型|is not supported for/i.test(
            blob,
        )
    ) {
        return true;
    }
    if (/validation_error/i.test(blob) && (/modelmodality|supported models|sora-2|not supported/i.test(blob) || /\b422\b|status=422/i.test(blob))) {
        return true;
    }
    if (parseSupportedVideoModelsFromError(blob).length && /not supported|validation_error|422|modelmodality|video submit failed/i.test(blob)) {
        return true;
    }
    // 短 message 只剩「video submit failed: 422」+ 片段时也要认
    if (/video submit failed/i.test(blob) && (/\b422\b|status=422|modelmodality|supported models|sora-2/i.test(blob))) {
        return true;
    }
    return false;
}

/**
 * 中转网关「模型名被 VIDEO 端点接受，但当前分组下没有绑定可用上游」——常见 503。
 * 例：分组 veo-sora 下模型 azure-sora 无可用渠道（distributor）
 *
 * 与 ModelModality 422 不同：改 body 字段无用；应换模型别名再试一轮，最终仍要用户在后台绑渠道。
 */
export function isUnavailableVideoChannelError(error: unknown) {
    const blob = collectErrorBlob(error);
    if (
        /无可用渠道|no available channel|no channel|channel not found|未配置渠道|无渠道|distributor|invalid api platform|group not|分组.*无可用|model.*no.*channel|upstream.*(down|unavailable)/i.test(
            blob,
        )
    ) {
        return true;
    }
    // 纯 503 + 渠道/分组语义
    if (/\b503\b|service unavailable|status=503/i.test(blob) && /渠道|channel|group|分组|distributor|upstream/i.test(blob)) {
        return true;
    }
    return false;
}

/** 应立刻换下一个 Sora/Veo 模型名，不要继续穷举同一模型的 body 变体 */
export function shouldSkipToNextVideoModelName(error: unknown) {
    return isUnsupportedVideoModelError(error) || isUnavailableVideoChannelError(error);
}

/**
 * 中转把请求转到上游后，上游拒收 body 的常见包装：
 * - 直接 `invalid request body` / `invalid_request_error`
 * - New API 外层 `fail_to_fetch_task`（内层再包 invalid body 或仅 code）
 * - size / seconds / media type 等字段校验失败
 *
 * 命中后应换 body 候选；整路径穷举仍命中时再换 create path。
 * 不匹配鉴权/额度/Grok 账号类错误，避免误把无关失败当 body 重试。
 */
export function isInvalidVideoRequestBodyError(error: unknown) {
    const blob = collectErrorBlob(error);
    if (!blob) return false;
    // 明确不是 body 问题
    if (/401|unauthorized|403|forbidden|insufficient.?quota|billing|no eligible grok|rate.?limit|429/i.test(blob) && !/invalid request body|invalid_request_error|invalid_size|fail_to_fetch_task/i.test(blob)) {
        return false;
    }
    if (/invalid request body|invalid_request_error|invalid_size|unsupported media type|\b415\b|size is invalid|seconds is invalid|invalid duration|invalid parameter|parameter.?invalid|request body|malformed|unprocessable/i.test(blob)) {
        return true;
    }
    // 单独 fail_to_fetch_task：New API 常见「上游拒收后包装」；创建阶段当作 body/路径兼容重试信号
    if (/fail_to_fetch_task/i.test(blob)) return true;
    return false;
}

export function isVeoVideoModel(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return value.includes("veo");
}

export function isVeoI2vModel(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return isVeoVideoModel(value) && (value.includes("i2v") || value.includes("image-to-video") || value.includes("img2video"));
}

export function isSoraOrVeoVideoModel(model: string) {
    return isSoraVideoModel(model) || isVeoVideoModel(model);
}

export function isSoraOrVeoVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return isSoraOrVeoVideoModel(modelOptionName(requestConfig.model || requestConfig.videoModel));
}

export function isSoraVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return isSoraVideoModel(modelOptionName(requestConfig.model || requestConfig.videoModel));
}

export function isVeoVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return isVeoVideoModel(modelOptionName(requestConfig.model || requestConfig.videoModel));
}

/** Sora 秒数：4 / 8 / 12；空回退 8（比 New API 默认 4 更接近本站通用默认）。 */
export function normalizeSoraSeconds(value: string) {
    const raw = String(value ?? "").trim();
    const seconds = raw === "" || !Number.isFinite(Number(raw)) ? 8 : Math.floor(Number(raw));
    if ((SORA_SECONDS_OPTIONS as readonly number[]).includes(seconds)) return String(seconds);
    if (seconds <= 5) return "4";
    if (seconds <= 10) return "8";
    return "12";
}

/** Veo 中转常见 4/6/8；空回退 6。 */
export function normalizeVeoSeconds(value: string) {
    const raw = String(value ?? "").trim();
    const seconds = raw === "" || !Number.isFinite(Number(raw)) ? 6 : Math.floor(Number(raw));
    if ((VEO_SECONDS_OPTIONS as readonly number[]).includes(seconds)) return String(seconds);
    if (seconds <= 5) return "4";
    if (seconds <= 7) return "6";
    return "8";
}

export function soraSizeOptionsForModel(model: string) {
    return isSora2ProModel(model) ? SORA_SIZE_OPTIONS : SORA2_SIZE_OPTIONS;
}

/**
 * Sora 尺寸：sora-2 仅 720x1280 / 1280x720（New API 硬校验）；
 * sora-2-pro 另可 1792x1024 / 1024x1792。非法值落到 1280x720。
 */
export function normalizeSoraSize(value: string, model = "") {
    const raw = String(value || "").trim();
    const pro = isSora2ProModel(model);
    const allowed = pro ? SORA_PRO_SIZE_SET : SORA2_SIZE_SET;
    if (allowed.has(raw)) return raw;
    // pro 高清尺寸在 sora-2 上降到对应 720 档
    if (!pro && (raw === "1792x1024" || raw === "1920x1080")) return "1280x720";
    if (!pro && (raw === "1024x1792" || raw === "1080x1920")) return "720x1280";
    if (raw === "auto" || raw === "adaptive" || raw === "1:1") return "1280x720";
    if (raw === "9:16" || raw === "2:3" || raw === "3:4") return "720x1280";
    if (raw === "16:9" || raw === "4:3" || raw === "21:9") return "1280x720";
    const match = raw.match(/^(\d+)x(\d+)$/);
    if (!match) return "1280x720";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return "1280x720";
    const ratio = width / height;
    if (Math.abs(ratio - 1) < 0.08) return "1280x720";
    return ratio < 1 ? "720x1280" : "1280x720";
}

export function normalizeVeoSize(value: string) {
    const raw = String(value || "").trim();
    if (VEO_SIZE_SET.has(raw)) return raw;
    if (raw === "auto" || raw === "adaptive") return "1280x720";
    if (raw === "9:16" || raw === "2:3" || raw === "3:4") return "720x1280";
    if (raw === "1:1") return "1024x1024";
    if (raw === "16:9" || raw === "4:3" || raw === "21:9") return "1280x720";
    const match = raw.match(/^(\d+)x(\d+)$/);
    if (!match) return "1280x720";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return "1280x720";
    const ratio = width / height;
    if (Math.abs(ratio - 1) < 0.08) return "1024x1024";
    return ratio < 1 ? "720x1280" : "1280x720";
}

export type SoraVeoRequestEncoding = "json" | "multipart";

/**
 * 参考图如何挂到请求上：
 * - file：multipart 文件字段 `input_reference`（Sora 官方 / New API Sora 转发）
 * - images：JSON `images: [dataUrl|url]`（New API Veo/Gemini ParseImageInput）
 * - input_reference：JSON 字符串 `input_reference`
 * - image：JSON 单图字段 `image`
 * - image_url：JSON `image_url`（部分中转）
 * - first_frame：JSON `first_frame`（部分 I2V 中转）
 * - reference_image：JSON `reference_image`
 * - reference_images：JSON `reference_images: [...]`
 */
export type SoraVeoReferenceField =
    | "file"
    | "images"
    | "input_reference"
    | "image"
    | "image_url"
    | "first_frame"
    | "reference_image"
    | "reference_images";

/** 字段是否适合一次发送多张参考图（数组语义）。单值字段多图时只发第一张。 */
export function isMultiImageSoraVeoReferenceField(field: SoraVeoReferenceField | undefined): boolean {
    return field === "images" || field === "reference_images";
}

export type OpenAiCompatibleVideoFieldSet = {
    /** 用于诊断/测试的标签 */
    label: string;
    encoding: SoraVeoRequestEncoding;
    model: string;
    prompt: string;
    /** OpenAI / New API：seconds 为字符串枚举；部分中转要 number */
    seconds: string;
    /** true 时 JSON 发 number；multipart 仍是文本字段但值相同 */
    secondsAsNumber?: boolean;
    /** 少数中转用 duration 代替 seconds */
    durationField?: "seconds" | "duration";
    size?: string;
    /** 是否附带参考图；有用户参考时必须为 true，禁止静默文生回退 */
    withReferences: boolean;
    /** 有参考时如何编码；无参考时忽略 */
    referenceField?: SoraVeoReferenceField;
    /**
     * 参考素材形态：
     * - binary：需要本地可读 File / data URI（multipart 必须）
     * - url：允许公网 https 字符串（仅 JSON）
     * - either：data URI 优先，否则公网 URL
     */
    referenceSource?: "binary" | "url" | "either";
    /** multipart 文件字段名；默认 input_reference */
    multipartFileField?: "input_reference" | "image" | "file" | "first_frame";
};

/**
 * 有参考图时，在同渠道列表里优先切到 Veo I2V 变体（veo-*-i2v）。
 * - 已是 i2v：不改
 * - Sora：通常同一模型兼文生/图生，不改
 * - 无对应 i2v：保留用户选择（仍可走 input_reference 图生）
 */
export function preferVeoI2vModelName(selectedModelName: string, channelModels: string[]): string {
    const fromName = modelOptionName(selectedModelName).trim();
    const fromLower = fromName.toLowerCase();
    if (!isVeoVideoModel(fromName) || isVeoI2vModel(fromName)) return fromName;

    const inventory = channelModels.map((item) => modelOptionName(item).trim()).filter(Boolean);
    const inventoryLower = inventory.map((item) => item.toLowerCase());

    const stripI2v = (name: string) =>
        name
            .toLowerCase()
            .replace(/[-_]?image[-_]?to[-_]?video/g, "")
            .replace(/[-_]?img2video/g, "")
            .replace(/[-_]?i2v/g, "")
            .replace(/[-_]+$/g, "");

    const base = stripI2v(fromLower);
    // 1) 同前缀 + i2v（veo-3.1 -> veo-3.1-i2v；veo-3.1-fast -> veo-3.1-fast-i2v）
    const exactIdx = inventoryLower.findIndex((name) => isVeoI2vModel(name) && stripI2v(name) === base);
    if (exactIdx >= 0) return inventory[exactIdx];

    // 2) 共享主版本的 i2v（veo-3.1-fast -> veo-3.1-i2v）
    const version = fromLower.match(/veo[-_.]?(\d+(?:\.\d+)?)/i)?.[1] || "";
    if (version) {
        const versionIdx = inventoryLower.findIndex((name) => isVeoI2vModel(name) && name.includes(version));
        if (versionIdx >= 0) return inventory[versionIdx];
    }

    // 3) 任意 veo i2v
    const anyIdx = inventoryLower.findIndex((name) => isVeoI2vModel(name));
    if (anyIdx >= 0) return inventory[anyIdx];

    return fromName;
}

/**
 * 为 Sora/Veo 生成请求候选（不含 resolution_name / preset）。
 *
 * 顺序原则（对齐 New API + 上游常见坑）：
 * 1. 文生：JSON 完整 → 最小字段 → 数字 seconds / duration 变体 → multipart
 * 2. 图生：**只**返回带参考的候选。
 *    - Sora：multipart 文件优先（含字段名变体），再精简 JSON
 *    - Veo：JSON images 优先（Gemini 中转），再 multipart / 其它字段
 *    **禁止**无参考文生候选：否则 multipart 图生 invalid body 后会静默变成纯文生成功。
 *
 * 针对中转包装 `fail_to_fetch_task` + 上游 `invalid request body`：用更多最小 body 穷举，
 * 不改 Grok/Seedance/Agnes。
 */
export function buildSoraVeoFormFieldCandidates(opts: {
    model: string;
    prompt: string;
    size: string;
    videoSeconds: string;
    hasReferences: boolean;
    /** 是否具备本地可读二进制（File/data URI）。仅有公网 URL 时为 false。 */
    hasBinaryReference?: boolean;
    /** 是否具备公网 https 参考图 URL（上游可拉）。 */
    hasUrlReference?: boolean;
    /** 实际参考图张数；Veo 多图时优先 images / reference_images 数组字段。 */
    referenceCount?: number;
}): OpenAiCompatibleVideoFieldSet[] {
    const modelName = modelOptionName(opts.model).trim();
    const prompt = opts.prompt;
    const sora = isSoraVideoModel(modelName);
    const veo = isVeoVideoModel(modelName);
    const seconds = sora ? normalizeSoraSeconds(opts.videoSeconds) : normalizeVeoSeconds(opts.videoSeconds);
    const size = sora ? normalizeSoraSize(opts.size, modelName) : normalizeVeoSize(opts.size);
    const hasBinary = opts.hasBinaryReference ?? opts.hasReferences;
    const hasUrl = opts.hasUrlReference ?? false;
    const referenceCount = Math.max(0, opts.referenceCount ?? (opts.hasReferences ? 1 : 0));
    const multiImage = veo && !sora && referenceCount > 1;

    if (opts.hasReferences) {
        // 图生：禁止夹带 withReferences:false 的文生候选（否则先失败再“成功”纯文生）。
        const multipartFile: OpenAiCompatibleVideoFieldSet[] = hasBinary
            ? sora && !veo
                ? [
                      // Sora 官方/OpenAI：multipart input_reference 文件
                      { label: "multipart:input_reference+seconds+size", encoding: "multipart", model: modelName, prompt, seconds, size, withReferences: true, referenceField: "file", referenceSource: "binary", multipartFileField: "input_reference" },
                      { label: "multipart:input_reference+seconds", encoding: "multipart", model: modelName, prompt, seconds, withReferences: true, referenceField: "file", referenceSource: "binary", multipartFileField: "input_reference" },
                      { label: "multipart:input_reference-only", encoding: "multipart", model: modelName, prompt, seconds: "4", withReferences: true, referenceField: "file", referenceSource: "binary", multipartFileField: "input_reference" },
                      { label: "multipart:image+seconds+size", encoding: "multipart", model: modelName, prompt, seconds, size, withReferences: true, referenceField: "file", referenceSource: "binary", multipartFileField: "image" },
                      { label: "multipart:file+seconds", encoding: "multipart", model: modelName, prompt, seconds, withReferences: true, referenceField: "file", referenceSource: "binary", multipartFileField: "file" },
                      { label: "multipart:first_frame+seconds", encoding: "multipart", model: modelName, prompt, seconds, withReferences: true, referenceField: "file", referenceSource: "binary", multipartFileField: "first_frame" },
                  ]
                : [
                      { label: "multipart:seconds+size+ref", encoding: "multipart", model: modelName, prompt, seconds, size, withReferences: true, referenceField: "file", referenceSource: "binary", multipartFileField: "input_reference" },
                      { label: "multipart:seconds-only+ref", encoding: "multipart", model: modelName, prompt, seconds, withReferences: true, referenceField: "file", referenceSource: "binary", multipartFileField: "input_reference" },
                  ]
            : [];

        const jsonBinaryOrEither = (
            field: SoraVeoReferenceField,
            label: string,
            withSize: boolean,
            extra?: Partial<OpenAiCompatibleVideoFieldSet>,
        ): OpenAiCompatibleVideoFieldSet => ({
            label,
            encoding: "json",
            model: modelName,
            prompt,
            seconds,
            ...(withSize ? { size } : {}),
            withReferences: true,
            referenceField: field,
            // JSON：本地 data URI 与公网 URL 都可；优先 either，方便统一编码
            referenceSource: hasBinary ? (hasUrl ? "either" : "binary") : "url",
            ...extra,
        });

        // Veo 多图：优先 images / reference_images；单值字段仍作兼容（只发第一张）
        // Sora 图生 JSON 兜底：少而精，避免巨型 data URI 数组先把中转打崩
        const jsonFields: SoraVeoReferenceField[] =
            sora && !veo
                ? ["input_reference", "image", "images", "first_frame"]
                : multiImage
                  ? ["images", "reference_images", "input_reference", "image", "image_url", "first_frame", "reference_image"]
                  : ["images", "input_reference", "image", "image_url", "first_frame", "reference_image", "reference_images"];
        const jsonSized = jsonFields.map((field) => jsonBinaryOrEither(field, `json:seconds+size+${field}`, true));
        const jsonSecondsOnly = (sora && !veo
            ? (["input_reference", "image"] as SoraVeoReferenceField[])
            : multiImage
              ? (["images", "reference_images", "input_reference", "image"] as SoraVeoReferenceField[])
              : (["images", "input_reference", "image", "image_url"] as SoraVeoReferenceField[])
        ).map((field) => jsonBinaryOrEither(field, `json:seconds-only+${field}`, false));
        const soraJsonExtras: OpenAiCompatibleVideoFieldSet[] =
            sora && !veo && (hasBinary || hasUrl)
                ? [
                      jsonBinaryOrEither("input_reference", "json:num-seconds+size+input_reference", true, { secondsAsNumber: true }),
                      jsonBinaryOrEither("image", "json:num-seconds+image", false, { secondsAsNumber: true }),
                      jsonBinaryOrEither("input_reference", "json:duration+size+input_reference", true, { durationField: "duration" }),
                  ]
                : [];

        // 仅当确实有 binary 或 url 时保留 JSON 候选
        const jsonCandidates = hasBinary || hasUrl ? [...jsonSized, ...jsonSecondsOnly, ...soraJsonExtras] : [];

        // Sora：官方/New API 更吃 multipart 文件；Veo(Gemini)：更吃 JSON images。
        // Veo 多图：JSON 数组必须优先于 multipart 首帧。
        if (sora && !veo) {
            return [...multipartFile, ...jsonCandidates];
        }
        if (veo && !sora) {
            return [...jsonCandidates, ...multipartFile];
        }
        // 名称同时命中时（极少）：multipart 优先
        return [...multipartFile, ...jsonCandidates];
    }

    // 文生：JSON 优先（New API 原样改 model 转发；少踩 multipart 重建）
    // 对齐可用脚本 veo-sora：首包仅 {model,prompt,seconds}，不要先塞 size（中转常因 size 触发 invalid body）
    // Sora 额外：数字 seconds / duration / 仅 model+prompt —— 应对 fail_to_fetch_task + invalid request body
    if (sora && !veo) {
        return [
            // 与参考脚本一致：model + prompt + seconds（字符串）
            { label: "json:seconds-only", encoding: "json", model: modelName, prompt, seconds, withReferences: false },
            { label: "json:num-seconds-only", encoding: "json", model: modelName, prompt, seconds, withReferences: false, secondsAsNumber: true },
            { label: "json:seconds+size", encoding: "json", model: modelName, prompt, seconds, size, withReferences: false },
            { label: "json:num-seconds+size", encoding: "json", model: modelName, prompt, seconds, size, withReferences: false, secondsAsNumber: true },
            { label: "json:duration-only", encoding: "json", model: modelName, prompt, seconds, withReferences: false, durationField: "duration" },
            { label: "json:duration+size", encoding: "json", model: modelName, prompt, seconds, size, withReferences: false, durationField: "duration" },
            // 部分中转只接受 model+prompt，size/seconds 由上游默认
            { label: "json:model+prompt", encoding: "json", model: modelName, prompt, seconds: "", withReferences: false },
            { label: "multipart:seconds-only", encoding: "multipart", model: modelName, prompt, seconds, withReferences: false },
            { label: "multipart:seconds+size", encoding: "multipart", model: modelName, prompt, seconds, size, withReferences: false },
            { label: "multipart:model+prompt", encoding: "multipart", model: modelName, prompt, seconds: "", withReferences: false },
        ];
    }

    // Veo 文生：同样优先最小 seconds-only（与参考脚本一致），再补 size
    return [
        { label: "json:seconds-only", encoding: "json", model: modelName, prompt, seconds, withReferences: false },
        { label: "json:seconds+size", encoding: "json", model: modelName, prompt, seconds, size, withReferences: false },
        { label: "json:num-seconds-only", encoding: "json", model: modelName, prompt, seconds, withReferences: false, secondsAsNumber: true },
        { label: "multipart:seconds-only", encoding: "multipart", model: modelName, prompt, seconds, withReferences: false },
        { label: "multipart:seconds+size", encoding: "multipart", model: modelName, prompt, seconds, size, withReferences: false },
    ];
}

/** @deprecated 名称保留给旧测试/导出；语义同 buildSoraVeoFormFieldCandidates */
export const buildSoraVeoRequestCandidates = buildSoraVeoFormFieldCandidates;

/**
 * Sora/Veo 创建任务路径候选。
 * 实测可用脚本（veo-sora）：POST `${base}/v1/video/generations` + `{model,prompt,seconds}`。
 * 官方 OpenAI Videos 仍是 /videos；另保留 /videos/generations 兜底。
 * 仅用于 Sora/Veo，不改 Grok 路径表。
 */
export function soraVeoCreatePathCandidates(): string[] {
    // 中转（openai2api / New API 类）优先 /video/generations；官方 /videos 次之
    return ["/video/generations", "/videos", "/videos/generations"];
}

/** 路径本身不存在 / 方法不对：应立刻换下一条路径，不要继续刷 body */
export function isMissingSoraVeoCreatePathError(error: unknown) {
    const blob = collectErrorBlob(error);
    // 任务级 404 / fail_to_fetch 不是“路径不存在”，不能用来负缓存整条 create path
    if (/task|request_id|job|fail_to_fetch|video not found|generation not found/i.test(blob) && !/invalid url|no route|path not found|method not allowed|page not found|cannot post/i.test(blob)) {
        return false;
    }
    if (/invalid url|no route|path not found|method not allowed|404 page not found|cannot post|not found\s*$/i.test(blob)) {
        return true;
    }
    // axios 404/405：创建阶段的路由缺失（含空 body / 极简文案）
    if (typeof error === "object" && error && "response" in error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status === 404 || status === 405) {
            // 有明确“任务不存在”语义时不把整条路径打成 missing
            if (/task|request_id|job|fail_to_fetch|video not found|generation not found/i.test(blob)) return false;
            return true;
        }
    }
    return false;
}

/**
 * 当前路径上 body 穷举仍 invalid / fail_to_fetch_task 时，值得换另一条创建路径再试
 * （有的中转 /videos 走 OpenAI Sora adaptor 拒 body，/video/generations 走另一套协议能通）
 */
export function shouldTryNextSoraVeoCreatePath(error: unknown) {
    return isMissingSoraVeoCreatePathError(error) || isInvalidVideoRequestBodyError(error);
}

export const soraVeoModeHint =
    "Sora / Veo（OpenAI 兼容）：支持文生与图生视频。Sora 图生 1 张首帧；Veo 3.1 最多 3 张参考图。创建优先 /video/generations + 最小 body {model,prompt,seconds}，再回退 /videos、/videos/generations。远程 imgen 图常因 CORS 读不到。不支持参考视频/音频。Sora 秒数 4/8/12，Veo 4/6/8；sora-2 尺寸仅 1280x720/720x1280。";

export const soraVideoModeHint =
    "Sora：文生优先 JSON 最小字段 {model,prompt,seconds}（对齐可用脚本 /video/generations）；图生走 multipart `input_reference` 或 JSON images，仅 1 张首帧。秒数 4/8/12。路径优先 /video/generations，再 /videos。部分中转 VIDEO 端点只认 azure-sora——请求会先发你选的 sora-2，再回退 azure-sora。";

export const veoVideoModeHint =
    "Veo（OpenAI 兼容中转）：文生优先 /video/generations + {model,prompt,seconds}；图生优先 JSON `images`/`reference_images`，最多 3 张参考图，并尽量选用 veo-*-i2v。秒数 4/6/8。请用本地可读参考图。";

function readErrorText(error: unknown): string {
    if (!error) return "";
    if (typeof error === "string") return error;
    if (error instanceof Error) {
        const anyErr = error as Error & { response?: { data?: unknown; status?: number } };
        const data = anyErr.response?.data;
        const status = anyErr.response?.status;
        const statusPart = typeof status === "number" ? ` (status=${status})` : "";
        if (typeof data === "string") return `${anyErr.message} ${data}${statusPart}`;
        if (data && typeof data === "object") {
            try {
                return `${anyErr.message} ${JSON.stringify(data)}${statusPart}`;
            } catch {
                return `${anyErr.message}${statusPart}`;
            }
        }
        return `${anyErr.message}${statusPart}`;
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/** 合并 Error.message + axios response.data + status，便于匹配 422/503 中转文案 */
function collectErrorBlob(error: unknown): string {
    const text = readErrorText(error).toLowerCase();
    const axiosExtra =
        typeof error === "object" && error && "response" in error
            ? (() => {
                  try {
                      const resp = (error as { response?: { data?: unknown; status?: number } }).response;
                      const data = resp?.data;
                      const status = typeof resp?.status === "number" ? ` status=${resp.status}` : "";
                      if (typeof data === "string") return `${data}${status}`;
                      if (data && typeof data === "object") return `${JSON.stringify(data)}${status}`;
                      return status;
                  } catch {
                      return "";
                  }
              })()
            : "";
    return `${text} ${axiosExtra}`.toLowerCase();
}
