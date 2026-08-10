/**
 * 3D 导演台（modal iframe / 新窗口）宿主侧协议与开关。
 *
 * 上游 demo：https://github.com/jiguang132/storyai-3d-director-desk
 * 静态资源：web/public/director-desk/（同域，满足 child 的 origin 校验）
 *
 * 通信：
 * - iframe：window.postMessage（parent）
 * - 新窗口：window.opener.postMessage + BroadcastChannel（同 origin，不依赖 opener）
 *
 * 回退：
 * 1. 设 VITE_DIRECTOR_DESK_ENABLED=false 后重建
 * 2. 本机 localStorage 设 infinite-canvas:director-desk-enabled=0 后刷新
 * 3. 删除入口挂载 / 删除 public/director-desk 即可整块卸下
 */

export const DIRECTOR_DESK_OPEN_EVENT = "infinite-canvas:open-director-desk";
export const DIRECTOR_DESK_CAPTURES_EVENT = "infinite-canvas:director-desk-captures";
export const DIRECTOR_DESK_STORAGE_KEY = "infinite-canvas:director-desk-enabled";
export const DIRECTOR_DESK_IFRAME_PATH = "/director-desk/index.html";
export const DIRECTOR_DESK_SOURCE_LABEL = "3D导演台";
export const DIRECTOR_DESK_BROADCAST_CHANNEL = "infinite-canvas:director-desk";
export const DIRECTOR_DESK_POPUP_NAME = "infinite-canvas-director-desk";

/** Child → parent / opener / BroadcastChannel */
export const DIRECTOR_DESK_MSG = {
    ready: "storyai:director-desk-ready",
    close: "storyai:director-desk-close",
    capturesSent: "storyai:director-desk-captures-sent",
    panoramaRemoved: "storyai:director-desk-panorama-removed",
} as const;

/** Parent → child */
export const DIRECTOR_DESK_HOST_MSG = {
    session: "storyai:director-desk-session",
    panorama: "storyai:director-desk-panorama",
    importResult: "storyai:director-desk-import-result",
} as const;

export type DirectorDeskImportResult = {
    ok: boolean;
    imported: number;
    failed: number;
    message: string;
    target?: "assets" | "assets+canvas";
};

export type DirectorDeskTheme = "dark" | "light";

export type DirectorDeskCapture = {
    dataUrl: string;
    fileName: string;
};

export type DirectorDeskOpenDetail = {
    instanceId?: string;
    theme?: DirectorDeskTheme;
    /** 画布项目 id：截图回流时额外插入当前画布 */
    canvasProjectId?: string;
};

export type DirectorDeskImportedCapture = {
    title: string;
    dataUrl: string;
    storageKey?: string;
    width: number;
    height: number;
    fileName: string;
    assetId: string;
};

export type DirectorDeskCapturesDetail = {
    captures: DirectorDeskImportedCapture[];
    canvasProjectId?: string | null;
    source: "iframe" | "popup" | "broadcast" | "unknown";
};

function readEnvEnabled() {
    const raw = String(import.meta.env.VITE_DIRECTOR_DESK_ENABLED ?? "true").trim().toLowerCase();
    return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

function readLocalOverride(): boolean | null {
    if (typeof window === "undefined") return null;
    try {
        const value = window.localStorage.getItem(DIRECTOR_DESK_STORAGE_KEY);
        if (value === null || value === "") return null;
        const normalized = value.trim().toLowerCase();
        if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no") return false;
        if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes") return true;
        return null;
    } catch {
        return null;
    }
}

/** 是否展示入口与挂载弹层。默认开；构建 env 或本机 localStorage 可关。 */
export function isDirectorDeskEnabled() {
    const local = readLocalOverride();
    if (local !== null) return local;
    return readEnvEnabled();
}

export function requestOpenDirectorDesk(detail?: DirectorDeskOpenDetail) {
    if (typeof window === "undefined" || !isDirectorDeskEnabled()) return;
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_OPEN_EVENT, { detail: detail || {} }));
}

export function notifyDirectorDeskCapturesImported(detail: DirectorDeskCapturesDetail) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_CAPTURES_EVENT, { detail }));
}

export function buildDirectorDeskIframeSrc(options?: {
    theme?: DirectorDeskTheme;
    instanceId?: string;
    embed?: boolean;
}) {
    const params = new URLSearchParams();
    params.set("theme", options?.theme || "dark");
    if (options?.embed !== false) params.set("embed", "1");
    if (options?.instanceId) params.set("instanceId", options.instanceId);
    return `${DIRECTOR_DESK_IFRAME_PATH}?${params.toString()}`;
}

export function isSameOriginMessage(event: MessageEvent) {
    return event.origin === window.location.origin;
}

export function isDirectorDeskIframeWindow(event: MessageEvent, iframe: HTMLIFrameElement | null) {
    return Boolean(iframe?.contentWindow && event.source === iframe.contentWindow);
}

export function isDirectorDeskPopupWindow(event: MessageEvent, popup: Window | null | undefined) {
    return Boolean(popup && !popup.closed && event.source === popup);
}

export function normalizeDirectorDeskCaptures(payload: unknown): DirectorDeskCapture[] {
    if (!payload || typeof payload !== "object") return [];
    const captures = (payload as { captures?: unknown }).captures;
    if (!Array.isArray(captures)) return [];

    return captures
        .map((item, index) => {
            if (!item || typeof item !== "object") return null;
            const dataUrl = String((item as { dataUrl?: unknown }).dataUrl || "").trim();
            if (!dataUrl.startsWith("data:image/")) return null;
            const fileName =
                String((item as { fileName?: unknown }).fileName || "").trim() || `director-desk-capture-${index + 1}.png`;
            return { dataUrl, fileName };
        })
        .filter((item): item is DirectorDeskCapture => Boolean(item));
}

export function postDirectorDeskSession(
    target: Window | null | undefined,
    payload: { instanceId?: string; theme?: DirectorDeskTheme },
) {
    if (!target || target.closed) return;
    try {
        target.postMessage(
            {
                type: DIRECTOR_DESK_HOST_MSG.session,
                payload: {
                    instanceId: payload.instanceId || "",
                    theme: payload.theme || "dark",
                },
            },
            window.location.origin,
        );
    } catch {
        // ignore closed/broken target
    }
}

/** 把导入结果回传给 iframe / 新窗口（postMessage + BroadcastChannel），子页可本地 toast。 */
export function postDirectorDeskImportResult(
    targets: Array<Window | null | undefined>,
    result: DirectorDeskImportResult,
) {
    if (typeof window === "undefined") return;
    const message = {
        type: DIRECTOR_DESK_HOST_MSG.importResult,
        payload: {
            ok: Boolean(result.ok),
            imported: Number(result.imported) || 0,
            failed: Number(result.failed) || 0,
            message: String(result.message || "").trim(),
            target: result.target || "assets",
        },
    };
    const origin = window.location.origin;
    const seen = new Set<Window>();
    for (const target of targets) {
        if (!target || target.closed || seen.has(target)) continue;
        seen.add(target);
        try {
            target.postMessage(message, origin);
        } catch {
            // ignore
        }
    }
    try {
        const channel = createDirectorDeskBroadcastChannel();
        channel?.postMessage(message);
        channel?.close();
    } catch {
        // ignore
    }
}

function sanitizePopupWindowName(instanceId?: string) {
    const raw = String(instanceId || "")
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 48);
    return raw ? `${DIRECTOR_DESK_POPUP_NAME}-${raw}` : DIRECTOR_DESK_POPUP_NAME;
}

/**
 * 打开导演台新窗口/标签页。
 * - 不用 noopener：保留 opener，截图才能 postMessage 回宿主
 * - 绝对 URL：避免相对路径在部分环境下落到 about:blank
 * - 命名窗口复用时强制 location 导航，防止旧空白窗只 focus 不加载
 * - 带 features 的 popup 更容易被拦截，失败时回退到普通新标签
 */
export function openDirectorDeskPopup(options?: { theme?: DirectorDeskTheme; instanceId?: string }) {
    if (typeof window === "undefined") return null;

    const relativeSrc = buildDirectorDeskIframeSrc({
        theme: options?.theme || "dark",
        instanceId: options?.instanceId,
        embed: true,
    });
    let absoluteSrc = relativeSrc;
    try {
        absoluteSrc = new URL(relativeSrc, window.location.href).href;
    } catch {
        absoluteSrc = relativeSrc;
    }

    const name = sanitizePopupWindowName(options?.instanceId);
    let popup: Window | null = null;

    // 1) 普通新标签（最少被拦截）
    try {
        popup = window.open(absoluteSrc, name);
    } catch {
        popup = null;
    }

    // 2) 回退：显式尺寸弹层（部分环境对无 features 的 open 更严）
    if (!popup) {
        try {
            popup = window.open(absoluteSrc, name, "width=1440,height=900,resizable=yes,scrollbars=yes");
        } catch {
            popup = null;
        }
    }

    if (!popup) return null;

    // 命名窗口若已存在，部分浏览器只 focus 不重新导航；强制加载导演台页。
    try {
        if (!popup.closed) {
            popup.location.replace(absoluteSrc);
        }
    } catch {
        // 跨源/尚未可用时忽略；opener 通道仍可能稍后建立
    }

    try {
        popup.focus();
    } catch {
        // ignore
    }

    return popup;
}

export function createDirectorDeskBroadcastChannel() {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
    try {
        return new BroadcastChannel(DIRECTOR_DESK_BROADCAST_CHANNEL);
    } catch {
        return null;
    }
}

export function fileNameWithoutExtension(name: string) {
    const base = name.replace(/\\/g, "/").split("/").pop() || name;
    return base.replace(/\.[^.]+$/, "").trim();
}
