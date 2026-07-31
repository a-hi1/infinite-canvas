import { App, Modal, Select, Spin } from "antd";
import { useCallback, useEffect, useState } from "react";

import {
    WORKSPACE_ITEM_KIND,
    WORKSPACE_ITEM_SOURCE,
    createWorkspaceItem,
    listWorkspaces,
    type ShareWorkspaceItemInput,
    type WorkspaceSummary,
} from "@/services/workspace-api";
import { useAuthStore } from "@/stores/use-auth-store";
import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import type { Asset } from "@/stores/use-asset-store";

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

export function ShareToWorkspaceModal({ open, onClose, drafts, onDone }: Props) {
    const { message } = App.useApp();
    const user = useAuthStore((s) => s.user);
    const [loading, setLoading] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
    const [workspaceId, setWorkspaceId] = useState<string>();

    const load = useCallback(async () => {
        if (!open || !user) return;
        setLoading(true);
        try {
            const data = await listWorkspaces();
            setWorkspaces(data.items || []);
            if (data.items?.length && !workspaceId) setWorkspaceId(data.items[0].id);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载工作空间失败");
        } finally {
            setLoading(false);
        }
    }, [message, open, user, workspaceId]);

    useEffect(() => {
        void load();
    }, [load]);

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
        let ok = 0;
        let failed = 0;
        try {
            for (const draft of drafts) {
                try {
                    const isText = draft.kind === WORKSPACE_ITEM_KIND.ASSET_TEXT;
                    let file: Blob | undefined;
                    if (!isText) {
                        const blob = await resolveBlob(draft);
                        if (!blob) {
                            failed += 1;
                            continue;
                        }
                        file = blob;
                    }
                    const input: ShareWorkspaceItemInput = {
                        kind: draft.kind,
                        title: draft.title,
                        note: draft.note,
                        category: draft.category,
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
                }
            }
            if (ok) message.success(`已分享 ${ok} 项到工作空间${failed ? `，失败 ${failed} 项` : ""}`);
            else message.error("分享失败，请确认文件可读且已加入空间");
            onDone?.({ ok, failed });
            if (ok) onClose();
        } finally {
            setSharing(false);
        }
    };

    return (
        <Modal
            title="分享到工作空间"
            open={open}
            onCancel={onClose}
            onOk={() => void handleOk()}
            okText={drafts.length > 1 ? `分享 ${drafts.length} 项` : "分享"}
            confirmLoading={sharing}
            destroyOnHidden
        >
            <p className="mb-3 text-xs text-stone-500 dark:text-stone-400">
                仅上传你选中的内容副本；不会自动同步全部本地资产。对方可预览/下载，并另存到自己的「我的资产」。
            </p>
            {loading ? (
                <div className="flex justify-center py-8">
                    <Spin />
                </div>
            ) : workspaces.length ? (
                <Select
                    className="w-full"
                    placeholder="选择工作空间"
                    value={workspaceId}
                    onChange={setWorkspaceId}
                    options={workspaces.map((ws) => ({ label: ws.name, value: ws.id }))}
                />
            ) : (
                <div className="rounded-lg border border-dashed border-stone-300 p-4 text-sm text-stone-500 dark:border-stone-700">
                    你还没有工作空间。请先到「工作空间」页创建或用邀请码加入。
                </div>
            )}
        </Modal>
    );
}

/** Build share drafts from personal assets. */
export function draftsFromAssets(assets: Asset[]): ShareDraft[] {
    return assets.map((asset) => {
        if (asset.kind === "text") {
            return {
                kind: WORKSPACE_ITEM_KIND.ASSET_TEXT,
                title: asset.title,
                note: asset.note,
                category: asset.category,
                tags: asset.tags,
                textContent: asset.data.content,
                sourceType: WORKSPACE_ITEM_SOURCE.ASSET,
                sourceRef: asset.id,
                prompt: typeof asset.metadata?.prompt === "string" ? asset.metadata.prompt : "",
            };
        }
        if (asset.kind === "video") {
            return {
                kind: WORKSPACE_ITEM_KIND.ASSET_VIDEO,
                title: asset.title,
                note: asset.note,
                category: asset.category,
                tags: asset.tags,
                storageKey: asset.data.storageKey,
                mediaUrl: asset.data.url,
                width: asset.data.width,
                height: asset.data.height,
                bytes: asset.data.bytes,
                mime: asset.data.mimeType,
                sourceType: WORKSPACE_ITEM_SOURCE.ASSET,
                sourceRef: asset.id,
                prompt: typeof asset.metadata?.prompt === "string" ? asset.metadata.prompt : "",
                filename: `${asset.title || "video"}.mp4`,
            };
        }
        return {
            kind: WORKSPACE_ITEM_KIND.ASSET_IMAGE,
            title: asset.title,
            note: asset.note,
            category: asset.category,
            tags: asset.tags,
            storageKey: asset.data.storageKey,
            mediaUrl: asset.data.dataUrl,
            width: asset.data.width,
            height: asset.data.height,
            bytes: asset.data.bytes,
            mime: asset.data.mimeType,
            sourceType: WORKSPACE_ITEM_SOURCE.ASSET,
            sourceRef: asset.id,
            prompt: typeof asset.metadata?.prompt === "string" ? asset.metadata.prompt : "",
            filename: `${asset.title || "image"}.png`,
        };
    });
}
