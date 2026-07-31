import { App, Button, Empty, Image, Input, Modal, Select, Spin, Tabs, Tag, Typography, Upload } from "antd";
import type { UploadProps } from "antd";
import {
    ArrowLeft,
    Copy,
    Download,
    ExternalLink,
    FileUp,
    Images,
    Paperclip,
    RefreshCw,
    Share2,
    Trash2,
    Upload as UploadIcon,
    Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { saveAs } from "file-saver";

import { useCopyText } from "@/hooks/use-copy-text";
import { useAuthStore } from "@/stores/use-auth-store";
import { useAssetStore } from "@/stores/use-asset-store";
import {
    WORKSPACE_ITEM_KIND,
    WORKSPACE_ITEM_SOURCE,
    WORKSPACE_ROLE,
    WORKSPACE_TASK_STATUS,
    archiveWorkspace,
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
    resetWorkspaceInvite,
    sourceTypeLabel,
    taskAssigneeIds,
    taskDeliverables,
    updateWorkspaceTask,
    workspaceFileObjectUrl,
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

function isVideoKind(kind: string) {
    return kind === WORKSPACE_ITEM_KIND.ASSET_VIDEO || kind === WORKSPACE_ITEM_KIND.GEN_VIDEO;
}

function isAssetWallKind(kind: string) {
    return kind.startsWith("asset_") || kind === WORKSPACE_ITEM_KIND.ASSET_TEXT;
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
    const addAsset = useAssetStore((s) => s.addAsset);
    const [loading, setLoading] = useState(true);
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

    const isOwner = workspace?.role === WORKSPACE_ROLE.OWNER || workspace?.owner_id === user?.id;
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

    const load = useCallback(async () => {
        if (!user || !id) return;
        setLoading(true);
        try {
            const detail = await getWorkspace(id);
            setWorkspace(detail.workspace);
            setMembers(detail.members || []);
            const [itemRes, taskRes] = await Promise.all([listWorkspaceItems(id, { pageSize: 100 }), listWorkspaceTasks(id)]);
            setItems(itemRes.items || []);
            setTasks(taskRes.items || []);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载工作空间失败");
            navigate("/workspace");
        } finally {
            setLoading(false);
        }
    }, [id, message, navigate, user]);

    useEffect(() => {
        void load();
    }, [load]);

    const assetItems = useMemo(() => items.filter((i) => isAssetWallKind(i.kind)), [items]);
    const genItems = useMemo(() => items.filter((i) => i.kind.startsWith("gen_")), [items]);

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
                navigate("/workspace");
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
            if (!item.file_url) {
                message.error("没有可保存的文件");
                return;
            }
            const objectUrl = await workspaceFileObjectUrl(item.file_url);
            const blob = await fetch(objectUrl).then((r) => r.blob());
            URL.revokeObjectURL(objectUrl);
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
                if (!isImage && !isVideo) {
                    message.warning(`已跳过不支持的文件：${file.name}`);
                    fail += 1;
                    continue;
                }
                try {
                    const created = await createWorkspaceItem(id, {
                        kind: isImage ? WORKSPACE_ITEM_KIND.ASSET_IMAGE : WORKSPACE_ITEM_KIND.ASSET_VIDEO,
                        title: file.name.replace(/\.[^.]+$/, "") || file.name,
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
            if (ok) message.success(`已上传 ${ok} 个文件到素材墙${fail ? `，${fail} 个失败` : ""}`);
        } finally {
            setUploadBusy(false);
        }
    };

    const uploadProps: UploadProps = {
        multiple: true,
        showUploadList: false,
        accept: "image/jpeg,image/png,image/webp,video/mp4,video/webm,.jpg,.jpeg,.png,.webp,.mp4,.webm",
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
                        <button type="button" className="mb-2 inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-200" onClick={() => navigate("/workspace")}>
                            <ArrowLeft className="size-3.5" />
                            全部工作空间
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
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => void load()}>
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

                <Tabs
                    activeKey={tab}
                    onChange={setTab}
                    items={[
                        {
                            key: "assets",
                            label: `素材墙 (${assetItems.length})`,
                            children: (
                                <div className="space-y-3">
                                    <div className="rounded-lg border border-dashed border-stone-300 bg-card/80 px-3 py-2 text-xs leading-5 text-stone-600 shadow-sm dark:border-stone-700 dark:text-stone-300">
                                        <strong className="font-medium text-stone-800 dark:text-stone-100">素材墙</strong>
                                        ：团队可复用的素材库内容。可来自「我的资产」分享，或本页「上传本地文件」（jpg/png/webp/mp4/webm）。点击卡片可看详情与预览。
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            <Button size="small" icon={<Images className="size-3.5" />} onClick={() => navigate("/assets")}>
                                                去我的资产选择分享
                                            </Button>
                                            <Upload {...uploadProps}>
                                                <Button size="small" icon={<FileUp className="size-3.5" />} loading={uploadBusy}>
                                                    上传到素材墙
                                                </Button>
                                            </Upload>
                                        </div>
                                    </div>
                                    <ItemGrid
                                        items={assetItems}
                                        currentUserId={user.id}
                                        isOwner={Boolean(isOwner)}
                                        emptyHint="素材墙"
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
                            label: `生成分享 (${genItems.length})`,
                            children: (
                                <div className="space-y-3">
                                    <div className="rounded-lg border border-stone-200 bg-card/80 px-3 py-2 text-xs leading-5 text-stone-600 shadow-sm dark:border-stone-800 dark:text-stone-300">
                                        <strong className="font-medium text-stone-800 dark:text-stone-100">生成分享</strong>
                                        ：来自图/视频工作台的本机或云端历史，通常带 prompt / model，方便对照生成过程。不会自动全量同步；需在工作台历史点「分享到工作空间」。点击卡片可看详情。
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            <Button size="small" icon={<Images className="size-3.5" />} onClick={() => navigate("/image")}>
                                                去图片工作台分享
                                            </Button>
                                            <Button size="small" icon={<Video className="size-3.5" />} onClick={() => navigate("/video")}>
                                                去视频工作台分享
                                            </Button>
                                        </div>
                                    </div>
                                    <ItemGrid
                                        items={genItems}
                                        currentUserId={user.id}
                                        isOwner={Boolean(isOwner)}
                                        emptyHint="生成分享"
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
                                        <div className="grid gap-3 lg:grid-cols-3">
                                            {[WORKSPACE_TASK_STATUS.TODO, WORKSPACE_TASK_STATUS.DOING, WORKSPACE_TASK_STATUS.DONE].map((status) => {
                                                const meta = TASK_STATUS_META[status];
                                                const columnTasks = tasksByStatus[status] || [];
                                                return (
                                                    <div key={status} className={`rounded-xl border p-2 ${meta.column}`}>
                                                        <div className="mb-2 flex items-center justify-between px-1">
                                                            <div className="flex items-center gap-2 text-sm font-medium text-stone-800 dark:text-stone-100">
                                                                <span className={`size-2.5 rounded-sm ${meta.bar}`} />
                                                                {meta.label}
                                                            </div>
                                                            <span className={`rounded-full px-2 py-0.5 text-[11px] ${meta.chip}`}>{columnTasks.length}</span>
                                                        </div>
                                                        <div className="space-y-2">
                                                            {columnTasks.length ? (
                                                                columnTasks.map((task) => {
                                                                    const ids = taskAssigneeIds(task);
                                                                    const canEdit = task.created_by === user.id || Boolean(isOwner);
                                                                    const canDeliver = canEdit || ids.includes(user.id);
                                                                    return (
                                                                        <TaskRow
                                                                            key={task.id}
                                                                            task={task}
                                                                            members={members}
                                                                            memberNameById={memberNameById}
                                                                            canEdit={canEdit}
                                                                            canDeliver={canDeliver}
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
                                                                    暂无
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
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
                                    {members.map((m) => (
                                        <div key={m.id} className="flex items-center justify-between rounded-lg border border-stone-200 bg-card/90 px-3 py-2 text-sm shadow-sm dark:border-stone-800">
                                            <div>
                                                <div className="font-medium">{memberDisplayName(m)}</div>
                                                <div className="text-xs text-stone-500">{m.email}</div>
                                            </div>
                                            <Tag className="m-0">{m.role === "owner" ? "所有者" : "成员"}</Tag>
                                        </div>
                                    ))}
                                </div>
                            ),
                        },
                    ]}
                />

                <ItemDetailModal
                    item={detailItem}
                    canDelete={Boolean(detailItem && (detailItem.created_by === user.id || isOwner))}
                    onClose={() => setDetailItem(null)}
                    onSave={(item) => void handleSaveToAssets(item)}
                    onDelete={(item) => handleDeleteItem(item)}
                />
                </div>
            </main>
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
        const objectUrls: string[] = [];
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
                const url = await workspaceFileObjectUrl(item.url);
                if (!active) {
                    URL.revokeObjectURL(url);
                    return;
                }
                objectUrls.push(url);
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
            for (const url of objectUrls) URL.revokeObjectURL(url);
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
            saveAs(url, item.name || `deliverable-${item.file_id}`);
            if (!cached) URL.revokeObjectURL(url);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败");
        }
    };

    const activeUrl = activePreview ? previewUrls[activePreview.file_id] : "";
    const activeIsVideo = activePreview ? isVideoMime(activePreview.mime, activePreview.name) : false;

    return (
        <div className={`rounded-lg border border-stone-200 border-l-4 bg-card px-3 py-3 shadow-sm dark:border-stone-800 ${meta.accent}`}>
            <div className="flex flex-wrap items-start gap-2">
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
    onOpen,
    onDelete,
    onSave,
    onGoShare,
}: {
    items: WorkspaceItem[];
    currentUserId: string;
    isOwner: boolean;
    emptyHint: string;
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
    canDelete,
    onOpen,
    onDelete,
    onSave,
}: {
    item: WorkspaceItem;
    canDelete: boolean;
    onOpen: () => void;
    onDelete: () => void;
    onSave: () => void;
}) {
    const { message } = App.useApp();
    const [previewUrl, setPreviewUrl] = useState("");
    const [previewError, setPreviewError] = useState(false);

    useEffect(() => {
        let active = true;
        let objectUrl = "";
        setPreviewUrl("");
        setPreviewError(false);
        if (!item.file_url || !isMediaKind(item.kind)) return;
        void workspaceFileObjectUrl(item.file_url)
            .then((url) => {
                if (!active) {
                    URL.revokeObjectURL(url);
                    return;
                }
                objectUrl = url;
                setPreviewUrl(url);
            })
            .catch(() => {
                if (active) setPreviewError(true);
            });
        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [item.file_url, item.kind]);

    const handleDownload = async () => {
        if (!previewUrl && item.file_url) {
            try {
                const url = await workspaceFileObjectUrl(item.file_url);
                const ext = isVideoKind(item.kind) ? "mp4" : "png";
                saveAs(url, `${item.title || item.id}.${ext}`);
                URL.revokeObjectURL(url);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "下载失败");
            }
            return;
        }
        if (!previewUrl) {
            message.warning("没有可下载的文件");
            return;
        }
        const ext = isVideoKind(item.kind) ? "mp4" : "png";
        saveAs(previewUrl, `${item.title || item.id}.${ext}`);
    };

    const uploader = itemUploaderLabel(item);

    return (
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-card transition hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-600">
            <button type="button" className={`relative block w-full cursor-zoom-in border-0 bg-stone-100 p-0 text-left dark:bg-stone-900 ${isVideoKind(item.kind) ? "aspect-video" : "aspect-square"}`} onClick={onOpen} title="点击查看详情">
                {item.kind === WORKSPACE_ITEM_KIND.ASSET_TEXT ? (
                    <div className="flex size-full items-start overflow-hidden p-3 text-xs leading-5 text-stone-700 dark:text-stone-200">{item.text_content || "（空文本）"}</div>
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
            </button>
            <div className="space-y-2 p-3">
                <div className="flex flex-wrap gap-1">
                    <Tag className="m-0 text-[11px]">{kindLabel(item.kind)}</Tag>
                    <Tag className="m-0 text-[11px]">{sourceTypeLabel(item.source_type)}</Tag>
                    {displayModelName(item.model) ? <Tag className="m-0 text-[11px]">{displayModelName(item.model)}</Tag> : null}
                </div>
                <Typography.Paragraph ellipsis={{ rows: 2 }} className="mb-0! text-sm! font-medium!">
                    {item.title || "未命名"}
                </Typography.Paragraph>
                <div className="text-[11px] text-stone-500">
                    {uploader}
                    {formatTime(item.created_at) ? ` · ${formatTime(item.created_at)}` : ""}
                </div>
                {item.prompt ? (
                    <Typography.Paragraph ellipsis={{ rows: 2 }} className="mb-0! text-xs! text-stone-500!">
                        {item.prompt}
                    </Typography.Paragraph>
                ) : null}
                <div className="flex flex-wrap gap-2">
                    <Button size="small" onClick={onOpen}>
                        详情
                    </Button>
                    <Button size="small" onClick={() => void onSave()}>
                        存到我的资产
                    </Button>
                    {isMediaKind(item.kind) ? (
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
    canDelete,
    onClose,
    onSave,
    onDelete,
}: {
    item: WorkspaceItem | null;
    canDelete: boolean;
    onClose: () => void;
    onSave: (item: WorkspaceItem) => void;
    onDelete: (item: WorkspaceItem) => void;
}) {
    const { message } = App.useApp();
    const [previewUrl, setPreviewUrl] = useState("");
    const [previewError, setPreviewError] = useState(false);

    useEffect(() => {
        let active = true;
        let objectUrl = "";
        setPreviewUrl("");
        setPreviewError(false);
        if (!item?.file_url || !isMediaKind(item.kind)) return;
        void workspaceFileObjectUrl(item.file_url)
            .then((url) => {
                if (!active) {
                    URL.revokeObjectURL(url);
                    return;
                }
                objectUrl = url;
                setPreviewUrl(url);
            })
            .catch(() => {
                if (active) setPreviewError(true);
            });
        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [item?.file_url, item?.kind, item?.id]);

    const handleDownload = async () => {
        if (!item) return;
        try {
            const url = previewUrl || (item.file_url ? await workspaceFileObjectUrl(item.file_url) : "");
            if (!url) {
                message.warning("没有可下载的文件");
                return;
            }
            const ext = isVideoKind(item.kind) ? "mp4" : "png";
            saveAs(url, `${item.title || item.id}.${ext}`);
            if (!previewUrl) URL.revokeObjectURL(url);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败");
        }
    };

    return (
        <Modal
            open={Boolean(item)}
            title={item?.title || "分享详情"}
            onCancel={onClose}
            footer={null}
            width={920}
            destroyOnHidden
            styles={{ body: { paddingTop: 8 } }}
        >
            {item ? (
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(240px,0.8fr)]">
                    <div className="overflow-hidden rounded-lg border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-900">
                        {item.kind === WORKSPACE_ITEM_KIND.ASSET_TEXT ? (
                            <div className="max-h-[70vh] overflow-auto whitespace-pre-wrap p-4 text-sm leading-6 text-stone-800 dark:text-stone-100">{item.text_content || "（空文本）"}</div>
                        ) : previewUrl && !previewError ? (
                            isVideoKind(item.kind) ? (
                                <video src={previewUrl} controls autoPlay playsInline className="max-h-[70vh] w-full bg-black object-contain" />
                            ) : (
                                <Image src={previewUrl} alt={item.title} className="max-h-[70vh] w-full object-contain" rootClassName="block w-full" />
                            )
                        ) : (
                            <div className="flex min-h-64 items-center justify-center text-sm text-stone-500">{previewError ? "预览失败" : "加载中…"}</div>
                        )}
                    </div>
                    <div className="space-y-3 text-sm">
                        <div className="flex flex-wrap gap-1">
                            <Tag className="m-0">{kindLabel(item.kind)}</Tag>
                            <Tag className="m-0">{sourceTypeLabel(item.source_type)}</Tag>
                            {item.category ? <Tag className="m-0">{item.category}</Tag> : null}
                        </div>
                        <div>
                            <div className="text-xs text-stone-500">上传者</div>
                            <div className="font-medium text-stone-900 dark:text-stone-100">{itemUploaderLabel(item)}</div>
                            {item.created_by_email ? <div className="text-xs text-stone-500">{item.created_by_email}</div> : null}
                        </div>
                        <div>
                            <div className="text-xs text-stone-500">时间</div>
                            <div>{formatTime(item.created_at) || "—"}</div>
                        </div>
                        {displayModelName(item.model) ? (
                            <div>
                                <div className="text-xs text-stone-500">模型</div>
                                <div>{displayModelName(item.model)}</div>
                            </div>
                        ) : null}
                        {(item.width || item.height || item.bytes) ? (
                            <div>
                                <div className="text-xs text-stone-500">规格</div>
                                <div>
                                    {[item.width && item.height ? `${item.width}×${item.height}` : "", formatBytes(item.bytes), item.mime].filter(Boolean).join(" · ") || "—"}
                                </div>
                            </div>
                        ) : null}
                        {item.prompt ? (
                            <div>
                                <div className="text-xs text-stone-500">提示词</div>
                                <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-stone-50 p-2 text-xs leading-5 dark:bg-stone-950">{item.prompt}</div>
                            </div>
                        ) : null}
                        {item.note ? (
                            <div>
                                <div className="text-xs text-stone-500">备注</div>
                                <div className="text-xs leading-5">{item.note}</div>
                            </div>
                        ) : null}
                        <div className="flex flex-wrap gap-2 pt-2">
                            <Button type="primary" onClick={() => onSave(item)}>
                                存到我的资产
                            </Button>
                            {isMediaKind(item.kind) ? (
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
