import { useCallback, useEffect, useId, useRef, useState } from "react";
import { App, Button, Modal, Spin, Tag } from "antd";
import { Clapperboard, ExternalLink, FolderOpen, Maximize2, X } from "lucide-react";
import { Link } from "react-router-dom";

import {
    DIRECTOR_DESK_MSG,
    DIRECTOR_DESK_OPEN_EVENT,
    DIRECTOR_DESK_SOURCE_LABEL,
    buildDirectorDeskIframeSrc,
    createDirectorDeskBroadcastChannel,
    fileNameWithoutExtension,
    isDirectorDeskEnabled,
    isDirectorDeskIframeWindow,
    isDirectorDeskPopupWindow,
    isSameOriginMessage,
    normalizeDirectorDeskCaptures,
    notifyDirectorDeskCapturesImported,
    openDirectorDeskPopup,
    postDirectorDeskImportResult,
    postDirectorDeskSession,
    type DirectorDeskCapture,
    type DirectorDeskImportResult,
    type DirectorDeskOpenDetail,
    type DirectorDeskTheme,
} from "@/lib/director-desk";
import { suggestAssetCategory } from "@/lib/asset-category";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";

/**
 * 同域 iframe / 新窗口嵌入 3D 导演台。
 * 截图经 postMessage + BroadcastChannel 回流「我的资产」；画布页可再插入节点。
 */
export function DirectorDeskModal() {
    const { message } = App.useApp();
    const addAssets = useAssetStore((state) => state.addAssets);
    const colorTheme = useThemeStore((state) => state.theme);
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const popupRef = useRef<Window | null>(null);
    const instanceIdRef = useRef(`director-desk-${Date.now()}`);
    const canvasProjectIdRef = useRef<string | null>(null);
    const importLockRef = useRef(false);
    const lastImportSigRef = useRef("");
    const lastImportAtRef = useRef(0);
    const [open, setOpen] = useState(false);
    const [ready, setReady] = useState(false);
    const [importing, setImporting] = useState(false);
    const [iframeKey, setIframeKey] = useState(0);
    const [lastImportCount, setLastImportCount] = useState(0);
    const [popupOpen, setPopupOpen] = useState(false);
    const titleId = useId();

    const theme: DirectorDeskTheme = colorTheme === "light" ? "light" : "dark";

    const close = useCallback(() => {
        setOpen(false);
        setReady(false);
    }, []);

    const openWithDetail = useCallback((detail?: DirectorDeskOpenDetail) => {
        if (!isDirectorDeskEnabled()) return;
        // 画布页复用同一 instanceId，弹层与新窗口共享 localStorage 场景。
        if (detail?.instanceId) {
            instanceIdRef.current = detail.instanceId;
        } else if (!instanceIdRef.current) {
            instanceIdRef.current = `director-desk-${Date.now()}`;
        }
        canvasProjectIdRef.current = detail?.canvasProjectId || null;
        setReady(false);
        setIframeKey((value) => value + 1);
        setOpen(true);
        setLastImportCount(0);
    }, []);

    useEffect(() => {
        if (!isDirectorDeskEnabled()) return;

        const onOpen = (event: Event) => {
            const detail = (event as CustomEvent<DirectorDeskOpenDetail>).detail;
            openWithDetail(detail);
        };
        window.addEventListener(DIRECTOR_DESK_OPEN_EVENT, onOpen as EventListener);
        return () => window.removeEventListener(DIRECTOR_DESK_OPEN_EVENT, onOpen as EventListener);
    }, [openWithDetail]);

    const replyImportResult = useCallback((result: DirectorDeskImportResult) => {
        postDirectorDeskImportResult(
            [iframeRef.current?.contentWindow, popupRef.current],
            result,
        );
    }, []);

    const importCaptures = useCallback(
        async (captures: DirectorDeskCapture[], source: "iframe" | "popup" | "broadcast" | "unknown") => {
            if (!captures.length) {
                message.warning("未收到有效截图");
                replyImportResult({
                    ok: false,
                    imported: 0,
                    failed: 0,
                    message: "未收到有效截图",
                });
                return;
            }
            // postMessage + BroadcastChannel 可能双投；短时同签名去重。
            const sig = `${captures.length}|${captures.map((item) => `${item.fileName}:${item.dataUrl.length}:${item.dataUrl.slice(0, 96)}`).join(";")}`;
            const now = Date.now();
            if (sig === lastImportSigRef.current && now - lastImportAtRef.current < 2500) {
                return;
            }
            if (importLockRef.current) return;
            lastImportSigRef.current = sig;
            lastImportAtRef.current = now;
            importLockRef.current = true;
            setImporting(true);
            try {
                const pending: Array<Parameters<typeof addAssets>[0][number]> = [];
                const importedMeta: Array<{
                    title: string;
                    dataUrl: string;
                    storageKey?: string;
                    width: number;
                    height: number;
                    fileName: string;
                }> = [];
                let failed = 0;
                for (const capture of captures) {
                    try {
                        const image = await uploadImage(capture.dataUrl);
                        const title = fileNameWithoutExtension(capture.fileName) || "导演台截图";
                        const sourceLabel = DIRECTOR_DESK_SOURCE_LABEL;
                        pending.push({
                            kind: "image",
                            title,
                            coverUrl: image.url,
                            category:
                                suggestAssetCategory({
                                    title,
                                    source: sourceLabel,
                                    fileName: capture.fileName,
                                    kind: "image",
                                    tags: ["分镜", "导演台"],
                                }) || "分镜",
                            tags: ["3D导演台", "分镜"],
                            source: sourceLabel,
                            note: "由 3D 导演台截图导入",
                            data: {
                                dataUrl: image.url,
                                storageKey: image.storageKey,
                                width: image.width,
                                height: image.height,
                                bytes: image.bytes,
                                mimeType: image.mimeType || "image/png",
                            },
                            metadata: {
                                source: "director-desk",
                                fileName: capture.fileName,
                                transport: source,
                            },
                        });
                        importedMeta.push({
                            title,
                            dataUrl: image.url,
                            storageKey: image.storageKey,
                            width: image.width,
                            height: image.height,
                            fileName: capture.fileName,
                        });
                    } catch {
                        failed += 1;
                    }
                }

                const canvasProjectId = canvasProjectIdRef.current;
                const target = canvasProjectId ? "assets+canvas" : "assets";

                if (!pending.length) {
                    const failMsg = failed ? `导入失败：${failed} 张截图未能写入「我的资产」` : "没有可导入的截图";
                    message.error(failMsg);
                    replyImportResult({
                        ok: false,
                        imported: 0,
                        failed: failed || captures.length,
                        message: failMsg,
                        target,
                    });
                    return;
                }

                const assetIds = addAssets(pending);
                const imported = importedMeta.map((item, index) => ({
                    ...item,
                    assetId: assetIds[index] || "",
                }));
                setLastImportCount(imported.length);

                notifyDirectorDeskCapturesImported({
                    captures: imported,
                    canvasProjectId,
                    source,
                });

                let hostMsg: string;
                if (canvasProjectId) {
                    hostMsg = failed
                        ? `已导入 ${imported.length} 张到资产/画布，${failed} 张失败`
                        : `已导入 ${imported.length} 张截图到「我的资产」，并尝试插入当前画布`;
                } else {
                    hostMsg = failed
                        ? `已导入 ${imported.length} 张到「我的资产」，${failed} 张失败`
                        : `已成功导入 ${imported.length} 张截图到「我的资产」`;
                }

                if (failed) {
                    message.warning(hostMsg);
                } else {
                    message.success(hostMsg);
                }

                // 新窗口用户主要看子页 toast；主站 toast 同步一份。
                replyImportResult({
                    ok: failed === 0,
                    imported: imported.length,
                    failed,
                    message: hostMsg,
                    target,
                });
            } catch (error) {
                const failMsg = error instanceof Error && error.message
                    ? `导入失败：${error.message}`
                    : "导入失败，请重试";
                message.error(failMsg);
                replyImportResult({
                    ok: false,
                    imported: 0,
                    failed: captures.length,
                    message: failMsg,
                });
            } finally {
                importLockRef.current = false;
                setImporting(false);
            }
        },
        [addAssets, message, replyImportResult],
    );

    const handleHostMessage = useCallback(
        (event: MessageEvent, sourceHint?: "iframe" | "popup" | "broadcast" | "unknown") => {
            if (!isSameOriginMessage(event)) return;

            const type = event.data?.type;
            if (!type || typeof type !== "string" || !type.startsWith("storyai:director-desk-")) return;

            const fromIframe = isDirectorDeskIframeWindow(event, iframeRef.current);
            const fromPopup = isDirectorDeskPopupWindow(event, popupRef.current);
            // 广播/新窗口可能没有稳定 source 引用；captures 允许同域任意来源，ready/close 优先认 iframe。
            if (type === DIRECTOR_DESK_MSG.ready) {
                if (!fromIframe && !fromPopup) return;
                if (fromIframe) {
                    setReady(true);
                    postDirectorDeskSession(iframeRef.current?.contentWindow, {
                        instanceId: instanceIdRef.current,
                        theme,
                    });
                }
                if (fromPopup) {
                    setPopupOpen(true);
                    postDirectorDeskSession(popupRef.current, {
                        instanceId: instanceIdRef.current,
                        theme,
                    });
                }
                return;
            }

            if (type === DIRECTOR_DESK_MSG.close) {
                if (fromIframe || !fromPopup) close();
                if (fromPopup) {
                    try {
                        popupRef.current?.close();
                    } catch {
                        // ignore
                    }
                    popupRef.current = null;
                    setPopupOpen(false);
                }
                return;
            }

            if (type === DIRECTOR_DESK_MSG.capturesSent) {
                const captures = normalizeDirectorDeskCaptures(event.data?.payload);
                const source = sourceHint || (fromIframe ? "iframe" : fromPopup ? "popup" : "unknown");
                void importCaptures(captures, source);
            }
        },
        [close, importCaptures, theme],
    );

    // 始终监听：新窗口在弹层关闭后仍可回传截图。
    useEffect(() => {
        if (!isDirectorDeskEnabled()) return;

        const onMessage = (event: MessageEvent) => handleHostMessage(event);
        window.addEventListener("message", onMessage);

        const channel = createDirectorDeskBroadcastChannel();
        const onBroadcast = (event: MessageEvent) => {
            handleHostMessage(
                {
                    data: event.data,
                    origin: window.location.origin,
                    source: null,
                } as MessageEvent,
                "broadcast",
            );
        };
        channel?.addEventListener("message", onBroadcast);

        return () => {
            window.removeEventListener("message", onMessage);
            channel?.removeEventListener("message", onBroadcast);
            try {
                channel?.close();
            } catch {
                // ignore
            }
        };
    }, [handleHostMessage]);

    useEffect(() => {
        if (!popupOpen) return;
        const timer = window.setInterval(() => {
            if (!popupRef.current || popupRef.current.closed) {
                popupRef.current = null;
                setPopupOpen(false);
            }
        }, 800);
        return () => window.clearInterval(timer);
    }, [popupOpen]);

    const handleOpenPopup = useCallback(() => {
        // 必须同步调用 window.open，保留用户点击手势，否则会被浏览器拦截。
        const popup = openDirectorDeskPopup({
            theme,
            instanceId: instanceIdRef.current,
        });
        if (!popup) {
            message.error("浏览器拦截了新窗口。请允许本站弹窗后重试，或改用地址栏旁的弹窗图标放行");
            return;
        }
        popupRef.current = popup;
        setPopupOpen(true);
        // 新窗口加载后会 ready；这里再补几次 session，避免加载慢时错过。
        const pushSession = () => {
            postDirectorDeskSession(popup, {
                instanceId: instanceIdRef.current,
                theme,
            });
        };
        pushSession();
        window.setTimeout(pushSession, 300);
        window.setTimeout(pushSession, 1200);
        message.success("已打开导演台新窗口/标签页；与弹层共用同一场景，发送截图会回到本页");
    }, [message, theme]);

    if (!isDirectorDeskEnabled()) return null;

    const deskSrc = buildDirectorDeskIframeSrc({
        theme,
        instanceId: instanceIdRef.current,
        embed: true,
    });

    return (
        <Modal
            open={open}
            onCancel={close}
            footer={null}
            width="min(1400px, 98vw)"
            centered
            destroyOnHidden
            maskClosable={false}
            closable={false}
            className="director-desk-modal"
            styles={{ body: { padding: 0, background: theme === "dark" ? "#0a0a0a" : "#f5f5f4" } }}
            title={null}
        >
            <div className="flex h-[min(92vh,960px)] flex-col">
                <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-stone-200/80 px-3 dark:border-stone-800">
                    <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-stone-900 dark:text-stone-100">
                        <Clapperboard className="size-4 shrink-0 opacity-80" />
                        <span id={titleId} className="truncate">
                            3D 导演台
                        </span>
                        {canvasProjectIdRef.current ? (
                            <Tag className="m-0! text-[11px]!" color="blue">
                                回流画布
                            </Tag>
                        ) : (
                            <Tag className="m-0! text-[11px]!">回流资产</Tag>
                        )}
                        {popupOpen ? (
                            <Tag className="m-0! text-[11px]!" color="processing">
                                新窗口已开
                            </Tag>
                        ) : null}
                        {importing ? <span className="text-xs font-normal text-stone-500">正在导入截图…</span> : null}
                        {!ready && !importing ? <span className="text-xs font-normal text-stone-500">加载中…</span> : null}
                        {lastImportCount > 0 && !importing ? (
                            <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400">最近导入 {lastImportCount} 张</span>
                        ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <Link
                            to="/assets"
                            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-stone-600 transition hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-white"
                            title="打开我的资产"
                            onClick={close}
                        >
                            <FolderOpen className="size-3.5" />
                            资产
                        </Link>
                        <Button
                            type="text"
                            size="small"
                            className="px-2!"
                            icon={<ExternalLink className="size-3.5" />}
                            onClick={handleOpenPopup}
                            title="新窗口打开（与弹层同一场景，可回传截图）"
                        >
                            新窗口
                        </Button>
                        <Button
                            type="text"
                            size="small"
                            className="px-2!"
                            icon={<Maximize2 className="size-3.5" />}
                            onClick={() => {
                                handleOpenPopup();
                            }}
                            title="放大到新窗口"
                        />
                        <Button type="text" size="small" className="px-2!" icon={<X className="size-4" />} onClick={close} aria-label="关闭导演台" />
                    </div>
                </div>

                <div className="relative min-h-0 flex-1 bg-black">
                    {!ready ? (
                        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
                            <Spin tip="正在加载 3D 导演台…" />
                        </div>
                    ) : null}
                    {open ? (
                        <iframe
                            key={iframeKey}
                            ref={iframeRef}
                            title="3D 导演台"
                            src={deskSrc}
                            className="h-full w-full border-0"
                            allow="fullscreen"
                            // 同域嵌入；仍限制权限面。allow-popups 便于导演台内部导出。
                            sandbox="allow-scripts allow-same-origin allow-downloads allow-modals allow-popups allow-forms"
                        />
                    ) : null}
                </div>

                <div className="shrink-0 border-t border-stone-200/80 px-3 py-2 text-[11px] leading-5 text-stone-500 dark:border-stone-800 dark:text-stone-400">
                    使用右侧<strong>相机面板</strong>先「机位截图」，再点截图卡片或底部的<strong>发送到画布</strong>——会写入本机「我的资产」
                    {canvasProjectIdRef.current ? "，并插入当前画布" : ""}
                    。点右上角<strong>新窗口</strong>打开同场景标签页；若无反应，请允许本站弹窗。
                </div>
            </div>
        </Modal>
    );
}
