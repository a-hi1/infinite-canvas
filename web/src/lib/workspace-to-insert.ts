/** Convert workspace items into the same InsertAssetPayload used by local asset picker. */

import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { WORKSPACE_ITEM_KIND } from "@/lib/cloud-domain";
import { uploadMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import {
    workspaceFileObjectUrl,
    workspaceFileText,
    type WorkspaceItem,
} from "@/services/workspace-api";

export type WorkspaceInsertKindFilter = "all" | "image" | "video" | "text";

export function workspaceItemMediaKind(item: Pick<WorkspaceItem, "kind">): "image" | "video" | "text" | "unknown" {
    const kind = String(item.kind || "");
    if (kind === WORKSPACE_ITEM_KIND.ASSET_IMAGE || kind === WORKSPACE_ITEM_KIND.GEN_IMAGE) return "image";
    if (kind === WORKSPACE_ITEM_KIND.ASSET_VIDEO || kind === WORKSPACE_ITEM_KIND.GEN_VIDEO) return "video";
    if (
        kind === WORKSPACE_ITEM_KIND.ASSET_TEXT ||
        kind === WORKSPACE_ITEM_KIND.ASSET_DOCUMENT
    ) {
        return "text";
    }
    return "unknown";
}

export function isWorkspaceItemInsertable(item: Pick<WorkspaceItem, "kind" | "file_url" | "text_content">) {
    const media = workspaceItemMediaKind(item);
    if (media === "image" || media === "video") return Boolean(item.file_url);
    if (media === "text") {
        if (item.kind === WORKSPACE_ITEM_KIND.ASSET_DOCUMENT) return Boolean(item.file_url || item.text_content);
        return Boolean(item.text_content || item.file_url);
    }
    return false;
}

export function matchesWorkspaceInsertFilter(item: Pick<WorkspaceItem, "kind">, filter: WorkspaceInsertKindFilter) {
    if (filter === "all") return workspaceItemMediaKind(item) !== "unknown";
    return workspaceItemMediaKind(item) === filter;
}

/** Download workspace media into local storage and map to InsertAssetPayload. */
export async function workspaceItemToInsertPayload(item: WorkspaceItem): Promise<InsertAssetPayload> {
    const title = String(item.title || "").trim() || item.id.slice(0, 8);
    const media = workspaceItemMediaKind(item);

    if (media === "text") {
        let content = String(item.text_content || "").trim();
        if ((!content || item.kind === WORKSPACE_ITEM_KIND.ASSET_DOCUMENT) && item.file_url) {
            content = await workspaceFileText(item.file_url);
        }
        if (!content.trim()) throw new Error("该文本/文档没有可读内容");
        return { kind: "text", content, title };
    }

    if (media === "image") {
        if (!item.file_url) throw new Error("该图片没有可读取的文件");
        const objectUrl = await workspaceFileObjectUrl(item.file_url);
        const blob = await fetch(objectUrl).then((r) => {
            if (!r.ok) throw new Error("读取工作空间图片失败");
            return r.blob();
        });
        const stored = await uploadImage(blob);
        return {
            kind: "image",
            dataUrl: stored.url,
            storageKey: stored.storageKey,
            title,
        };
    }

    if (media === "video") {
        if (!item.file_url) throw new Error("该视频没有可读取的文件");
        const objectUrl = await workspaceFileObjectUrl(item.file_url);
        const blob = await fetch(objectUrl).then((r) => {
            if (!r.ok) throw new Error("读取工作空间视频失败");
            return r.blob();
        });
        const stored = await uploadMediaFile(blob, "video");
        return {
            kind: "video",
            url: stored.url,
            storageKey: stored.storageKey,
            title,
            width: item.width || stored.width,
            height: item.height || stored.height,
        };
    }

    throw new Error("暂不支持将该工作空间条目插入");
}
