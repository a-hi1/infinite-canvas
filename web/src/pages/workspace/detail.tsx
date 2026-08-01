import { App, Button, Empty, Image, Input, Modal, Select, Spin, Tabs, Tag, Typography, Upload } from "antd";
import type { UploadProps } from "antd";
import {
    ArrowLeft,
    BadgeCheck,
    Copy,
    Download,
    ExternalLink,
    FileUp,
    GripVertical,
    Images,
    Paperclip,
    Pencil,
    RefreshCw,
    Share2,
    Trash2,
    Upload as UploadIcon,
    UserMinus,
    Video,
    X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { saveAs } from "file-saver";

import {
    ALL_CATEGORIES_VALUE,
    assetCategoryLabel,
    buildAssetCategoryFilterOptions,
    collectAssetCategories,
    matchesAssetCategoryFilter,
    resolveAssetCategoryForSave,
    standardAssetCategoryOptions,
    suggestAssetCategory,
} from "@/lib/asset-category";
import {
    isWorkspaceDocumentFile,
    parseCsvPreview,
    renderSimpleMarkdown,
    resolveWorkspaceDocumentMime,
    summarizeDocumentText,
    WORKSPACE_DOCUMENT_ACCEPT,
    WORKSPACE_DOCUMENT_MAX_BYTES,
    workspaceDocumentExt,
    workspaceDocumentFormat,
} from "@/lib/workspace-document";
import { setLastWorkspaceId } from "@/lib/workspace-preference";
import { useCopyText } from "@/hooks/use-copy-text";
import { useAuthStore } from "@/stores/use-auth-store";
import { useAssetStore } from "@/stores/use-asset-store";
import {
    WORKSPACE_ITEM_KIND,
    WORKSPACE_ITEM_RESOLUTION,
    WORKSPACE_ITEM_SOURCE,
    WORKSPACE_ROLE,
    WORKSPACE_TASK_STATUS,
    archiveWorkspace,
    clearWorkspaceItemReaction,
    createWorkspaceItem,
    createWorkspaceTask,
    deleteWorkspaceItem,
    deleteWorkspaceTask,
    displayModelName,
    getWorkspace,
    itemUploaderLabel,
    listWorkspaceItems,
    listWorkspaceTasks,
    memberDisplayName,
    reactionCounts,
    removeWorkspaceMember,
    resetWorkspaceInvite,
    resolutionLabel,
    sourceTypeLabel,
    taskAssigneeIds,
    taskDeliverables,
    updateWorkspaceItem,
    updateWorkspaceTask,
    upsertWorkspaceItemReaction,
    workspaceFileObjectUrl,
    workspaceFileText,
    type WorkspaceItem,
    type WorkspaceMember,
    type WorkspaceSummary,
    type WorkspaceTask,
    type WorkspaceTaskDeliverable,
} from "@/services/workspace-api";

const taskStatusOptions = [
    { label: "待办", value: WORKSPACE_TASK_STATUS.TODO },
    { label: "进行中", value: WORKSPACE_TASK_STATUS.DOING },
    { label: "已完成", value: WORKSPACE_TASK_STATUS.DONE },
];

const TASK_STATUS_META: Record<
    string,
    { label: string; chip: string; bar: string; column: string; accent: string }
> = {
    [WORKSPACE_TASK_STATUS.TODO]: {
        label: "待办",
        chip: "bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-100",
        bar: "bg-stone-400",
        column: "border-stone-200 bg-stone-50/80 dark:border-stone-700 dark:bg-stone-900/50",
        accent: "border-l-stone-400",
    },
    [WORKSPACE_TASK_STATUS.DOING]: {
        label: "进行中",
        chip: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
        bar: "bg-sky-500",
        column: "border-sky-200 bg-sky-50/70 dark:border-sky-900 dark:bg-sky-950/30",
        accent: "border-l-sky-500",
    },
    [WORKSPACE_TASK_STATUS.DONE]: {
        label: "已完成",
        chip: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
        bar: "bg-emerald-500",
        column: "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/25",
        accent: "border-l-emerald-500",
    },
};

function kindLabel(kind: string) {
    if (kind === WORKSPACE_ITEM_KIND.ASSET_IMAGE || kind === WORKSPACE_ITEM_KIND.GEN_IMAGE) return "图片";
    if (kind === WORKSPACE_ITEM_KIND.ASSET_VIDEO || kind === WORKSPACE_ITEM_KIND.GEN_VIDEO) return "视频";
    if (kind === WORKSPACE_ITEM_KIND.ASSET_TEXT) return "文本";
    if (kind === WORKSPACE_ITEM_KIND.ASSET_DOCUMENT) return "文档";
    return kind;
}

function isMediaKind(kind: string) {
    return (
        kind === WORKSPACE_ITEM_KIND.ASSET_IMAGE ||
        kind === WORKSPACE_ITEM_KIND.ASSET_VIDEO ||
        kind === WORKSPACE_ITEM_KIND.GEN_IMAGE ||
        kind === WORKSPACE_ITEM_KIND.GEN_VIDEO
    );
}

function isDocumentKind(kind: string) {
    return kind === WORKSPACE_ITEM_KIND.ASSET_DOCUMENT;
}

function isVideoKind(kind: string) {
    return kind === WORKSPACE_ITEM_KIND.ASSET_VIDEO || kind === WORKSPACE_ITEM_KIND.GEN_VIDEO;
}

function isAssetWallKind(kind: string) {
    return kind.startsWith("asset_") || kind === WORKSPACE_ITEM_KIND.ASSET_TEXT;
}

function isDownloadableKind(kind: string) {
    return isMediaKind(kind) || isDocumentKind(kind);
}

/** Keep finals easy to scan: finals first, then newest. */
function sortFinalsFirst(list: WorkspaceItem[]) {
    return [...list].sort((a, b) => {
        const af = a.is_final ? 1 : 0;
        const bf = b.is_final ? 1 : 0;
        if (af !== bf) return bf - af;
        return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
}

function formatTime(value?: string) {
    if (!value) return "";
    try {
        return new Date(value).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return value;
    }
}

function formatBytes(bytes?: number) {
    const n = Number(bytes || 0);
    if (!n) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function WorkspaceDetailPage() {
    const { id = "" } = useParams();
    const navigate = useNavigate();
    const { message, modal } = App.useApp();
    const copyText = useCopyText();
    const user = useAuthStore((s) => s.user);
    // Depend on stable identity only — refreshUsage may replace usage/credits without changing login.
    const userId = user?.id || "";
    const addAsset = useAssetStore((s) => s.addAsset);
    const [loading, setLoading] = useState(true);
    const [contentLoading, setContentLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
    const [members, setMembers] = useState<WorkspaceMember[]>([]);
    const [items, setItems] = useState<WorkspaceItem[]>([]);
    const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
    const [tab, setTab] = useState("assets");
    const [taskTitle, setTaskTitle] = useState("");
    const [taskBody, setTaskBody] = useState("");
    const [taskAssignees, setTaskAssignees] = useState<string[]>([]);
    const [taskBusy, setTaskBusy] = useState(false);
    const [uploadBusy, setUploadBusy] = useState(false);
    const [detailItem, setDetailItem] = useState<WorkspaceItem | null>(null);
    const [assetCategoryFilter, setAssetCategoryFilter] = useState(ALL_CATEGORIES_VALUE);
    const [genCategoryFilter, setGenCategoryFilter] = useState(ALL_CATEGORIES_VALUE);
    /** Wall view focus: all | finals only — keeps material wall scannable. */
    const [assetFinalOnly, setAssetFinalOnly] = useState(false);
    const [genFinalOnly, setGenFinalOnly] = useState(false);
    const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
    const [dragOverStatus, setDragOverStatus] = useState<string | null>(null);
    const hasShellRef = useRef(false);

    const isOwner = workspace?.role === WORKSPACE_ROLE.OWNER || workspace?.owner_id === userId;
    const memberOptions = useMemo(
        () =>
            members.map((m) => ({
                value: m.user_id,
                label: memberDisplayName(m) + (m.role === WORKSPACE_ROLE.OWNER ? "（所有者）" : ""),
            })),
        [members],
    );
    const memberNameById = useMemo(() => {
        const map = new Map<string, string>();
        for (const m of members) map.set(m.user_id, memberDisplayName(m));
        return map;
    }, [members]);

    const load = useCallback(
        async (options?: { soft?: boolean }) => {
            if (!userId || !id) return;
            const soft = Boolean(options?.soft) && hasShellRef.current;
            if (soft) setRefreshing(true);
            else {
                setLoading(true);
                setContentLoading(true);
            }
            try {
                // Parallelize metadata + lists; paint shell as soon as workspace returns.
                const detailPromise = getWorkspace(id);
                const listsPromise = Promise.all([listWorkspaceItems(id, { pageSize: 100 }), listWorkspaceTasks(id)]);

                const detail = await detailPromise;
                setWorkspace(detail.workspace);
                setMembers(detail.members || []);
                setLastWorkspaceId(detail.workspace.id);
                hasShellRef.current = true;
                setLoading(false);

                const [itemRes, taskRes] = await listsPromise;
                setItems(itemRes.items || []);
                setTasks(taskRes.items || []);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载工作空间失败");
                if (!hasShellRef.current) navigate("/workspace?list=1");
            } finally {
                setLoading(false);
                setContentLoading(false);
                setRefreshing(false);
            }
        },
        [id, message, navigate, userId],
    );

    useEffect(() => {
        hasShellRef.current = false;
        setWorkspace(null);
        setMembers([]);
        setItems([]);
        setTasks([]);
        setDetailItem(null);
        void load();
    }, [load]);

    const assetItems = useMemo(() => items.filter((i) => isAssetWallKind(i.kind)), [items]);
    const genItems = useMemo(() => items.filter((i) => i.kind.startsWith("gen_")), [items]);
    const assetFinalCount = useMemo(() => assetItems.filter((item) => item.is_final).length, [assetItems]);
    const genFinalCount = useMemo(() => genItems.filter((item) => item.is_final).length, [genItems]);
    const filteredAssetItems = useMemo(
        () =>
            sortFinalsFirst(
                assetItems.filter((item) => {
                    if (assetFinalOnly && !item.is_final) return false;
                    return matchesAssetCategoryFilter(item.category, assetCategoryFilter);
                }),
            ),
        [assetItems, assetCategoryFilter, assetFinalOnly],
    );
    const filteredGenItems = useMemo(
        () =>
            sortFinalsFirst(
                genItems.filter((item) => {
                    if (genFinalOnly && !item.is_final) return false;
                    return matchesAssetCategoryFilter(item.category, genCategoryFilter);
                }),
            ),
        [genItems, genCategoryFilter, genFinalOnly],
    );
    const assetCategoryOptions = useMemo(() => buildAssetCategoryFilterOptions(assetItems), [assetItems]);
    const genCategoryOptions = useMemo(() => buildAssetCategoryFilterOptions(genItems), [genItems]);
    /** Detail category select: standards + any categories already used in this workspace. */
    const categoryEditOptions = useMemo(() => {
        const names = collectAssetCategories(items);
        const standard = standardAssetCategoryOptions().map((o) => o.value);
        const merged = [...new Set([...standard, ...names])];
        return [{ label: "未分类", value: "" }, ...merged.map((name) => ({ label: name, value: name }))];
    }, [items]);
    const itemTitleById = useMemo(() => {
        const map = new Map<string, string>();
        for (const item of items) map.set(item.id, item.title || item.id.slice(0, 8));
        return map;
    }, [items]);

    const handleResetInvite = () => {
        if (!workspace) return;
        modal.confirm({
            title: "重置邀请码",
            content: "旧邀请码将立即失效，需要把新码重新发给同事。",
            okText: "重置",
            onOk: async () => {
                const next = await resetWorkspaceInvite(workspace.id);
                setWorkspace(next);
                message.success("邀请码已重置");
            },
        });
    };

    const handleArchive = () => {
        if (!workspace) return;
        modal.confirm({
            title: "解散工作空间",
            content: "解散后成员将无法再访问该空间内容（软删除）。",
            okText: "解散",
            okButtonProps: { danger: true },
            onOk: async () => {
                await archiveWorkspace(workspace.id);
                message.success("已解散");
                navigate("/workspace?list=1");
            },
        });
    };

    const handleDeleteItem = (item: WorkspaceItem) => {
        modal.confirm({
            title: "删除分享",
            content: "从工作空间移除该分享（不会删除对方本地资产）。",
            okText: "删除",
            okButtonProps: { danger: true },
            onOk: async () => {
                await deleteWorkspaceItem(id, item.id);
                setItems((list) => list.filter((x) => x.id !== item.id));
                if (detailItem?.id === item.id) setDetailItem(null);
                message.success("已删除");
            },
        });
    };

    const handleKickMember = (member: WorkspaceMember) => {
        if (!isOwner) return;
        if (member.role === WORKSPACE_ROLE.OWNER || member.user_id === workspace?.owner_id) {
            message.warning("不能移除空间所有者");
            return;
        }
        modal.confirm({
            title: "移除成员",
            content: `确定将「${memberDisplayName(member)}」移出本空间？对方将无法再访问；已分享内容仍保留。`,
            okText: "移除",
            okButtonProps: { danger: true },
            onOk: async () => {
                await removeWorkspaceMember(id, member.user_id);
                setMembers((list) => list.filter((m) => m.user_id !== member.user_id));
                // Refresh tasks so assignee chips drop the kicked user.
                try {
                    const taskRes = await listWorkspaceTasks(id);
                    setTasks(taskRes.items || []);
                } catch {
                    // non-blocking
                }
                message.success("已移除成员");
            },
        });
    };

    const applyItemPatch = (updated: WorkspaceItem) => {
        setItems((list) => list.map((x) => (x.id === updated.id ? updated : x)));
        setDetailItem((current) => (current?.id === updated.id ? updated : current));
        // Best-effort: if another item lost is_final on the server, re-sync final flags from response only for this item;
        // full reload would flash — clear siblings client-side when this one becomes final.
        if (updated.is_final) {
            setItems((list) =>
                list.map((x) => {
                    if (x.id === updated.id) return updated;
                    if (!x.is_final) return x;
                    const sameChain =
                        x.replaces_item_id === updated.id ||
                        updated.replaces_item_id === x.id ||
                        (updated.replaces_item_id && x.replaces_item_id === updated.replaces_item_id) ||
                        (updated.replaces_item_id && x.id === updated.replaces_item_id);
                    return sameChain ? { ...x, is_final: false } : x;
                }),
            );
        }
    };

    const handleUpdateItemMeta = async (
        item: WorkspaceItem,
        patch: { title?: string; category?: string; version?: string; replacesItemId?: string | null; isFinal?: boolean },
    ) => {
        try {
            const updated = await updateWorkspaceItem(id, item.id, patch);
            applyItemPatch(updated);
            message.success("已更新");
            return updated;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新失败");
            throw error;
        }
    };

    /** Any member can cast 用/弃/改 on shared items. */
    const handleUpsertReaction = async (item: WorkspaceItem, resolution: string, comment?: string) => {
        try {
            const updated = await upsertWorkspaceItemReaction(id, item.id, { resolution, comment });
            applyItemPatch(updated);
            message.success(`已标记「${resolutionLabel(resolution)}」`);
            return updated;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "决议保存失败");
            throw error;
        }
    };

    const handleClearReaction = async (item: WorkspaceItem, targetUserId?: string) => {
        try {
            const updated = await clearWorkspaceItemReaction(id, item.id, targetUserId);
            applyItemPatch(updated);
            message.success("已取消决议");
            return updated;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "取消失败");
            throw error;
        }
    };

    /** Drag task card onto another progress column (creator/owner only; same as status select). */
    const handleTaskDrop = async (taskId: string, nextStatus: string) => {
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return;
        if (task.status === nextStatus) return;
        const canEdit = task.created_by === userId || Boolean(isOwner);
        if (!canEdit) {
            message.warning("仅创建者或所有者可拖拽改进度");
            return;
        }
        try {
            const next = await updateWorkspaceTask(id, task.id, { status: nextStatus });
            setTasks((list) => list.map((t) => (t.id === task.id ? next : t)));
            message.success(`已移到${TASK_STATUS_META[nextStatus]?.label || nextStatus}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新进度失败");
        }
    };

    const handleSaveToAssets = async (item: WorkspaceItem) => {
        try {
            if (item.kind === WORKSPACE_ITEM_KIND.ASSET_TEXT) {
                addAsset({
                    kind: "text",
                    title: item.title || "工作空间文本",
                    coverUrl: "",
                    category: item.category || undefined,
                    tags: item.tags || [],
                    source: "工作空间",
                    note: item.note || "",
                    metadata: { prompt: item.prompt, fromWorkspaceItemId: item.id },
                    data: { content: item.text_content || "" },
                });
                message.success("已保存到我的资产");
                return;
            }
            if (isDocumentKind(item.kind)) {
                if (!item.file_url) {
                    message.error("没有可保存的文档");
                    return;
                }
                const content = await workspaceFileText(item.file_url);
                addAsset({
                    kind: "text",
                    title: item.title || "工作空间文档",
                    coverUrl: "",
                    category: item.category || undefined,
                    tags: item.tags || [],
                    source: "工作空间",
                    note: item.note || "",
                    metadata: {
                        prompt: item.prompt,
                        fromWorkspaceItemId: item.id,
                        documentMime: item.mime,
                        originalBytes: item.bytes,
                    },
                    data: { content },
                });
                message.success("已保存到我的资产（文本）");
                return;
            }
            if (!item.file_url) {
                message.error("没有可保存的文件");
                return;
            }
            const objectUrl = await workspaceFileObjectUrl(item.file_url);
            // Shared session cache — do not revoke.
            const blob = await fetch(objectUrl).then((r) => r.blob());
            if (isVideoKind(item.kind)) {
                const { uploadMediaFile } = await import("@/services/file-storage");
                const uploaded = await uploadMediaFile(blob, "video");
                addAsset({
                    kind: "video",
                    title: item.title || "工作空间视频",
                    coverUrl: "",
                    category: item.category || undefined,
                    tags: item.tags || [],
                    source: "工作空间",
                    note: item.note || "",
                    metadata: { prompt: item.prompt, model: item.model, fromWorkspaceItemId: item.id },
                    data: {
                        url: uploaded.url,
                        storageKey: uploaded.storageKey,
                        width: item.width || 0,
                        height: item.height || 0,
                        bytes: item.bytes || blob.size,
                        mimeType: item.mime || blob.type || "video/mp4",
                    },
                });
            } else {
                const { uploadImage } = await import("@/services/image-storage");
                const uploaded = await uploadImage(blob);
                addAsset({
                    kind: "image",
                    title: item.title || "工作空间图片",
                    coverUrl: uploaded.url,
                    category: item.category || undefined,
                    tags: item.tags || [],
                    source: "工作空间",
                    note: item.note || "",
                    metadata: { prompt: item.prompt, model: item.model, fromWorkspaceItemId: item.id },
                    data: {
                        dataUrl: uploaded.url,
                        storageKey: uploaded.storageKey,
                        width: item.width || uploaded.width || 0,
                        height: item.height || uploaded.height || 0,
                        bytes: item.bytes || uploaded.bytes,
                        mimeType: item.mime || uploaded.mimeType,
                    },
                });
            }
            message.success("已保存到我的资产");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        }
    };

    const handleCreateTask = async () => {
        const title = taskTitle.trim();
        if (!title) {
            message.warning("请输入任务标题");
            return;
        }
        setTaskBusy(true);
        try {
            const task = await createWorkspaceTask(id, {
                title,
                body: taskBody.trim(),
                assigneeUserIds: taskAssignees,
            });
            setTasks((list) => [...list, task]);
            setTaskTitle("");
            setTaskBody("");
            setTaskAssignees([]);
            message.success("任务已创建");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建失败");
        } finally {
            setTaskBusy(false);
        }
    };

    const uploadLocalFiles = async (fileList: File[]) => {
        if (!fileList.length) return;
        setUploadBusy(true);
        let ok = 0;
        let fail = 0;
        try {
            for (const file of fileList) {
                const isImage = file.type.startsWith("image/");
                const isVideo = file.type.startsWith("video/");
                const isDocument = isWorkspaceDocumentFile(file);
                if (!isImage && !isVideo && !isDocument) {
                    message.warning(`已跳过不支持的文件：${file.name}`);
                    fail += 1;
                    continue;
                }
                try {
                    const title = file.name.replace(/\.[^.]+$/, "") || file.name;
                    if (isDocument) {
                        if (file.size > WORKSPACE_DOCUMENT_MAX_BYTES) {
                            message.warning(`${file.name} 超过 2MB，已跳过`);
                            fail += 1;
                            continue;
                        }
                        const mime = resolveWorkspaceDocumentMime(file.name, file.type) || "text/plain";
                        const fullText = await file.text();
                        const suggested = suggestAssetCategory({
                            title,
                            fileName: file.name,
                            content: fullText.slice(0, 2000),
                            kind: "text",
                        });
                        const created = await createWorkspaceItem(id, {
                            kind: WORKSPACE_ITEM_KIND.ASSET_DOCUMENT,
                            title,
                            category: suggested,
                            sourceType: WORKSPACE_ITEM_SOURCE.LOCAL_UPLOAD,
                            mime,
                            bytes: file.size,
                            textContent: summarizeDocumentText(fullText, 500),
                            file,
                            filename: file.name,
                        });
                        setItems((list) => [created, ...list]);
                        ok += 1;
                        continue;
                    }
                    const suggested = suggestAssetCategory({
                        title,
                        fileName: file.name,
                        kind: isImage ? "image" : "video",
                    });
                    const created = await createWorkspaceItem(id, {
                        kind: isImage ? WORKSPACE_ITEM_KIND.ASSET_IMAGE : WORKSPACE_ITEM_KIND.ASSET_VIDEO,
                        title,
                        category: suggested,
                        sourceType: WORKSPACE_ITEM_SOURCE.LOCAL_UPLOAD,
                        mime: file.type,
                        bytes: file.size,
                        file,
                        filename: file.name,
                    });
                    setItems((list) => [created, ...list]);
                    ok += 1;
                } catch (error) {
                    fail += 1;
                    message.error(error instanceof Error ? `${file.name}：${error.message}` : `${file.name} 上传失败`);
                }
            }
            if (ok) {
                const withCat = fileList.filter((f) => {
                    const title = f.name.replace(/\.[^.]+$/, "") || f.name;
                    const isDoc = isWorkspaceDocumentFile(f);
                    return Boolean(
                        suggestAssetCategory({
                            title,
                            fileName: f.name,
                            kind: isDoc ? "text" : f.type.startsWith("video/") ? "video" : "image",
                        }),
                    );
                }).length;
                message.success(
                    `已上传 ${ok} 个文件到素材墙${fail ? `，${fail} 个失败` : ""}${
                        withCat ? `（其中 ${Math.min(withCat, ok)} 个已自动分类）` : "（可在详情手动设分类）"
                    }`,
                );
            }
        } finally {
            setUploadBusy(false);
        }
    };

    const uploadProps: UploadProps = {
        multiple: true,
        showUploadList: false,
        accept: `image/jpeg,image/png,image/webp,video/mp4,video/webm,.jpg,.jpeg,.png,.webp,.mp4,.webm,${WORKSPACE_DOCUMENT_ACCEPT}`,
        disabled: uploadBusy,
        beforeUpload: (file, fileList) => {
            // Ant Design calls beforeUpload per file; only process the full batch once.
            if (file === fileList[fileList.length - 1]) {
                void uploadLocalFiles(fileList as File[]);
            }
            return false;
        },
    };

    const taskStats = useMemo(() => {
        const todo = tasks.filter((t) => t.status === WORKSPACE_TASK_STATUS.TODO).length;
        const doing = tasks.filter((t) => t.status === WORKSPACE_TASK_STATUS.DOING).length;
        const done = tasks.filter((t) => t.status === WORKSPACE_TASK_STATUS.DONE).length;
        const total = tasks.length || 1;
        return {
            todo,
            doing,
            done,
            total: tasks.length,
            todoPct: Math.round((todo / total) * 100),
            doingPct: Math.round((doing / total) * 100),
            donePct: Math.round((done / total) * 100),
        };
    }, [tasks]);

    const tasksByStatus = useMemo(
        () => ({
            [WORKSPACE_TASK_STATUS.TODO]: tasks.filter((t) => t.status === WORKSPACE_TASK_STATUS.TODO),
            [WORKSPACE_TASK_STATUS.DOING]: tasks.filter((t) => t.status === WORKSPACE_TASK_STATUS.DOING),
            [WORKSPACE_TASK_STATUS.DONE]: tasks.filter((t) => t.status === WORKSPACE_TASK_STATUS.DONE),
        }),
        [tasks],
    );

    if (!user) {
        return (
            <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
                <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                    <div className="mx-auto max-w-4xl px-6 py-12 text-center text-sm text-stone-500">
                        请先登录后查看工作空间。 <Link to="/workspace">返回</Link>
                    </div>
                </main>
            </div>
        );
    }

    if (loading || !workspace) {
        return (
            <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
                <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                    <Spin />
                </main>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="mx-auto max-w-6xl px-6 py-8 pb-12">
                <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <button type="button" className="mb-2 inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-200" onClick={() => navigate("/workspace?list=1")}>
                            <ArrowLeft className="size-3.5" />
                            切换工作空间
                        </button>
                        <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{workspace.name}</h1>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                            <Tag className="m-0">{isOwner ? "所有者" : "成员"}</Tag>
                            <span>{members.length} 名成员</span>
                            {workspace.invite_code ? (
                                <button
                                    type="button"
                                    className="inline-flex items-center gap-1 rounded border border-stone-200 bg-card/80 px-2 py-0.5 hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-900"
                                    onClick={() => void copyText(workspace.invite_code || "", "邀请码已复制")}
                                >
                                    <Copy className="size-3" />
                                    邀请码 {workspace.invite_code}
                                </button>
                            ) : null}
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Upload {...uploadProps}>
                            <Button size="small" type="primary" icon={<UploadIcon className="size-3.5" />} loading={uploadBusy}>
                                上传本地文件
                            </Button>
                        </Upload>
                        <Button size="small" icon={<RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />} loading={refreshing} onClick={() => void load({ soft: true })}>
                            刷新
                        </Button>
                        {isOwner ? (
                            <>
                                <Button size="small" onClick={handleResetInvite}>
                                    重置邀请码
                                </Button>
                                <Button size="small" danger onClick={handleArchive}>
                                    解散
                                </Button>
                            </>
                        ) : null}
                    </div>
                </div>

                {contentLoading ? (
                    <div className="mb-4 flex min-h-40 items-center justify-center rounded-xl border border-dashed border-stone-300 bg-card/50 dark:border-stone-700">
                        <div className="flex flex-col items-center gap-2 text-sm text-stone-500">
                            <Spin size="small" />
                            <span>正在加载素材与进度…</span>
                        </div>
                    </div>
                ) : (
                <Tabs
                    activeKey={tab}
                    onChange={setTab}
                    destroyOnHidden
                    items={[
                        {
                            key: "assets",
                            label: `素材墙 (${assetItems.length}${assetFinalCount ? ` · 终稿 ${assetFinalCount}` : ""})`,
                            children: (
                                <div className="space-y-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="text-xs text-stone-500">
                                            团队可复用素材 · 本地上传图片/视频/文档（md/txt/csv）或从「我的资产」分享
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            <Button size="small" icon={<Images className="size-3.5" />} onClick={() => navigate("/assets")}>
                                                从资产分享
                                            </Button>
                                            <Upload {...uploadProps}>
                                                <Button size="small" type="primary" icon={<FileUp className="size-3.5" />} loading={uploadBusy}>
                                                    上传
                                                </Button>
                                            </Upload>
                                        </div>
                                    </div>
                                    <WallFilterBar
                                        categoryOptions={assetCategoryOptions}
                                        categoryValue={assetCategoryFilter}
                                        onCategoryChange={setAssetCategoryFilter}
                                        finalOnly={assetFinalOnly}
                                        onFinalOnlyChange={setAssetFinalOnly}
                                        finalCount={assetFinalCount}
                                        shownCount={filteredAssetItems.length}
                                        totalCount={assetItems.length}
                                    />
                                    <ItemGrid
                                        items={filteredAssetItems}
                                        currentUserId={userId}
                                        isOwner={Boolean(isOwner)}
                                        emptyHint={assetFinalOnly ? "终稿" : "素材墙"}
                                        itemTitleById={itemTitleById}
                                        onOpen={setDetailItem}
                                        onDelete={handleDeleteItem}
                                        onSave={(item) => void handleSaveToAssets(item)}
                                        onGoShare={() => navigate("/assets")}
                                    />
                                </div>
                            ),
                        },
                        {
                            key: "gens",
                            label: `生成分享 (${genItems.length}${genFinalCount ? ` · 终稿 ${genFinalCount}` : ""})`,
                            children: (
                                <div className="space-y-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="text-xs text-stone-500">
                                            工作台过程快照 · 在图/视频历史点「分享到工作空间」
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            <Button size="small" icon={<Images className="size-3.5" />} onClick={() => navigate("/image")}>
                                                图片工作台
                                            </Button>
                                            <Button size="small" icon={<Video className="size-3.5" />} onClick={() => navigate("/video")}>
                                                视频工作台
                                            </Button>
                                        </div>
                                    </div>
                                    <WallFilterBar
                                        categoryOptions={genCategoryOptions}
                                        categoryValue={genCategoryFilter}
                                        onCategoryChange={setGenCategoryFilter}
                                        finalOnly={genFinalOnly}
                                        onFinalOnlyChange={setGenFinalOnly}
                                        finalCount={genFinalCount}
                                        shownCount={filteredGenItems.length}
                                        totalCount={genItems.length}
                                    />
                                    <ItemGrid
                                        items={filteredGenItems}
                                        currentUserId={userId}
                                        isOwner={Boolean(isOwner)}
                                        emptyHint={genFinalOnly ? "终稿" : "生成分享"}
                                        itemTitleById={itemTitleById}
                                        onOpen={setDetailItem}
                                        onDelete={handleDeleteItem}
                                        onSave={(item) => void handleSaveToAssets(item)}
                                        onGoShare={() => navigate("/image")}
                                    />
                                </div>
                            ),
                        },
                        {
                            key: "tasks",
                            label: `进度板 (${tasks.length})`,
                            children: (
                                <div className="space-y-4">
                                    <div className="rounded-xl border border-stone-200 bg-card/90 p-3 shadow-sm dark:border-stone-800">
                                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                            <div className="text-sm font-medium text-stone-900 dark:text-stone-100">进度总览</div>
                                            <div className="text-xs text-stone-500">
                                                {taskStats.done}/{taskStats.total || 0} 已完成
                                                {taskStats.total ? ` · ${Math.round((taskStats.done / Math.max(taskStats.total, 1)) * 100)}%` : ""}
                                            </div>
                                        </div>
                                        {taskStats.total ? (
                                            <div className="mb-3 flex h-3 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-900">
                                                {taskStats.done > 0 ? (
                                                    <div className="bg-emerald-500 transition-all" style={{ width: `${taskStats.donePct}%` }} title={`已完成 ${taskStats.done}`} />
                                                ) : null}
                                                {taskStats.doing > 0 ? (
                                                    <div className="bg-sky-500 transition-all" style={{ width: `${taskStats.doingPct}%` }} title={`进行中 ${taskStats.doing}`} />
                                                ) : null}
                                                {taskStats.todo > 0 ? (
                                                    <div className="bg-stone-400 transition-all" style={{ width: `${taskStats.todoPct}%` }} title={`待办 ${taskStats.todo}`} />
                                                ) : null}
                                            </div>
                                        ) : (
                                            <div className="mb-3 h-3 rounded-full bg-stone-100 dark:bg-stone-900" />
                                        )}
                                        <div className="flex flex-wrap gap-2 text-[11px]">
                                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${TASK_STATUS_META[WORKSPACE_TASK_STATUS.TODO].chip}`}>
                                                <span className="size-1.5 rounded-full bg-stone-500" /> 待办 {taskStats.todo}
                                            </span>
                                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${TASK_STATUS_META[WORKSPACE_TASK_STATUS.DOING].chip}`}>
                                                <span className="size-1.5 rounded-full bg-sky-500" /> 进行中 {taskStats.doing}
                                            </span>
                                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${TASK_STATUS_META[WORKSPACE_TASK_STATUS.DONE].chip}`}>
                                                <span className="size-1.5 rounded-full bg-emerald-500" /> 已完成 {taskStats.done}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="rounded-xl border border-stone-200 bg-card/90 p-3 shadow-sm dark:border-stone-800">
                                        <div className="mb-2 text-sm font-medium text-stone-900 dark:text-stone-100">新建任务</div>
                                        <div className="flex flex-col gap-2">
                                            <Input
                                                value={taskTitle}
                                                onChange={(e) => setTaskTitle(e.target.value)}
                                                placeholder="任务标题，例如：本周完成分镜 3 张"
                                                onPressEnter={() => void handleCreateTask()}
                                            />
                                            <Input.TextArea
                                                value={taskBody}
                                                onChange={(e) => setTaskBody(e.target.value)}
                                                placeholder="可选备注"
                                                autoSize={{ minRows: 2, maxRows: 4 }}
                                            />
                                            <Select
                                                mode="multiple"
                                                allowClear
                                                placeholder="负责人（可选，可多选本空间成员）"
                                                value={taskAssignees}
                                                options={memberOptions}
                                                onChange={(value) => setTaskAssignees(value)}
                                                optionFilterProp="label"
                                                className="w-full"
                                            />
                                            <div className="flex justify-end">
                                                <Button type="primary" loading={taskBusy} onClick={() => void handleCreateTask()}>
                                                    添加任务
                                                </Button>
                                            </div>
                                        </div>
                                    </div>

                                    {tasks.length ? (
                                        <div className="space-y-2">
                                            <div className="text-[11px] text-stone-400">
                                                按左侧 ⋮⋮ 手柄拖到其它列更新进度（创建者/所有者）；状态下拉仍可用
                                            </div>
                                            <div className="grid gap-3 lg:grid-cols-3">
                                                {[WORKSPACE_TASK_STATUS.TODO, WORKSPACE_TASK_STATUS.DOING, WORKSPACE_TASK_STATUS.DONE].map((status) => {
                                                    const meta = TASK_STATUS_META[status];
                                                    const columnTasks = tasksByStatus[status] || [];
                                                    const isDropTarget = dragOverStatus === status;
                                                    return (
                                                        <div
                                                            key={status}
                                                            className={`rounded-xl border p-2 transition ${meta.column} ${
                                                                isDropTarget
                                                                    ? "ring-2 ring-sky-400 ring-offset-1 dark:ring-sky-500 dark:ring-offset-stone-950"
                                                                    : ""
                                                            }`}
                                                            onDragOver={(event) => {
                                                                if (!draggingTaskId) return;
                                                                event.preventDefault();
                                                                event.dataTransfer.dropEffect = "move";
                                                                if (dragOverStatus !== status) setDragOverStatus(status);
                                                            }}
                                                            onDragLeave={(event) => {
                                                                const related = event.relatedTarget as Node | null;
                                                                if (related && event.currentTarget.contains(related)) return;
                                                                if (dragOverStatus === status) setDragOverStatus(null);
                                                            }}
                                                            onDrop={(event) => {
                                                                event.preventDefault();
                                                                const taskId =
                                                                    event.dataTransfer.getData("text/workspace-task-id") ||
                                                                    draggingTaskId ||
                                                                    "";
                                                                setDragOverStatus(null);
                                                                setDraggingTaskId(null);
                                                                if (!taskId) return;
                                                                void handleTaskDrop(taskId, status);
                                                            }}
                                                        >
                                                            <div className="mb-2 flex items-center justify-between px-1">
                                                                <div className="flex items-center gap-2 text-sm font-medium text-stone-800 dark:text-stone-100">
                                                                    <span className={`size-2.5 rounded-sm ${meta.bar}`} />
                                                                    {meta.label}
                                                                </div>
                                                                <span className={`rounded-full px-2 py-0.5 text-[11px] ${meta.chip}`}>{columnTasks.length}</span>
                                                            </div>
                                                            <div className="min-h-24 space-y-2">
                                                                {columnTasks.length ? (
                                                                    columnTasks.map((task) => {
                                                                        const ids = taskAssigneeIds(task);
                                                                        const canEdit = task.created_by === userId || Boolean(isOwner);
                                                                        const canDeliver = canEdit || ids.includes(userId);
                                                                        return (
                                                                            <TaskRow
                                                                                key={task.id}
                                                                                task={task}
                                                                                members={members}
                                                                                memberNameById={memberNameById}
                                                                                canEdit={canEdit}
                                                                                canDeliver={canDeliver}
                                                                                isDragging={draggingTaskId === task.id}
                                                                                onDragStart={(taskId) => setDraggingTaskId(taskId)}
                                                                                onDragEnd={() => {
                                                                                    setDraggingTaskId(null);
                                                                                    setDragOverStatus(null);
                                                                                }}
                                                                                onChangeStatus={async (nextStatus) => {
                                                                                    const next = await updateWorkspaceTask(id, task.id, { status: nextStatus });
                                                                                    setTasks((list) => list.map((t) => (t.id === task.id ? next : t)));
                                                                                }}
                                                                                onChangeAssignees={async (assigneeUserIds) => {
                                                                                    const next = await updateWorkspaceTask(id, task.id, { assigneeUserIds });
                                                                                    setTasks((list) => list.map((t) => (t.id === task.id ? next : t)));
                                                                                }}
                                                                                onUploadDeliverable={async (file) => {
                                                                                    const next = await updateWorkspaceTask(id, task.id, {
                                                                                        deliverableFile: file,
                                                                                        deliverableFilename: file.name,
                                                                                    });
                                                                                    setTasks((list) => list.map((t) => (t.id === task.id ? next : t)));
                                                                                }}
                                                                                onRemoveDeliverable={async (fileId) => {
                                                                                    const next = await updateWorkspaceTask(id, task.id, {
                                                                                        removeDeliverableFileId: fileId,
                                                                                    });
                                                                                    setTasks((list) => list.map((t) => (t.id === task.id ? next : t)));
                                                                                }}
                                                                                onClearDeliverable={async () => {
                                                                                    const next = await updateWorkspaceTask(id, task.id, { clearDeliverable: true });
                                                                                    setTasks((list) => list.map((t) => (t.id === task.id ? next : t)));
                                                                                }}
                                                                                onDelete={async () => {
                                                                                    await deleteWorkspaceTask(id, task.id);
                                                                                    setTasks((list) => list.filter((t) => t.id !== task.id));
                                                                                    message.success("已删除任务");
                                                                                }}
                                                                            />
                                                                        );
                                                                    })
                                                                ) : (
                                                                    <div className="rounded-lg border border-dashed border-stone-300/80 px-2 py-6 text-center text-[11px] text-stone-400 dark:border-stone-700">
                                                                        {isDropTarget ? "松开以移到此列" : "暂无 · 可拖入"}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ) : (
                                        <Empty description="还没有进度任务" className="rounded-xl border border-dashed border-stone-300 bg-card/70 py-12 dark:border-stone-700" />
                                    )}
                                </div>
                            ),
                        },
                        {
                            key: "members",
                            label: `成员 (${members.length})`,
                            children: (
                                <div className="space-y-2">
                                    {members.map((m) => {
                                        const isMemberOwner = m.role === WORKSPACE_ROLE.OWNER || m.user_id === workspace.owner_id;
                                        const canKick = Boolean(isOwner) && !isMemberOwner;
                                        return (
                                            <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-card/90 px-3 py-2 text-sm shadow-sm dark:border-stone-800">
                                                <div className="min-w-0">
                                                    <div className="font-medium">{memberDisplayName(m)}</div>
                                                    <div className="text-xs text-stone-500">{m.email}</div>
                                                </div>
                                                <div className="flex shrink-0 items-center gap-2">
                                                    <Tag className="m-0">{isMemberOwner ? "所有者" : "成员"}</Tag>
                                                    {canKick ? (
                                                        <Button
                                                            size="small"
                                                            danger
                                                            icon={<UserMinus className="size-3.5" />}
                                                            onClick={() => handleKickMember(m)}
                                                        >
                                                            移除
                                                        </Button>
                                                    ) : null}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ),
                        },
                    ]}
                />
                )}

                <ItemDetailModal
                    item={detailItem}
                    items={items}
                    categoryOptions={categoryEditOptions}
                    currentUserId={userId}
                    isOwner={isOwner}
                    canEdit={Boolean(detailItem && (detailItem.created_by === userId || isOwner))}
                    canDelete={Boolean(detailItem && (detailItem.created_by === userId || isOwner))}
                    onClose={() => setDetailItem(null)}
                    onSave={(item) => void handleSaveToAssets(item)}
                    onDelete={(item) => handleDeleteItem(item)}
                    onUpdateMeta={(item, patch) => handleUpdateItemMeta(item, patch)}
                    onUpsertReaction={(item, resolution, comment) => handleUpsertReaction(item, resolution, comment)}
                    onClearReaction={(item, targetUserId) => handleClearReaction(item, targetUserId)}
                />
                </div>
            </main>
        </div>
    );
}

function CategoryFilterChips({
    options,
    value,
    onChange,
}: {
    options: Array<{ label: string; value: string }>;
    value: string;
    onChange: (next: string) => void;
}) {
    return (
        <div className="flex flex-wrap gap-1.5">
            {options.map((opt) => {
                const active = value === opt.value;
                return (
                    <button
                        key={opt.value}
                        type="button"
                        onClick={() => onChange(opt.value)}
                        className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
                            active
                                ? "border-sky-500 bg-sky-50 font-medium text-sky-800 shadow-sm ring-1 ring-sky-400/40 dark:border-sky-400 dark:bg-sky-950/50 dark:text-sky-100 dark:ring-sky-500/30"
                                : "border-stone-200 bg-card/80 text-stone-600 hover:border-stone-400 hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-900"
                        }`}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}

/** Category chips + 仅终稿 toggle for material / gen walls. */
function WallFilterBar({
    categoryOptions,
    categoryValue,
    onCategoryChange,
    finalOnly,
    onFinalOnlyChange,
    finalCount,
    shownCount,
    totalCount,
}: {
    categoryOptions: Array<{ label: string; value: string }>;
    categoryValue: string;
    onCategoryChange: (next: string) => void;
    finalOnly: boolean;
    onFinalOnlyChange: (next: boolean) => void;
    finalCount: number;
    shownCount: number;
    totalCount: number;
}) {
    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                <CategoryFilterChips options={categoryOptions} value={categoryValue} onChange={onCategoryChange} />
                <button
                    type="button"
                    onClick={() => onFinalOnlyChange(!finalOnly)}
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${
                        finalOnly
                            ? "border-amber-500 bg-amber-100 text-amber-950 shadow-sm ring-1 ring-amber-400/50 dark:border-amber-400 dark:bg-amber-950/60 dark:text-amber-50 dark:ring-amber-500/40"
                            : "border-amber-300/80 bg-amber-50/80 text-amber-900 hover:border-amber-400 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
                    }`}
                    title={finalOnly ? "显示全部" : "只看终稿"}
                >
                    <BadgeCheck className="size-3.5" />
                    {finalOnly ? "仅终稿" : "终稿"}
                    {finalCount > 0 ? <span className="tabular-nums opacity-80">· {finalCount}</span> : null}
                </button>
            </div>
            <div className="text-[11px] text-stone-400">
                显示 {shownCount}
                {shownCount !== totalCount ? ` / ${totalCount}` : ""}
                {finalOnly ? " · 已筛选终稿（置顶）" : finalCount > 0 ? " · 终稿优先排列" : ""}
            </div>
        </div>
    );
}

function isVideoMime(mime?: string | null, name?: string | null) {
    const m = String(mime || "").toLowerCase();
    if (m.startsWith("video/")) return true;
    const n = String(name || "").toLowerCase();
    return n.endsWith(".mp4") || n.endsWith(".webm") || n.endsWith(".mov");
}

const MAX_TASK_DELIVERABLES_UI = 12;

function TaskRow({
    task,
    members,
    memberNameById,
    canEdit,
    canDeliver,
    isDragging,
    onDragStart,
    onDragEnd,
    onChangeStatus,
    onChangeAssignees,
    onUploadDeliverable,
    onRemoveDeliverable,
    onClearDeliverable,
    onDelete,
}: {
    task: WorkspaceTask;
    members: WorkspaceMember[];
    memberNameById: Map<string, string>;
    canEdit: boolean;
    canDeliver: boolean;
    isDragging?: boolean;
    onDragStart?: (taskId: string) => void;
    onDragEnd?: () => void;
    onChangeStatus: (status: string) => Promise<void>;
    onChangeAssignees: (ids: string[]) => Promise<void>;
    onUploadDeliverable: (file: File) => Promise<void>;
    onRemoveDeliverable: (fileId: string) => Promise<void>;
    onClearDeliverable: () => Promise<void>;
    onDelete: () => Promise<void>;
}) {
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);
    const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
    const [previewErrors, setPreviewErrors] = useState<Record<string, boolean>>({});
    const [activePreview, setActivePreview] = useState<WorkspaceTaskDeliverable | null>(null);
    const ids = taskAssigneeIds(task);
    const deliverables = taskDeliverables(task);
    const assigneeLabels =
        (task.assignees?.length
            ? task.assignees.map((a) => a.display_name || a.email || a.user_id.slice(0, 8))
            : ids.map((id) => memberNameById.get(id) || id.slice(0, 8))) || [];
    const meta = TASK_STATUS_META[task.status] || TASK_STATUS_META[WORKSPACE_TASK_STATUS.TODO];
    const canAddMore = deliverables.length < MAX_TASK_DELIVERABLES_UI;

    useEffect(() => {
        let active = true;
        const nextUrls: Record<string, string> = {};
        const nextErrors: Record<string, boolean> = {};
        setPreviewUrls({});
        setPreviewErrors({});
        setActivePreview(null);

        const loaders = deliverables.map(async (item) => {
            if (!item.url) {
                nextErrors[item.file_id] = true;
                return;
            }
            try {
                // Shared session cache — do not revoke on unmount.
                const url = await workspaceFileObjectUrl(item.url);
                if (!active) return;
                nextUrls[item.file_id] = url;
            } catch {
                if (active) nextErrors[item.file_id] = true;
            }
        });

        void Promise.all(loaders).then(() => {
            if (!active) return;
            setPreviewUrls(nextUrls);
            setPreviewErrors(nextErrors);
        });

        return () => {
            active = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- re-load when deliverable ids change
    }, [deliverables.map((d) => d.file_id).join("|")]);

    const deliverUploadProps: UploadProps = {
        showUploadList: false,
        multiple: true,
        accept: "image/jpeg,image/png,image/webp,video/mp4,video/webm,.jpg,.jpeg,.png,.webp,.mp4,.webm",
        disabled: busy || !canDeliver || !canAddMore,
        beforeUpload: (file, fileList) => {
            // Ant Design fires beforeUpload once per file; only start the batch on the first call.
            if (fileList[0] && file !== fileList[0]) return false;
            const remaining = MAX_TASK_DELIVERABLES_UI - deliverables.length;
            if (remaining <= 0) {
                message.warning(`每个任务最多 ${MAX_TASK_DELIVERABLES_UI} 个交付物`);
                return false;
            }
            const selected = (fileList as File[]).slice(0, remaining);
            if ((fileList as File[]).length > remaining) {
                message.warning(`还能再添加 ${remaining} 个，已自动截取前 ${remaining} 个`);
            }
            setBusy(true);
            void (async () => {
                let ok = 0;
                for (const f of selected) {
                    try {
                        await onUploadDeliverable(f);
                        ok += 1;
                    } catch (error) {
                        message.error(error instanceof Error ? error.message : "上传交付物失败");
                        break;
                    }
                }
                if (ok === 1) message.success("交付物已添加");
                else if (ok > 1) message.success(`已添加 ${ok} 个交付物`);
            })().finally(() => setBusy(false));
            return false;
        },
    };

    const handleDownload = async (item: WorkspaceTaskDeliverable) => {
        try {
            const cached = previewUrls[item.file_id];
            const url = cached || (item.url ? await workspaceFileObjectUrl(item.url) : "");
            if (!url) {
                message.warning("没有可下载的交付物");
                return;
            }
            // Shared session cache — never revoke object URLs from workspaceFileObjectUrl.
            saveAs(url, item.name || `deliverable-${item.file_id}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败");
        }
    };

    const activeUrl = activePreview ? previewUrls[activePreview.file_id] : "";
    const activeIsVideo = activePreview ? isVideoMime(activePreview.mime, activePreview.name) : false;

    return (
        <div
            className={`rounded-lg border border-stone-200 border-l-4 bg-card px-3 py-3 shadow-sm transition dark:border-stone-800 ${meta.accent} ${
                isDragging ? "opacity-60 ring-2 ring-sky-400/60" : ""
            }`}
        >
            <div className="flex flex-wrap items-start gap-2">
                {canEdit ? (
                    <div
                        className="mt-0.5 shrink-0 cursor-grab touch-none text-stone-400 active:cursor-grabbing"
                        title="拖到其它列更新进度"
                        draggable
                        onDragStart={(event) => {
                            event.dataTransfer.setData("text/workspace-task-id", task.id);
                            event.dataTransfer.setData("text/plain", task.id);
                            event.dataTransfer.effectAllowed = "move";
                            onDragStart?.(task.id);
                        }}
                        onDragEnd={() => onDragEnd?.()}
                    >
                        <GripVertical className="size-4" />
                    </div>
                ) : null}
                <div className="min-w-0 flex-1">
                    <div className="font-medium text-stone-900 dark:text-stone-100">{task.title}</div>
                    {task.body ? <div className="mt-1 text-xs text-stone-500">{task.body}</div> : null}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500">
                        <span className={`rounded-full px-1.5 py-0.5 ${meta.chip}`}>{meta.label}</span>
                        <span>创建：{task.created_by_name || task.created_by_email || task.created_by.slice(0, 8)}</span>
                        {formatTime(task.created_at) ? <span>· {formatTime(task.created_at)}</span> : null}
                        {assigneeLabels.length ? (
                            <>
                                <span>· 负责：</span>
                                {assigneeLabels.map((name) => (
                                    <Tag key={name} className="m-0 text-[11px]">
                                        {name}
                                    </Tag>
                                ))}
                            </>
                        ) : (
                            <span>· 未指派</span>
                        )}
                    </div>
                </div>
                {canEdit ? (
                    <Select
                        size="small"
                        className="w-28"
                        value={task.status}
                        disabled={busy}
                        options={taskStatusOptions}
                        onChange={(value) => {
                            setBusy(true);
                            void onChangeStatus(value).finally(() => setBusy(false));
                        }}
                    />
                ) : null}
                {canEdit ? (
                    <Button
                        size="small"
                        danger
                        icon={<Trash2 className="size-3.5" />}
                        disabled={busy}
                        onClick={() => {
                            setBusy(true);
                            void onDelete().finally(() => setBusy(false));
                        }}
                    />
                ) : null}
            </div>
            {canEdit ? (
                <div className="mt-2">
                    <Select
                        size="small"
                        mode="multiple"
                        allowClear
                        className="w-full"
                        placeholder="调整负责人（可多选）"
                        value={ids}
                        disabled={busy}
                        options={members.map((m) => ({
                            value: m.user_id,
                            label: memberDisplayName(m),
                        }))}
                        optionFilterProp="label"
                        onChange={(value) => {
                            setBusy(true);
                            void onChangeAssignees(value).finally(() => setBusy(false));
                        }}
                    />
                </div>
            ) : null}
            <div className="mt-2 rounded-md border border-dashed border-stone-300/80 bg-stone-50/70 px-2 py-2 dark:border-stone-700 dark:bg-stone-950/40">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1 text-[11px] font-medium text-stone-600 dark:text-stone-300">
                    <span className="inline-flex items-center gap-1">
                        <Paperclip className="size-3" />
                        交付物
                        {deliverables.length ? (
                            <span className="font-normal text-stone-400">
                                {deliverables.length}/{MAX_TASK_DELIVERABLES_UI}
                            </span>
                        ) : null}
                    </span>
                    {canDeliver && deliverables.length > 1 ? (
                        <Button
                            size="small"
                            type="link"
                            danger
                            className="h-auto px-0 text-[11px]"
                            disabled={busy}
                            onClick={() => {
                                setBusy(true);
                                void onClearDeliverable()
                                    .then(() => message.success("已清空全部交付物"))
                                    .catch((error) => message.error(error instanceof Error ? error.message : "清空失败"))
                                    .finally(() => setBusy(false));
                            }}
                        >
                            清空全部
                        </Button>
                    ) : null}
                </div>

                {deliverables.length ? (
                    <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-1.5">
                            {deliverables.map((item) => {
                                const url = previewUrls[item.file_id];
                                const failed = previewErrors[item.file_id];
                                const isVideo = isVideoMime(item.mime, item.name);
                                const ready = Boolean(url) && !failed;
                                return (
                                    <div
                                        key={item.file_id}
                                        className="overflow-hidden rounded-md border border-stone-200 bg-stone-100 dark:border-stone-700 dark:bg-stone-900"
                                    >
                                        <button
                                            type="button"
                                            className={`relative block w-full p-0 text-left ${isVideo ? "aspect-video" : "aspect-square"} ${
                                                ready ? "cursor-zoom-in" : "cursor-default"
                                            }`}
                                            title={ready ? "点击预览" : undefined}
                                            onClick={() => {
                                                if (ready) setActivePreview(item);
                                            }}
                                        >
                                            {ready ? (
                                                isVideo ? (
                                                    <video
                                                        src={url}
                                                        muted
                                                        playsInline
                                                        preload="metadata"
                                                        className="pointer-events-none size-full object-contain"
                                                    />
                                                ) : (
                                                    <img src={url} alt={item.name || "交付物"} className="size-full object-cover" />
                                                )
                                            ) : (
                                                <div className="flex size-full items-center justify-center text-[10px] text-stone-500">
                                                    {failed ? "预览失败" : "加载…"}
                                                </div>
                                            )}
                                        </button>
                                        <div className="space-y-1 px-1.5 py-1">
                                            <div className="truncate text-[10px] font-medium text-stone-700 dark:text-stone-200" title={item.name || ""}>
                                                {item.name || "文件"}
                                            </div>
                                            <div className="flex flex-wrap gap-0.5">
                                                {ready ? (
                                                    <Button size="small" className="h-6! px-1.5! text-[10px]!" onClick={() => setActivePreview(item)}>
                                                        预览
                                                    </Button>
                                                ) : null}
                                                <Button
                                                    size="small"
                                                    className="h-6! px-1.5! text-[10px]!"
                                                    icon={<Download className="size-3" />}
                                                    onClick={() => void handleDownload(item)}
                                                />
                                                {canDeliver ? (
                                                    <Button
                                                        size="small"
                                                        danger
                                                        className="h-6! px-1.5! text-[10px]!"
                                                        disabled={busy}
                                                        icon={<Trash2 className="size-3" />}
                                                        onClick={() => {
                                                            setBusy(true);
                                                            void onRemoveDeliverable(item.file_id)
                                                                .then(() => message.success("已删除该交付物"))
                                                                .catch((error) =>
                                                                    message.error(error instanceof Error ? error.message : "删除失败"),
                                                                )
                                                                .finally(() => setBusy(false));
                                                        }}
                                                    />
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        {canDeliver ? (
                            canAddMore ? (
                                <Upload {...deliverUploadProps}>
                                    <Button size="small" icon={<FileUp className="size-3.5" />} loading={busy}>
                                        继续添加
                                    </Button>
                                </Upload>
                            ) : (
                                <div className="text-[11px] text-stone-400">已达上限（{MAX_TASK_DELIVERABLES_UI} 个）</div>
                            )
                        ) : null}
                    </div>
                ) : canDeliver ? (
                    <Upload {...deliverUploadProps}>
                        <Button size="small" icon={<FileUp className="size-3.5" />} loading={busy}>
                            上传交付物（可多选）
                        </Button>
                    </Upload>
                ) : (
                    <div className="text-[11px] text-stone-400">暂无交付物</div>
                )}
            </div>

            <Modal
                open={Boolean(activePreview)}
                title={activePreview?.name || "交付物预览"}
                onCancel={() => setActivePreview(null)}
                footer={null}
                width={860}
                destroyOnHidden
                styles={{ body: { paddingTop: 8 } }}
            >
                {activePreview && activeUrl ? (
                    activeIsVideo ? (
                        <video
                            src={activeUrl}
                            controls
                            autoPlay
                            playsInline
                            className="max-h-[70vh] w-full rounded-md bg-black object-contain"
                        />
                    ) : (
                        <Image
                            src={activeUrl}
                            alt={activePreview.name || "交付物"}
                            className="max-h-[70vh] w-full object-contain"
                            rootClassName="block w-full"
                        />
                    )
                ) : (
                    <div className="flex min-h-40 items-center justify-center text-sm text-stone-500">
                        {activePreview && previewErrors[activePreview.file_id] ? "预览失败" : "加载中…"}
                    </div>
                )}
                {activePreview ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                        <Button icon={<Download className="size-3.5" />} onClick={() => void handleDownload(activePreview)}>
                            下载
                        </Button>
                    </div>
                ) : null}
            </Modal>
        </div>
    );
}

function ItemGrid({
    items,
    currentUserId,
    isOwner,
    emptyHint,
    itemTitleById,
    onOpen,
    onDelete,
    onSave,
    onGoShare,
}: {
    items: WorkspaceItem[];
    currentUserId: string;
    isOwner: boolean;
    emptyHint: string;
    itemTitleById?: Map<string, string>;
    onOpen: (item: WorkspaceItem) => void;
    onDelete: (item: WorkspaceItem) => void;
    onSave: (item: WorkspaceItem) => void;
    onGoShare?: () => void;
}) {
    if (!items.length) {
        return (
            <Empty
                description={
                    emptyHint === "素材墙" ? (
                        <span>
                            暂无素材。可点「上传本地文件」，或去「我的资产」
                            <Share2 className="mx-1 inline size-3.5" />
                            分享到工作空间。
                        </span>
                    ) : (
                        <span>
                            暂无生成分享。请到图/视频工作台历史点
                            <Share2 className="mx-1 inline size-3.5" />
                            分享到工作空间。
                        </span>
                    )
                }
                className="rounded-xl border border-dashed border-stone-300 bg-card/70 py-16 dark:border-stone-700"
            >
                {onGoShare ? (
                    <Button size="small" icon={<ExternalLink className="size-3.5" />} onClick={onGoShare}>
                        {emptyHint === "素材墙" ? "去我的资产" : "去工作台分享"}
                    </Button>
                ) : null}
            </Empty>
        );
    }
    return (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
                <WorkspaceItemCard
                    key={item.id}
                    item={item}
                    replacesLabel={item.replaces_item_id ? itemTitleById?.get(item.replaces_item_id) : undefined}
                    canDelete={item.created_by === currentUserId || isOwner}
                    onOpen={() => onOpen(item)}
                    onDelete={() => onDelete(item)}
                    onSave={() => onSave(item)}
                />
            ))}
        </div>
    );
}

function WorkspaceItemCard({
    item,
    replacesLabel,
    canDelete,
    onOpen,
    onDelete,
    onSave,
}: {
    item: WorkspaceItem;
    replacesLabel?: string;
    canDelete: boolean;
    onOpen: () => void;
    onDelete: () => void;
    onSave: () => void;
}) {
    const { message } = App.useApp();
    const [previewUrl, setPreviewUrl] = useState("");
    const [previewError, setPreviewError] = useState(false);
    const [visible, setVisible] = useState(false);
    const mediaRootRef = useRef<HTMLButtonElement | null>(null);

    // Lazy-load wall thumbnails only when near viewport — avoids 100 concurrent blob fetches.
    useEffect(() => {
        if (!item.file_url || !isMediaKind(item.kind)) return;
        const node = mediaRootRef.current;
        if (!node || typeof IntersectionObserver === "undefined") {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setVisible(true);
                    observer.disconnect();
                }
            },
            { rootMargin: "240px 0px" },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [item.file_url, item.kind]);

    useEffect(() => {
        let active = true;
        setPreviewUrl("");
        setPreviewError(false);
        if (!visible || !item.file_url || !isMediaKind(item.kind)) return;
        // Shared session cache — do not revoke here.
        void workspaceFileObjectUrl(item.file_url)
            .then((url) => {
                if (active) setPreviewUrl(url);
            })
            .catch(() => {
                if (active) setPreviewError(true);
            });
        return () => {
            active = false;
        };
    }, [visible, item.file_url, item.kind]);

    const handleDownload = async () => {
        if (!isDownloadableKind(item.kind)) {
            message.warning("没有可下载的文件");
            return;
        }
        if (!previewUrl && item.file_url) {
            try {
                const url = await workspaceFileObjectUrl(item.file_url);
                const ext = isDocumentKind(item.kind)
                    ? workspaceDocumentExt(item.mime, item.title)
                    : isVideoKind(item.kind)
                      ? "mp4"
                      : "png";
                saveAs(url, `${item.title || item.id}.${ext}`);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "下载失败");
            }
            return;
        }
        if (!previewUrl) {
            message.warning("没有可下载的文件");
            return;
        }
        const ext = isDocumentKind(item.kind)
            ? workspaceDocumentExt(item.mime, item.title)
            : isVideoKind(item.kind)
              ? "mp4"
              : "png";
        saveAs(previewUrl, `${item.title || item.id}.${ext}`);
    };

    const uploader = itemUploaderLabel(item);
    const counts = reactionCounts(item.reactions);
    const docSummary = isDocumentKind(item.kind) ? item.text_content?.trim() || "" : "";
    const docFormat = isDocumentKind(item.kind) ? workspaceDocumentFormat(item.mime, item.title) : "unknown";

    return (
        <div
            className={`overflow-hidden rounded-xl border bg-card transition ${
                item.is_final
                    ? "border-amber-400 shadow-[0_0_0_1px_rgba(251,191,36,0.35)] ring-1 ring-amber-300/50 dark:border-amber-500 dark:shadow-[0_0_0_1px_rgba(245,158,11,0.35)] dark:ring-amber-600/40"
                    : "border-stone-200 hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-600"
            }`}
        >
            <button
                ref={mediaRootRef}
                type="button"
                className={`relative block w-full cursor-zoom-in border-0 bg-stone-100 p-0 text-left dark:bg-stone-900 ${isVideoKind(item.kind) ? "aspect-video" : "aspect-square"}`}
                onClick={onOpen}
                title="点击查看详情"
            >
                {item.kind === WORKSPACE_ITEM_KIND.ASSET_TEXT ? (
                    <div className="flex size-full items-start overflow-hidden p-3 text-xs leading-5 text-stone-700 dark:text-stone-200">{item.text_content || "（空文本）"}</div>
                ) : isDocumentKind(item.kind) ? (
                    <div className="flex size-full flex-col gap-1.5 overflow-hidden p-3 text-left">
                        <div className="inline-flex w-fit items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
                            {docFormat === "markdown" ? "Markdown" : docFormat === "csv" ? "CSV" : "TXT"}
                        </div>
                        <div className="line-clamp-6 whitespace-pre-wrap text-xs leading-5 text-stone-700 dark:text-stone-200">
                            {docSummary || "文档 · 点击查看全文"}
                        </div>
                    </div>
                ) : previewUrl && !previewError ? (
                    isVideoKind(item.kind) ? (
                        <video src={previewUrl} muted playsInline preload="metadata" className="pointer-events-none size-full object-contain" />
                    ) : (
                        <img src={previewUrl} alt={item.title} className="size-full object-cover" />
                    )
                ) : (
                    <div className="flex size-full items-center justify-center text-xs text-stone-500">{previewError ? "预览失败" : "加载中…"}</div>
                )}
                <span className="absolute bottom-2 left-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] text-white">点击详情</span>
                {item.is_final ? (
                    <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-amber-950 shadow-sm">
                        <BadgeCheck className="size-3" />
                        终稿
                    </span>
                ) : null}
                {counts.total > 0 ? (
                    <span className={`absolute right-2 flex flex-wrap justify-end gap-1 ${item.is_final ? "top-8" : "top-2"}`}>
                        {counts.use > 0 ? (
                            <span className="rounded-md border border-emerald-400/80 bg-emerald-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm">
                                用 {counts.use}
                            </span>
                        ) : null}
                        {counts.revise > 0 ? (
                            <span className="rounded-md border border-sky-400/80 bg-sky-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm">
                                改 {counts.revise}
                            </span>
                        ) : null}
                        {counts.discard > 0 ? (
                            <span className="rounded-md border border-rose-400/80 bg-rose-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm">
                                弃 {counts.discard}
                            </span>
                        ) : null}
                    </span>
                ) : null}
            </button>
            <div className={`space-y-2 p-3 ${item.is_final ? "bg-amber-50/40 dark:bg-amber-950/20" : ""}`}>
                <div className="flex flex-wrap gap-1">
                    <Tag className="m-0 text-[11px]">{kindLabel(item.kind)}</Tag>
                    <Tag className="m-0 text-[11px]">{sourceTypeLabel(item.source_type)}</Tag>
                    {item.category ? <Tag className="m-0 text-[11px]">{assetCategoryLabel(item.category)}</Tag> : null}
                    {item.version ? <Tag className="m-0 text-[11px]">{item.version}</Tag> : null}
                    {displayModelName(item.model) ? <Tag className="m-0 text-[11px]">{displayModelName(item.model)}</Tag> : null}
                </div>
                {item.is_final ? (
                    <div className="inline-flex items-center gap-1 rounded-md border border-amber-400 bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900 shadow-sm dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100">
                        <BadgeCheck className="size-3.5" />
                        终稿 · 优先选用
                    </div>
                ) : null}
                {counts.total > 0 ? (
                    <div className="text-[11px] text-stone-500">
                        决议：用 {counts.use} · 改 {counts.revise} · 弃 {counts.discard}
                    </div>
                ) : null}
                <Typography.Paragraph ellipsis={{ rows: 2 }} className="mb-0! text-sm! font-medium!">
                    {item.title || "未命名"}
                </Typography.Paragraph>
                <div className="text-[11px] text-stone-500">
                    {uploader}
                    {formatTime(item.created_at) ? ` · ${formatTime(item.created_at)}` : ""}
                </div>
                {item.replaces_item_id ? (
                    <div className="text-[11px] text-stone-500">修订自：{replacesLabel || item.replaces_item_id.slice(0, 8)}</div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                    <Button size="small" onClick={onOpen}>
                        详情
                    </Button>
                    <Button size="small" onClick={() => void onSave()}>
                        存到我的资产
                    </Button>
                    {isDownloadableKind(item.kind) ? (
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => void handleDownload()}>
                            下载
                        </Button>
                    ) : null}
                    {canDelete ? (
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                            删除
                        </Button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function ItemDetailModal({
    item,
    items,
    categoryOptions,
    currentUserId,
    isOwner,
    canEdit,
    canDelete,
    onClose,
    onSave,
    onDelete,
    onUpdateMeta,
    onUpsertReaction,
    onClearReaction,
}: {
    item: WorkspaceItem | null;
    items: WorkspaceItem[];
    categoryOptions: Array<{ label: string; value: string }>;
    currentUserId: string;
    isOwner: boolean;
    canEdit: boolean;
    canDelete: boolean;
    onClose: () => void;
    onSave: (item: WorkspaceItem) => void;
    onDelete: (item: WorkspaceItem) => void;
    onUpdateMeta: (
        item: WorkspaceItem,
        patch: { title?: string; category?: string; version?: string; replacesItemId?: string | null; isFinal?: boolean },
    ) => Promise<WorkspaceItem | void>;
    onUpsertReaction: (item: WorkspaceItem, resolution: string, comment?: string) => Promise<WorkspaceItem | void>;
    onClearReaction: (item: WorkspaceItem, targetUserId?: string) => Promise<WorkspaceItem | void>;
}) {
    const { message } = App.useApp();
    const [previewUrl, setPreviewUrl] = useState("");
    const [previewError, setPreviewError] = useState(false);
    const [documentText, setDocumentText] = useState("");
    const [documentLoading, setDocumentLoading] = useState(false);
    const [metaBusy, setMetaBusy] = useState(false);
    const [reactionBusy, setReactionBusy] = useState(false);
    const [versionDraft, setVersionDraft] = useState("");
    const [titleDraft, setTitleDraft] = useState("");
    const [commentDraft, setCommentDraft] = useState("");

    useEffect(() => {
        let active = true;
        setPreviewUrl("");
        setPreviewError(false);
        if (!item?.file_url || !isMediaKind(item.kind)) return;
        // Shared session cache — do not revoke.
        void workspaceFileObjectUrl(item.file_url)
            .then((url) => {
                if (active) setPreviewUrl(url);
            })
            .catch(() => {
                if (active) setPreviewError(true);
            });
        return () => {
            active = false;
        };
    }, [item?.file_url, item?.kind, item?.id]);

    useEffect(() => {
        let active = true;
        setDocumentText("");
        setDocumentLoading(false);
        if (!item || !isDocumentKind(item.kind) || !item.file_url) return;
        setDocumentLoading(true);
        void workspaceFileText(item.file_url)
            .then((text) => {
                if (active) {
                    setDocumentText(text);
                    setDocumentLoading(false);
                }
            })
            .catch(() => {
                if (active) {
                    setDocumentText("");
                    setDocumentLoading(false);
                    setPreviewError(true);
                }
            });
        return () => {
            active = false;
        };
    }, [item?.file_url, item?.kind, item?.id]);

    useEffect(() => {
        setVersionDraft(item?.version || "");
        setTitleDraft(item?.title || "");
        const mine = (item?.reactions || []).find((r) => r.user_id === currentUserId);
        setCommentDraft(mine?.comment || "");
    }, [item?.id, item?.version, item?.title, item?.reactions, currentUserId]);

    const replaceOptions = useMemo(() => {
        if (!item) return [] as Array<{ label: string; value: string }>;
        return items
            .filter((candidate) => candidate.id !== item.id)
            .map((candidate) => ({
                value: candidate.id,
                label: `${candidate.title || candidate.id.slice(0, 8)}${candidate.version ? ` · ${candidate.version}` : ""}${candidate.is_final ? " · 终稿" : ""}`,
            }));
    }, [item, items]);

    const replacesLabel = item?.replaces_item_id
        ? items.find((x) => x.id === item.replaces_item_id)?.title || item.replaces_item_id.slice(0, 8)
        : "";

    const documentFormat = item && isDocumentKind(item.kind) ? workspaceDocumentFormat(item.mime, item.title) : "unknown";
    const csvRows = useMemo(() => {
        if (documentFormat !== "csv" || !documentText) return [] as string[][];
        return parseCsvPreview(documentText);
    }, [documentFormat, documentText]);
    const markdownHtml = useMemo(() => {
        if (documentFormat !== "markdown" || !documentText) return "";
        return renderSimpleMarkdown(documentText);
    }, [documentFormat, documentText]);

    const handleDownload = async () => {
        if (!item) return;
        if (!isDownloadableKind(item.kind)) {
            message.warning("没有可下载的文件");
            return;
        }
        try {
            const url = previewUrl || (item.file_url ? await workspaceFileObjectUrl(item.file_url) : "");
            if (!url) {
                message.warning("没有可下载的文件");
                return;
            }
            const ext = isDocumentKind(item.kind)
                ? workspaceDocumentExt(item.mime, item.title)
                : isVideoKind(item.kind)
                  ? "mp4"
                  : "png";
            // Shared session cache — never revoke object URLs from workspaceFileObjectUrl.
            saveAs(url, `${item.title || item.id}.${ext}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败");
        }
    };

    const runMeta = async (patch: {
        title?: string;
        category?: string;
        version?: string;
        replacesItemId?: string | null;
        isFinal?: boolean;
    }) => {
        if (!item) return;
        setMetaBusy(true);
        try {
            await onUpdateMeta(item, patch);
        } finally {
            setMetaBusy(false);
        }
    };

    const saveTitle = async () => {
        if (!item) return;
        const next = titleDraft.trim();
        if (!next) {
            message.warning("名称不能为空");
            setTitleDraft(item.title || "");
            return;
        }
        if (next === (item.title || "")) return;
        await runMeta({ title: next });
    };

    const myReaction = (item?.reactions || []).find((r) => r.user_id === currentUserId) || null;
    const counts = reactionCounts(item?.reactions);
    const sortedReactions = [...(item?.reactions || [])].sort((a, b) =>
        String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    );

    const castReaction = async (resolution: string) => {
        if (!item) return;
        setReactionBusy(true);
        try {
            await onUpsertReaction(item, resolution, commentDraft.trim());
        } finally {
            setReactionBusy(false);
        }
    };

    const clearMyReaction = async () => {
        if (!item) return;
        setReactionBusy(true);
        try {
            await onClearReaction(item);
            setCommentDraft("");
        } finally {
            setReactionBusy(false);
        }
    };

    const specsLine = [item?.width && item?.height ? `${item.width}×${item.height}` : "", formatBytes(item?.bytes), item?.mime]
        .filter(Boolean)
        .join(" · ");
    const modelName = displayModelName(item?.model);

    return (
        <Modal
            open={Boolean(item)}
            title={null}
            closable={false}
            onCancel={onClose}
            footer={null}
            width={1080}
            centered
            destroyOnHidden
            className="workspace-item-detail-modal [&_.ant-modal-content]:overflow-hidden! [&_.ant-modal-content]:rounded-2xl! [&_.ant-modal-content]:p-0!"
            styles={{
                body: { padding: 0, maxHeight: "min(88vh, 920px)", overflow: "hidden" },
            }}
        >
            {item ? (
                <div className="flex max-h-[min(88vh,920px)] flex-col lg:flex-row">
                    {/* Preview — media-first, no forced tall empty area */}
                    <div className="relative flex min-h-[240px] items-center justify-center bg-stone-950 lg:min-h-0 lg:w-[58%] lg:self-stretch">
                        <button
                            type="button"
                            onClick={onClose}
                            className="absolute right-3 top-3 z-10 inline-flex size-8 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm hover:bg-black/60 lg:hidden"
                            aria-label="关闭"
                        >
                            <X className="size-4" />
                        </button>
                        {item.kind === WORKSPACE_ITEM_KIND.ASSET_TEXT ? (
                            <div className="max-h-[min(52vh,560px)] w-full overflow-auto whitespace-pre-wrap p-5 text-sm leading-6 text-stone-100 lg:max-h-[min(84vh,880px)]">
                                {item.text_content || "（空文本）"}
                            </div>
                        ) : isDocumentKind(item.kind) ? (
                            <div className="max-h-[min(52vh,560px)] w-full overflow-auto p-5 lg:max-h-[min(84vh,880px)]">
                                {documentLoading ? (
                                    <div className="py-16 text-center text-sm text-stone-400">加载文档…</div>
                                ) : previewError ? (
                                    <div className="py-16 text-center text-sm text-stone-400">预览失败</div>
                                ) : documentFormat === "csv" ? (
                                    <div className="overflow-auto rounded-lg border border-stone-700 bg-stone-900/60">
                                        <table className="min-w-full border-collapse text-left text-xs text-stone-100">
                                            <tbody>
                                                {csvRows.map((row, rowIndex) => (
                                                    <tr key={`csv-row-${rowIndex}`} className={rowIndex === 0 ? "bg-stone-800/80 font-semibold" : "odd:bg-stone-900/40"}>
                                                        {row.map((cell, cellIndex) => (
                                                            <td key={`csv-cell-${rowIndex}-${cellIndex}`} className="border border-stone-700 px-2 py-1.5 align-top whitespace-pre-wrap">
                                                                {cell}
                                                            </td>
                                                        ))}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        {csvRows.length === 0 ? <div className="p-4 text-stone-400">空表格</div> : null}
                                    </div>
                                ) : documentFormat === "markdown" ? (
                                    <div
                                        className="ws-doc-md prose-invert max-w-none text-sm leading-6 text-stone-100 [&_.ws-doc-h1]:mb-3 [&_.ws-doc-h1]:text-xl [&_.ws-doc-h1]:font-semibold [&_.ws-doc-h2]:mb-2 [&_.ws-doc-h2]:mt-4 [&_.ws-doc-h2]:text-lg [&_.ws-doc-h2]:font-semibold [&_.ws-doc-h3]:mb-2 [&_.ws-doc-h3]:mt-3 [&_.ws-doc-h3]:font-semibold [&_.ws-doc-p]:mb-2 [&_.ws-doc-ul]:mb-2 [&_.ws-doc-ul]:list-disc [&_.ws-doc-ul]:pl-5 [&_.ws-doc-pre]:my-3 [&_.ws-doc-pre]:overflow-auto [&_.ws-doc-pre]:rounded-lg [&_.ws-doc-pre]:bg-black/40 [&_.ws-doc-pre]:p-3 [&_.ws-doc-code]:rounded [&_.ws-doc-code]:bg-black/35 [&_.ws-doc-code]:px-1 [&_.ws-doc-quote]:border-l-2 [&_.ws-doc-quote]:border-stone-500 [&_.ws-doc-quote]:pl-3 [&_.ws-doc-quote]:text-stone-300 [&_.ws-doc-link]:text-sky-300 [&_.ws-doc-link]:underline [&_.ws-doc-hr]:my-4 [&_.ws-doc-hr]:border-stone-600"
                                        dangerouslySetInnerHTML={{ __html: markdownHtml || "<p class='ws-doc-p'>（空文档）</p>" }}
                                    />
                                ) : (
                                    <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-6 text-stone-100">{documentText || "（空文档）"}</pre>
                                )}
                            </div>
                        ) : previewUrl && !previewError ? (
                            isVideoKind(item.kind) ? (
                                <video
                                    src={previewUrl}
                                    controls
                                    autoPlay
                                    playsInline
                                    className="max-h-[min(52vh,560px)] w-full object-contain lg:max-h-[min(84vh,880px)]"
                                />
                            ) : (
                                <Image
                                    src={previewUrl}
                                    alt={item.title}
                                    className="max-h-[min(52vh,560px)] w-full object-contain lg:max-h-[min(84vh,880px)]"
                                    rootClassName="flex w-full items-center justify-center [&_.ant-image-img]:mx-auto [&_.ant-image-img]:max-h-[min(52vh,560px)] [&_.ant-image-img]:object-contain lg:[&_.ant-image-img]:max-h-[min(84vh,880px)]"
                                />
                            )
                        ) : (
                            <div className="px-6 py-20 text-sm text-stone-400">{previewError ? "预览失败" : "加载中…"}</div>
                        )}
                    </div>

                    {/* Side panel */}
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-950 lg:border-l lg:border-t-0">
                        <div className="flex items-start justify-between gap-3 border-b border-stone-100 px-4 py-3 dark:border-stone-800">
                            <div className="min-w-0 flex-1">
                                {canEdit ? (
                                    <div className="flex items-center gap-2">
                                        <Input
                                            size="middle"
                                            className="min-w-0 flex-1 border-0! bg-transparent! px-0! text-base! font-semibold! shadow-none! focus:shadow-none!"
                                            prefix={<Pencil className="size-3.5 text-stone-400" />}
                                            placeholder="名称"
                                            value={titleDraft}
                                            disabled={metaBusy}
                                            maxLength={200}
                                            onChange={(e) => setTitleDraft(e.target.value)}
                                            onPressEnter={() => void saveTitle()}
                                            onBlur={() => void saveTitle()}
                                        />
                                        {titleDraft.trim() && titleDraft.trim() !== (item.title || "") ? (
                                            <Button size="small" type="link" className="px-1" disabled={metaBusy} onClick={() => void saveTitle()}>
                                                保存
                                            </Button>
                                        ) : null}
                                    </div>
                                ) : (
                                    <div className="truncate text-base font-semibold text-stone-900 dark:text-stone-50">{item.title || "未命名"}</div>
                                )}
                                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                    <Tag className="m-0 rounded-full text-[11px]">{kindLabel(item.kind)}</Tag>
                                    <Tag className="m-0 rounded-full text-[11px]">{sourceTypeLabel(item.source_type)}</Tag>
                                    {item.category ? <Tag className="m-0 rounded-full text-[11px]">{assetCategoryLabel(item.category)}</Tag> : null}
                                    {item.version ? <Tag className="m-0 rounded-full text-[11px]">{item.version}</Tag> : null}
                                    {item.is_final ? (
                                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-400 bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-950 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100">
                                            <BadgeCheck className="size-3" />
                                            终稿
                                        </span>
                                    ) : null}
                                </div>
                                <div className="mt-1.5 truncate text-[11px] text-stone-500">
                                    {itemUploaderLabel(item)}
                                    {formatTime(item.created_at) ? ` · ${formatTime(item.created_at)}` : ""}
                                    {specsLine ? ` · ${specsLine}` : ""}
                                    {modelName ? ` · ${modelName}` : ""}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={onClose}
                                className="hidden size-8 shrink-0 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-900 lg:inline-flex"
                                aria-label="关闭"
                            >
                                <X className="size-4" />
                            </button>
                        </div>

                        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-3 text-sm">
                            {canEdit ? (
                                <div className="space-y-1.5">
                                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">分类分区</div>
                                    <Select
                                        size="small"
                                        className="w-full"
                                        showSearch
                                        allowClear
                                        placeholder="人物 / 场景 / 道具…"
                                        value={item.category || undefined}
                                        disabled={metaBusy}
                                        options={categoryOptions.filter((o) => o.value !== "")}
                                        optionFilterProp="label"
                                        onChange={(value) => {
                                            const next = resolveAssetCategoryForSave(typeof value === "string" ? value : undefined) || "";
                                            void runMeta({ category: next });
                                        }}
                                    />
                                </div>
                            ) : null}

                            {item.prompt ? (
                                <div className="space-y-1.5">
                                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">提示词</div>
                                    <div className="max-h-28 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-700 dark:bg-stone-900 dark:text-stone-200">
                                        {item.prompt}
                                    </div>
                                </div>
                            ) : null}

                            {item.note ? (
                                <div className="space-y-1.5">
                                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">备注</div>
                                    <div className="text-xs leading-5 text-stone-600 dark:text-stone-300">{item.note}</div>
                                </div>
                            ) : null}

                            {canEdit ? (
                                <div className="space-y-2">
                                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">版本与终稿</div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Input
                                            size="small"
                                            className="w-24"
                                            placeholder="v2"
                                            value={versionDraft}
                                            disabled={metaBusy}
                                            onChange={(e) => setVersionDraft(e.target.value)}
                                            onPressEnter={() => void runMeta({ version: versionDraft.trim() })}
                                        />
                                        <Button size="small" disabled={metaBusy} onClick={() => void runMeta({ version: versionDraft.trim() })}>
                                            保存版本
                                        </Button>
                                        <Button
                                            size="small"
                                            type={item.is_final ? "default" : "primary"}
                                            className={
                                                item.is_final
                                                    ? "border-amber-400 text-amber-900 dark:border-amber-500 dark:text-amber-100"
                                                    : "border-amber-500! bg-amber-500! text-white! hover:border-amber-600! hover:bg-amber-600!"
                                            }
                                            icon={<BadgeCheck className="size-3.5" />}
                                            loading={metaBusy}
                                            onClick={() => void runMeta({ isFinal: !item.is_final })}
                                        >
                                            {item.is_final ? "取消终稿" : "设为终稿"}
                                        </Button>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Select
                                            size="small"
                                            allowClear
                                            className="min-w-0 flex-1"
                                            placeholder="关联替代（修订自…）"
                                            value={item.replaces_item_id || undefined}
                                            disabled={metaBusy}
                                            options={replaceOptions}
                                            optionFilterProp="label"
                                            showSearch
                                            onChange={(value) => void runMeta({ replacesItemId: value || "" })}
                                        />
                                        {item.replaces_item_id ? (
                                            <Button size="small" danger icon={<X className="size-3.5" />} disabled={metaBusy} onClick={() => void runMeta({ replacesItemId: "" })}>
                                                取消
                                            </Button>
                                        ) : null}
                                    </div>
                                    {item.replaces_item_id ? (
                                        <div className="text-[11px] text-sky-700 dark:text-sky-300">修订自：{replacesLabel}</div>
                                    ) : null}
                                </div>
                            ) : item.replaces_item_id ? (
                                <div className="text-xs text-stone-500">修订自：{replacesLabel}</div>
                            ) : null}

                            <div className="space-y-2 border-t border-stone-100 pt-3 dark:border-stone-800">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">团队决议</div>
                                    {counts.total > 0 ? (
                                        <div className="text-[11px] text-stone-500">
                                            用 {counts.use} · 改 {counts.revise} · 弃 {counts.discard}
                                        </div>
                                    ) : (
                                        <div className="text-[11px] text-stone-400">批片时一键标记</div>
                                    )}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    <Button
                                        size="small"
                                        type={myReaction?.resolution === WORKSPACE_ITEM_RESOLUTION.USE ? "primary" : "default"}
                                        className={
                                            myReaction?.resolution === WORKSPACE_ITEM_RESOLUTION.USE
                                                ? "border-emerald-500! bg-emerald-500! text-white! hover:border-emerald-600! hover:bg-emerald-600!"
                                                : "border-emerald-300 text-emerald-800 dark:border-emerald-700 dark:text-emerald-200"
                                        }
                                        loading={reactionBusy}
                                        onClick={() => void castReaction(WORKSPACE_ITEM_RESOLUTION.USE)}
                                    >
                                        用
                                    </Button>
                                    <Button
                                        size="small"
                                        type={myReaction?.resolution === WORKSPACE_ITEM_RESOLUTION.REVISE ? "primary" : "default"}
                                        className={
                                            myReaction?.resolution === WORKSPACE_ITEM_RESOLUTION.REVISE
                                                ? "border-sky-500! bg-sky-500! text-white! hover:border-sky-600! hover:bg-sky-600!"
                                                : "border-sky-300 text-sky-800 dark:border-sky-700 dark:text-sky-200"
                                        }
                                        loading={reactionBusy}
                                        onClick={() => void castReaction(WORKSPACE_ITEM_RESOLUTION.REVISE)}
                                    >
                                        改
                                    </Button>
                                    <Button
                                        size="small"
                                        type={myReaction?.resolution === WORKSPACE_ITEM_RESOLUTION.DISCARD ? "primary" : "default"}
                                        className={
                                            myReaction?.resolution === WORKSPACE_ITEM_RESOLUTION.DISCARD
                                                ? "border-rose-500! bg-rose-500! text-white! hover:border-rose-600! hover:bg-rose-600!"
                                                : "border-rose-300 text-rose-800 dark:border-rose-700 dark:text-rose-200"
                                        }
                                        loading={reactionBusy}
                                        onClick={() => void castReaction(WORKSPACE_ITEM_RESOLUTION.DISCARD)}
                                    >
                                        弃
                                    </Button>
                                    {myReaction ? (
                                        <Button size="small" type="text" danger disabled={reactionBusy} onClick={() => void clearMyReaction()}>
                                            取消
                                        </Button>
                                    ) : null}
                                </div>
                                <Input.TextArea
                                    size="small"
                                    rows={2}
                                    maxLength={200}
                                    showCount
                                    placeholder="可选短评"
                                    value={commentDraft}
                                    disabled={reactionBusy}
                                    onChange={(e) => setCommentDraft(e.target.value)}
                                />
                                {myReaction ? (
                                    <div className="text-[11px] text-stone-500">
                                        我的决议：
                                        <span className="font-medium text-stone-800 dark:text-stone-100">{resolutionLabel(myReaction.resolution)}</span>
                                        {commentDraft.trim() !== (myReaction.comment || "") ? (
                                            <Button
                                                type="link"
                                                size="small"
                                                className="h-auto px-1 text-[11px]"
                                                disabled={reactionBusy || !myReaction.resolution}
                                                onClick={() => void castReaction(myReaction.resolution)}
                                            >
                                                更新短评
                                            </Button>
                                        ) : null}
                                    </div>
                                ) : null}
                                {sortedReactions.length ? (
                                    <div className="max-h-28 space-y-1.5 overflow-auto">
                                        {sortedReactions.map((r) => (
                                            <div key={r.user_id} className="flex items-start justify-between gap-2 rounded-lg bg-stone-50 px-2 py-1.5 text-[11px] dark:bg-stone-900/60">
                                                <div className="min-w-0">
                                                    <span
                                                        className={`mr-1.5 inline-flex rounded px-1 py-0.5 font-semibold ${
                                                            r.resolution === WORKSPACE_ITEM_RESOLUTION.USE
                                                                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                                                                : r.resolution === WORKSPACE_ITEM_RESOLUTION.REVISE
                                                                  ? "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200"
                                                                  : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200"
                                                        }`}
                                                    >
                                                        {resolutionLabel(r.resolution)}
                                                    </span>
                                                    <span className="font-medium text-stone-800 dark:text-stone-100">
                                                        {r.display_name || r.email || r.user_id.slice(0, 8)}
                                                    </span>
                                                    {r.comment ? <div className="mt-0.5 whitespace-pre-wrap text-stone-600 dark:text-stone-300">{r.comment}</div> : null}
                                                </div>
                                                {isOwner && r.user_id !== currentUserId ? (
                                                    <Button
                                                        type="text"
                                                        size="small"
                                                        danger
                                                        className="h-auto shrink-0 px-1 text-[11px]"
                                                        disabled={reactionBusy}
                                                        onClick={() => {
                                                            setReactionBusy(true);
                                                            void onClearReaction(item, r.user_id).finally(() => setReactionBusy(false));
                                                        }}
                                                    >
                                                        清除
                                                    </Button>
                                                ) : null}
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        </div>

                        <div className="flex flex-wrap gap-2 border-t border-stone-200 bg-white px-4 py-3 dark:border-stone-800 dark:bg-stone-950">
                            <Button type="primary" onClick={() => onSave(item)}>
                                存到我的资产
                            </Button>
                            {isDownloadableKind(item.kind) ? (
                                <Button icon={<Download className="size-3.5" />} onClick={() => void handleDownload()}>
                                    下载
                                </Button>
                            ) : null}
                            {canDelete ? (
                                <Button danger icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(item)}>
                                    删除
                                </Button>
                            ) : null}
                        </div>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
