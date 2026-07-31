import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Image, Modal, Spin, Tag, Typography } from "antd";
import { CheckSquare, Download, Expand, RefreshCw, Share2, Trash2 } from "lucide-react";
import { saveAs } from "file-saver";

import { SelectCheckbox, SelectionCount, SelectionToolbar } from "@/components/ui/select-checkbox";
import { ShareToWorkspaceModal, type ShareDraft } from "@/components/workspace/share-to-workspace-modal";
import { cloudFileObjectUrl, deleteCloudJob, listCloudJobs, type CloudJob } from "@/services/cloud-api";
import { WORKSPACE_ITEM_KIND, WORKSPACE_ITEM_SOURCE } from "@/services/workspace-api";
import { useAuthStore } from "@/stores/use-auth-store";
import { cn } from "@/lib/utils";

type Props = {
    type: "image" | "video";
    /** 外部触发刷新（例如刚上云成功） */
    refreshKey?: number;
};

export function CloudHistoryPanel({ type, refreshKey = 0 }: Props) {
    const { message, modal } = App.useApp();
    const user = useAuthStore((s) => s.user);
    const logout = useAuthStore((s) => s.logout);
    const refreshUsage = useAuthStore((s) => s.refreshUsage);
    const [loading, setLoading] = useState(false);
    const [batchBusy, setBatchBusy] = useState(false);
    const [items, setItems] = useState<CloudJob[]>([]);
    const [total, setTotal] = useState(0);
    const [error, setError] = useState("");
    const [videoPreview, setVideoPreview] = useState<{ url: string; title: string } | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [shareDrafts, setShareDrafts] = useState<ShareDraft[]>([]);
    const [shareOpen, setShareOpen] = useState(false);

    const load = useCallback(async () => {
        if (!user) {
            setItems([]);
            setTotal(0);
            setError("");
            setSelectedIds([]);
            return;
        }
        setLoading(true);
        setError("");
        try {
            const data = await listCloudJobs({ type, page: 1, pageSize: 50 });
            const nextItems = data.items || [];
            setItems(nextItems);
            setTotal(data.total || 0);
            // Keep only selections that still exist after refresh/delete.
            setSelectedIds((ids) => {
                if (!ids.length) return ids;
                const alive = new Set(nextItems.map((job) => job.id));
                const next = ids.filter((id) => alive.has(id));
                return next.length === ids.length ? ids : next;
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : "加载云端历史失败";
            setError(msg);
            if (msg.includes("401") || msg.includes("登录")) {
                await logout();
            }
        } finally {
            setLoading(false);
        }
    }, [logout, type, user]);

    useEffect(() => {
        void load();
    }, [load, refreshKey]);

    useEffect(() => {
        // Close video lightbox when leaving cloud panel / switching type.
        setVideoPreview(null);
        setSelectedIds([]);
    }, [type, refreshKey]);

    const itemIds = useMemo(() => items.map((job) => job.id), [items]);
    const selectedJobs = useMemo(() => {
        if (!selectedIds.length) return [] as CloudJob[];
        const idSet = new Set(selectedIds);
        return items.filter((job) => idSet.has(job.id));
    }, [items, selectedIds]);
    const allSelected = Boolean(itemIds.length) && itemIds.every((id) => selectedIds.includes(id));
    const someSelected = itemIds.some((id) => selectedIds.includes(id));

    const toggleSelected = (id: string, checked: boolean) => {
        setSelectedIds((ids) => (checked ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((item) => item !== id)));
    };

    const selectAll = () => setSelectedIds(itemIds);
    const clearSelection = () => setSelectedIds([]);

    const handleDelete = (job: CloudJob) => {
        modal.confirm({
            title: "删除云端记录",
            content: "将删除服务器上的记录与文件，且不可恢复。本机记录不受影响。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await deleteCloudJob(job.id);
                message.success("已删除云端记录");
                setSelectedIds((ids) => ids.filter((id) => id !== job.id));
                await load();
                void refreshUsage();
            },
        });
    };

    const handleDownload = async (job: CloudJob) => {
        if (!job.file?.url) {
            message.error("没有可下载的文件");
            return;
        }
        try {
            const objectUrl = await cloudFileObjectUrl(job.file.url);
            const ext = type === "video" ? "mp4" : "png";
            saveAs(objectUrl, `${job.id}.${ext}`);
            URL.revokeObjectURL(objectUrl);
        } catch (e) {
            message.error(e instanceof Error ? e.message : "下载失败");
            throw e;
        }
    };

    const handleBatchDownload = async () => {
        if (!selectedJobs.length) {
            message.warning("请先勾选要下载的云端记录");
            return;
        }
        setBatchBusy(true);
        let ok = 0;
        let failed = 0;
        try {
            for (const job of selectedJobs) {
                try {
                    await handleDownload(job);
                    ok += 1;
                } catch {
                    failed += 1;
                }
            }
            if (ok) message.success(`已下载 ${ok} 项${failed ? `，失败 ${failed} 项` : ""}`);
            else message.error("批量下载失败");
        } finally {
            setBatchBusy(false);
        }
    };

    const openShareJobs = async (jobs: CloudJob[]) => {
        if (!jobs.length) {
            message.warning("请先勾选要分享的云端记录");
            return;
        }
        setBatchBusy(true);
        const drafts: ShareDraft[] = [];
        let failed = 0;
        try {
            for (const job of jobs) {
                if (!job.file?.url) {
                    failed += 1;
                    continue;
                }
                try {
                    const objectUrl = await cloudFileObjectUrl(job.file.url);
                    const blob = await fetch(objectUrl).then((res) => res.blob());
                    URL.revokeObjectURL(objectUrl);
                    drafts.push({
                        kind: type === "video" ? WORKSPACE_ITEM_KIND.GEN_VIDEO : WORKSPACE_ITEM_KIND.GEN_IMAGE,
                        title: job.prompt?.slice(0, 80) || (type === "video" ? "云端视频" : "云端图片"),
                        prompt: job.prompt || "",
                        model: job.model || "",
                        blob,
                        bytes: blob.size,
                        mime: blob.type || job.file.mime || (type === "video" ? "video/mp4" : "image/png"),
                        width: job.file.width,
                        height: job.file.height,
                        sourceType: WORKSPACE_ITEM_SOURCE.WORKBENCH_CLOUD,
                        sourceRef: job.id,
                        filename: type === "video" ? `${job.id}.mp4` : `${job.id}.png`,
                    });
                } catch {
                    failed += 1;
                }
            }
            if (!drafts.length) {
                message.error(failed ? "无法读取云端文件，分享失败" : "没有可分享的内容");
                return;
            }
            if (failed) message.warning(`${failed} 项读取失败，将分享其余 ${drafts.length} 项`);
            setShareDrafts(drafts);
            setShareOpen(true);
        } finally {
            setBatchBusy(false);
        }
    };

    const handleBatchDelete = () => {
        if (!selectedJobs.length) {
            message.warning("请先勾选要删除的云端记录");
            return;
        }
        const count = selectedJobs.length;
        modal.confirm({
            title: "批量删除云端记录",
            content: `将删除选中的 ${count} 条服务器记录与文件，且不可恢复。本机历史不受影响。`,
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                setBatchBusy(true);
                let ok = 0;
                let failed = 0;
                try {
                    for (const job of selectedJobs) {
                        try {
                            await deleteCloudJob(job.id);
                            ok += 1;
                        } catch {
                            failed += 1;
                        }
                    }
                    if (ok) message.success(`已删除 ${ok} 条云端记录${failed ? `，失败 ${failed} 条` : ""}`);
                    else message.error("批量删除失败");
                    setSelectedIds([]);
                    await load();
                    void refreshUsage();
                } finally {
                    setBatchBusy(false);
                }
            },
        });
    };

    if (!user) {
        return <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 p-4 text-center text-sm text-stone-500 dark:border-stone-700">登录后可查看已同步到服务器的生成结果</div>;
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-stone-500 dark:text-stone-400">共 {total} 条 · 仅当前账号 · 点击缩略图可预览</div>
                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load()}>
                    刷新
                </Button>
            </div>

            {items.length ? (
                <SelectionToolbar active={selectedIds.length > 0} className="gap-2 p-2.5 sm:flex-col sm:items-stretch">
                    <div className="flex flex-wrap items-center gap-2">
                        <SelectCheckbox
                            variant="toolbar"
                            checked={allSelected}
                            indeterminate={!allSelected && someSelected}
                            disabled={!itemIds.length || batchBusy}
                            label={`全选当前列表（${items.length}）`}
                            aria-label="全选当前列表"
                            onChange={(checked) => {
                                if (checked) selectAll();
                                else clearSelection();
                            }}
                        />
                        <SelectionCount
                            count={selectedIds.length}
                            idleHint="勾选后可批量下载/分享/删除"
                            activeHint="已选 · 单卡下载/分享/删除仍可用"
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="small" icon={<Download className="size-3.5" />} disabled={!selectedIds.length || batchBusy} loading={batchBusy} onClick={() => void handleBatchDownload()}>
                            下载选中
                        </Button>
                        <Button size="small" icon={<Share2 className="size-3.5" />} disabled={!selectedIds.length || batchBusy} loading={batchBusy} onClick={() => void openShareJobs(selectedJobs)}>
                            分享选中
                        </Button>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedIds.length || batchBusy} onClick={handleBatchDelete}>
                            删除选中
                        </Button>
                        <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!selectedIds.length || batchBusy} onClick={clearSelection}>
                            清空选择
                        </Button>
                    </div>
                </SelectionToolbar>
            ) : null}

            {loading && !items.length ? (
                <div className="flex min-h-48 items-center justify-center">
                    <Spin />
                </div>
            ) : null}
            {error ? <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">{error}</div> : null}
            <div className="space-y-3">
                {items.map((job) => (
                    <CloudJobCard
                        key={job.id}
                        job={job}
                        type={type}
                        selected={selectedIds.includes(job.id)}
                        onSelectedChange={(checked) => toggleSelected(job.id, checked)}
                        onDelete={() => handleDelete(job)}
                        onDownload={() => void handleDownload(job)}
                        onShare={() => void openShareJobs([job])}
                        onOpenVideoPreview={(url) => setVideoPreview({ url, title: job.prompt || "云端视频" })}
                    />
                ))}
                {!loading && !items.length && !error ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无云端记录，生成成功后会自动同步" className="py-10" /> : null}
            </div>
            <Modal
                open={Boolean(videoPreview)}
                title={videoPreview?.title || "视频预览"}
                footer={null}
                width={920}
                destroyOnHidden
                onCancel={() => setVideoPreview(null)}
                styles={{ body: { paddingTop: 8 } }}
            >
                {videoPreview?.url ? (
                    <video src={videoPreview.url} controls autoPlay playsInline className="max-h-[70vh] w-full rounded-lg bg-black object-contain" />
                ) : null}
            </Modal>
            <ShareToWorkspaceModal
                open={shareOpen}
                drafts={shareDrafts}
                onClose={() => {
                    setShareOpen(false);
                    setShareDrafts([]);
                }}
            />
        </div>
    );
}

function CloudJobCard({
    job,
    type,
    selected,
    onSelectedChange,
    onDelete,
    onDownload,
    onShare,
    onOpenVideoPreview,
}: {
    job: CloudJob;
    type: "image" | "video";
    selected: boolean;
    onSelectedChange: (checked: boolean) => void;
    onDelete: () => void;
    onDownload: () => void;
    onShare: () => void;
    onOpenVideoPreview: (url: string) => void;
}) {
    const [previewUrl, setPreviewUrl] = useState("");
    const [previewError, setPreviewError] = useState(false);

    useEffect(() => {
        let active = true;
        let objectUrl = "";
        setPreviewError(false);
        setPreviewUrl("");
        if (!job.file?.url) return;
        void cloudFileObjectUrl(job.file.url)
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
    }, [job.file?.url]);

    const time = job.created_at ? new Date(job.created_at).toLocaleString() : "";

    return (
        <div className={cn("overflow-hidden rounded-lg border border-stone-200 bg-background transition dark:border-stone-800", selected && "ring-2 ring-stone-900 ring-offset-1 ring-offset-background dark:ring-stone-100")}>
            <div className={`relative bg-stone-100 dark:bg-stone-900 ${type === "video" ? "aspect-video" : "aspect-square"}`}>
                <div className="absolute left-2.5 top-2.5 z-20">
                    <SelectCheckbox
                        variant="overlay"
                        checked={selected}
                        aria-label="选择该记录"
                        onChange={onSelectedChange}
                    />
                </div>
                {previewUrl && !previewError ? (
                    type === "video" ? (
                        <button
                            type="button"
                            className="group relative size-full cursor-zoom-in border-0 bg-transparent p-0"
                            onClick={() => onOpenVideoPreview(previewUrl)}
                            title="点击预览"
                        >
                            <video src={previewUrl} muted playsInline preload="metadata" className="pointer-events-none size-full object-contain" />
                            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/25">
                                <span className="inline-flex items-center gap-1 rounded-full bg-black/65 px-2.5 py-1 text-xs text-white opacity-90">
                                    <Expand className="size-3.5" />
                                    预览
                                </span>
                            </span>
                        </button>
                    ) : (
                        <Image
                            src={previewUrl}
                            alt={job.prompt || "云端图片"}
                            className="!size-full !object-cover"
                            rootClassName="!block size-full"
                            preview={{ mask: "预览" }}
                        />
                    )
                ) : (
                    <div className="flex size-full items-center justify-center text-xs text-stone-500">{previewError ? "预览失败" : "加载中…"}</div>
                )}
            </div>
            <div className="space-y-2 p-2.5">
                <Typography.Paragraph ellipsis={{ rows: 2 }} className="!mb-0 !text-xs !leading-5">
                    {job.prompt || "（无提示词）"}
                </Typography.Paragraph>
                <div className="flex flex-wrap gap-1">
                    {job.model ? <Tag className="m-0 text-[11px]">{job.model}</Tag> : null}
                    <Tag className="m-0 text-[11px]" color="blue">
                        云端
                    </Tag>
                </div>
                <div className="text-[11px] text-stone-400">{time}</div>
                <div className="flex flex-wrap gap-2">
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={onDownload}>
                        下载
                    </Button>
                    <Button size="small" icon={<Share2 className="size-3.5" />} onClick={onShare}>
                        分享
                    </Button>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                        删除
                    </Button>
                </div>
            </div>
        </div>
    );
}
