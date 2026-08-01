import { App, Modal, Select, Spin } from "antd";
import { useCallback, useEffect, useState } from "react";

import {
    WORKSPACE_ITEM_KIND,
    WORKSPACE_ITEM_SOURCE,
    createWorkspaceItem,
    listWorkspaces,
    mapPool,
    peekWorkspaceListCache,
    type ShareWorkspaceItemInput,
    type WorkspaceSummary,
} from "@/services/workspace-api";
import { useAuthStore } from "@/stores/use-auth-store";
import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { assetTitleFromPrompt } from "@/lib/asset-display";
import { resolveCategoryOrSuggest, suggestAssetCategory } from "@/lib/asset-category";
import { getLastWorkspaceId, setLastWorkspaceId } from "@/lib/workspace-preference";

export type ShareDraft = {
    kind: string;
    title?: string;
    note?: string;
    category?: string;
    tags?: string[];
    prompt?: string;
    model?: string;
    sourceType?: string;
    sourceRef?: string;
    textContent?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mime?: string;
    /** Prefer storageKey for local media. */
    storageKey?: string;
    /** Or provide a ready blob / remote-ish url resolved by caller. */
    blob?: Blob;
    /** data:/blob:/http(s) fallback when no storageKey/blob */
    mediaUrl?: string;
    filename?: string;
};

type Props = {
    open: boolean;
    onClose: () => void;
    drafts: ShareDraft[];
    /** Called after all drafts attempted (ok + failed counts). */
    onDone?: (result: { ok: number; failed: number }) => void;
};

async function resolveBlob(draft: ShareDraft): Promise<Blob | null> {
    if (draft.blob) return draft.blob;
    if (draft.storageKey) {
        if (draft.storageKey.startsWith("video:") || draft.storageKey.startsWith("audio:") || draft.storageKey.startsWith("file:")) {
            return (await getMediaBlob(draft.storageKey)) || null;
        }
        return (await getImageBlob(draft.storageKey)) || null;
    }
    if (draft.mediaUrl) {
        if (draft.mediaUrl.startsWith("data:") || draft.mediaUrl.startsWith("blob:")) {
            const res = await fetch(draft.mediaUrl);
            if (!res.ok) return null;
            return res.blob();
        }
        // Remote http(s) may fail CORS; caller should prefer local storageKey.
        try {
            const res = await fetch(draft.mediaUrl);
            if (!res.ok) return null;
            return res.blob();
        } catch {
            return null;
        }
    }
    return null;
}

/** Infer category when draft lacks one (share paths often omit it). */
function resolveShareCategory(draft: ShareDraft): string | undefined {
    return resolveCategoryOrSuggest(draft.category, {
        title: draft.title,
        tags: draft.tags,
        note: draft.note,
        content: draft.textContent,
        prompt: draft.prompt,
        fileName: draft.filename,
        kind:
            draft.kind === WORKSPACE_ITEM_KIND.ASSET_TEXT
                ? "text"
                : draft.kind.includes("video")
                  ? "video"
                  : "image",
    });
}


function pickDefaultWorkspaceId(list: WorkspaceSummary[], current?: string) {
    if (current && list.some((ws) => ws.id === current)) return current;
    const last = getLastWorkspaceId();
    if (last && list.some((ws) => ws.id === last)) return last;
    return list[0]?.id;
}

/** Concurrent share uploads — enough to cut multi-select latency, low enough for small API. */
const SHARE_CONCURRENCY = 3;

export function ShareToWorkspaceModal({ open, onClose, drafts, onDone }: Props) {
    const { message } = App.useApp();
    const user = useAuthStore((s) => s.user);
    const [loading, setLoading] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
    const [workspaceId, setWorkspaceId] = useState<string>();
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

    const load = useCallback(async () => {
        if (!open || !user) return;
        // Paint cached list immediately so the modal is usable without waiting.
        const cached = peekWorkspaceListCache();
        if (cached?.items?.length) {
            setWorkspaces(cached.items);
            setWorkspaceId((prev) => pickDefaultWorkspaceId(cached.items, prev));
            setLoading(false);
        } else {
            setLoading(true);
        }
        try {
            const data = await listWorkspaces();
            const list = data.items || [];
            setWorkspaces(list);
            setWorkspaceId((prev) => pickDefaultWorkspaceId(list, prev));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载工作空间失败");
        } finally {
            setLoading(false);
        }
    }, [message, open, user]);

    useEffect(() => {
        if (!open) {
            setProgress(null);
            setSharing(false);
            return;
        }
        void load();
    }, [load, open]);

    const handleOk = async () => {
        if (!user) {
            message.warning("请先登录");
            return;
        }
        if (!workspaceId) {
            message.warning("请选择工作空间");
            return;
        }
        if (!drafts.length) {
            message.warning("没有可分享的内容");
            return;
        }
        setSharing(true);
        setProgress({ done: 0, total: drafts.length });
        let ok = 0;
        let failed = 0;
        try {
            // Resolve blob + upload with limited concurrency (was fully serial).
            await mapPool(drafts, SHARE_CONCURRENCY, async (draft) => {
                try {
                    const isText = draft.kind === WORKSPACE_ITEM_KIND.ASSET_TEXT;
                    let file: Blob | undefined;
                    if (!isText) {
                        const blob = await resolveBlob(draft);
                        if (!blob) {
                            failed += 1;
                            return;
                        }
                        file = blob;
                    }
                    const input: ShareWorkspaceItemInput = {
                        kind: draft.kind,
                        title: draft.title,
                        note: draft.note,
                        category: resolveShareCategory(draft),
                        tags: draft.tags,
                        prompt: draft.prompt,
                        model: draft.model,
                        sourceType: draft.sourceType || WORKSPACE_ITEM_SOURCE.ASSET,
                        sourceRef: draft.sourceRef,
                        textContent: draft.textContent,
                        width: draft.width,
                        height: draft.height,
                        bytes: draft.bytes || file?.size,
                        mime: draft.mime || file?.type,
                        file,
                        filename: draft.filename,
                    };
                    await createWorkspaceItem(workspaceId, input);
                    ok += 1;
                } catch {
                    failed += 1;
                } finally {
                    setProgress((prev) => {
                        const total = prev?.total || drafts.length;
                        const done = Math.min(total, (prev?.done || 0) + 1);
                        return { done, total };
                    });
                }
            });
            if (ok) {
                setLastWorkspaceId(workspaceId);
                message.success(`已分享 ${ok} 项到工作空间${failed ? `，失败 ${failed} 项` : ""}`);
            } else {
                message.error("分享失败，请确认文件可读且已加入空间");
            }
            onDone?.({ ok, failed });
            if (ok) onClose();
        } finally {
            setSharing(false);
            setProgress(null);
        }
    };

    return (
        <Modal
            title="分享到工作空间"
            open={open}
            onCancel={onClose}
            onOk={() => void handleOk()}
            okText={
                sharing && progress
                    ? `分享中 ${progress.done}/${progress.total}`
                    : drafts.length > 1
                      ? `分享 ${drafts.length} 项`
                      : "分享"
            }
            confirmLoading={sharing}
            okButtonProps={{ disabled: loading && !workspaces.length }}
            destroyOnHidden
        >
            <p className="mb-3 text-xs text-stone-500 dark:text-stone-400">
                仅上传你选中的内容副本；不会自动同步全部本地资产。对方可预览/下载，并另存到自己的「我的资产」。无分类时会按标题/提示词自动推断分区，可在空间详情再改。
            </p>
            {loading && !workspaces.length ? (
                <div className="flex justify-center py-8">
                    <Spin />
                </div>
            ) : workspaces.length ? (
                <Select
                    className="w-full"
                    placeholder="选择工作空间"
                    value={workspaceId}
                    onChange={(value) => {
                        setWorkspaceId(value);
                        if (value) setLastWorkspaceId(value);
                    }}
                    options={workspaces.map((ws) => ({ label: ws.name, value: ws.id }))}
                    disabled={sharing}
                />
            ) : (
                <div className="rounded-lg border border-dashed border-stone-300 p-4 text-sm text-stone-500 dark:border-stone-700">
                    你还没有工作空间。请先到「工作空间」页创建或用邀请码加入。
                </div>
            )}
            {sharing && progress ? (
                <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
                    正在上传 {progress.done}/{progress.total}…
                </p>
            ) : null}
        </Modal>
    );
}

/** Build share drafts from personal assets. */
export function draftsFromAssets(assets: Asset[]): ShareDraft[] {
    return assets.map((asset) => {
        const prompt = typeof asset.metadata?.prompt === "string" ? asset.metadata.prompt : "";
        const category =
            resolveCategoryOrSuggest(asset.category, {
                title: asset.title,
                tags: asset.tags,
                source: asset.source,
                note: asset.note,
                content: asset.kind === "text" ? asset.data.content : undefined,
                prompt,
                kind: asset.kind,
            }) || undefined;
        if (asset.kind === "text") {
            return {
                kind: WORKSPACE_ITEM_KIND.ASSET_TEXT,
                title: asset.title,
                note: asset.note,
                category,
                tags: asset.tags,
                textContent: asset.data.content,
                sourceType: WORKSPACE_ITEM_SOURCE.ASSET,
                sourceRef: asset.id,
                prompt,
            };
        }
        if (asset.kind === "video") {
            return {
                kind: WORKSPACE_ITEM_KIND.ASSET_VIDEO,
                title: asset.title,
                note: asset.note,
                category,
                tags: asset.tags,
                storageKey: asset.data.storageKey,
                mediaUrl: asset.data.url,
                width: asset.data.width,
                height: asset.data.height,
                bytes: asset.data.bytes,
                mime: asset.data.mimeType,
                sourceType: WORKSPACE_ITEM_SOURCE.ASSET,
                sourceRef: asset.id,
                prompt,
                filename: `${asset.title || "video"}.mp4`,
            };
        }
        return {
            kind: WORKSPACE_ITEM_KIND.ASSET_IMAGE,
            title: asset.title,
            note: asset.note,
            category,
            tags: asset.tags,
            storageKey: asset.data.storageKey,
            mediaUrl: asset.data.dataUrl,
            width: asset.data.width,
            height: asset.data.height,
            bytes: asset.data.bytes,
            mime: asset.data.mimeType,
            sourceType: WORKSPACE_ITEM_SOURCE.ASSET,
            sourceRef: asset.id,
            prompt,
            filename: `${asset.title || "image"}.png`,
        };
    });
}

/** Whether a canvas node can be published to a workspace (has shareable content). */
export function isCanvasNodeShareable(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return Boolean(node.metadata?.content?.trim());
    if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) {
        return Boolean(node.metadata?.content || node.metadata?.storageKey);
    }
    return false;
}

/** Build workspace share drafts from canvas nodes (storyboard → team). Skips empty/config/audio. */
export function draftsFromCanvasNodes(nodes: CanvasNodeData[], projectId?: string): ShareDraft[] {
    const drafts: ShareDraft[] = [];
    for (const node of nodes) {
        if (!isCanvasNodeShareable(node)) continue;
        const prompt = node.metadata?.prompt?.trim() || "";
        const model = node.metadata?.model || "";
        const sourceRef = projectId ? `canvas:${projectId}:${node.id}` : `canvas:${node.id}`;
        if (node.type === CanvasNodeType.Text) {
            const content = node.metadata?.content?.trim() || "";
            drafts.push({
                kind: WORKSPACE_ITEM_KIND.ASSET_TEXT,
                title: assetTitleFromPrompt(prompt || content, node.title || "画布文本"),
                textContent: content,
                prompt,
                model,
                category: suggestAssetCategory({
                    title: node.title,
                    content,
                    prompt,
                    kind: "text",
                }),
                sourceType: WORKSPACE_ITEM_SOURCE.CANVAS,
                sourceRef,
            });
            continue;
        }
        if (node.type === CanvasNodeType.Video) {
            drafts.push({
                kind: WORKSPACE_ITEM_KIND.GEN_VIDEO,
                title: assetTitleFromPrompt(prompt, node.title || "画布视频"),
                storageKey: node.metadata?.storageKey,
                mediaUrl: node.metadata?.content,
                width: node.metadata?.naturalWidth || node.width,
                height: node.metadata?.naturalHeight || node.height,
                bytes: node.metadata?.bytes,
                mime: node.metadata?.mimeType || "video/mp4",
                prompt,
                model,
                category: suggestAssetCategory({
                    title: node.title,
                    prompt,
                    kind: "video",
                }),
                sourceType: WORKSPACE_ITEM_SOURCE.CANVAS,
                sourceRef,
                filename: `${node.title || "canvas-video"}.mp4`,
            });
            continue;
        }
        drafts.push({
            kind: WORKSPACE_ITEM_KIND.GEN_IMAGE,
            title: assetTitleFromPrompt(prompt, node.title || "画布图片"),
            storageKey: node.metadata?.storageKey,
            mediaUrl: node.metadata?.content,
            width: node.metadata?.naturalWidth || node.width,
            height: node.metadata?.naturalHeight || node.height,
            bytes: node.metadata?.bytes,
            mime: node.metadata?.mimeType || "image/png",
            prompt,
            model,
            category: suggestAssetCategory({
                title: node.title,
                prompt,
                kind: "image",
            }),
            sourceType: WORKSPACE_ITEM_SOURCE.CANVAS,
            sourceRef,
            filename: `${node.title || "canvas-image"}.png`,
        });
    }
    return drafts;
}
