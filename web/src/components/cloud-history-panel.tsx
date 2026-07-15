import { useCallback, useEffect, useState } from "react";
import { App, Button, Empty, Spin, Tag, Typography } from "antd";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import { saveAs } from "file-saver";

import { cloudFileObjectUrl, deleteCloudJob, listCloudJobs, type CloudJob } from "@/services/cloud-api";
import { useAuthStore } from "@/stores/use-auth-store";

type Props = {
    type: "image" | "video";
    /** 外部触发刷新（例如刚上云成功） */
    refreshKey?: number;
};

export function CloudHistoryPanel({ type, refreshKey = 0 }: Props) {
    const { message, modal } = App.useApp();
    const user = useAuthStore((s) => s.user);
    const logout = useAuthStore((s) => s.logout);
    const [loading, setLoading] = useState(false);
    const [items, setItems] = useState<CloudJob[]>([]);
    const [total, setTotal] = useState(0);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        if (!user) {
            setItems([]);
            setTotal(0);
            setError("");
            return;
        }
        setLoading(true);
        setError("");
        try {
            const data = await listCloudJobs({ type, page: 1, pageSize: 50 });
            setItems(data.items || []);
            setTotal(data.total || 0);
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
                await load();
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
        }
    };

    if (!user) {
        return <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 p-4 text-center text-sm text-stone-500 dark:border-stone-700">登录后可查看已同步到服务器的生成结果</div>;
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-stone-500 dark:text-stone-400">共 {total} 条 · 仅当前账号</div>
                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load()}>
                    刷新
                </Button>
            </div>
            {loading && !items.length ? (
                <div className="flex min-h-48 items-center justify-center">
                    <Spin />
                </div>
            ) : null}
            {error ? <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">{error}</div> : null}
            <div className="space-y-3">
                {items.map((job) => (
                    <CloudJobCard key={job.id} job={job} type={type} onDelete={() => handleDelete(job)} onDownload={() => void handleDownload(job)} />
                ))}
                {!loading && !items.length && !error ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无云端记录，生成成功后会自动同步" className="py-10" /> : null}
            </div>
        </div>
    );
}

function CloudJobCard({ job, type, onDelete, onDownload }: { job: CloudJob; type: "image" | "video"; onDelete: () => void; onDownload: () => void }) {
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
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <div className={`bg-stone-100 dark:bg-stone-900 ${type === "video" ? "aspect-video" : "aspect-square"}`}>
                {previewUrl && !previewError ? (
                    type === "video" ? (
                        <video src={previewUrl} controls playsInline preload="metadata" className="size-full object-contain" />
                    ) : (
                        <img src={previewUrl} alt="" className="size-full object-cover" />
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
                <div className="flex gap-2">
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={onDownload}>
                        下载
                    </Button>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                        删除
                    </Button>
                </div>
            </div>
        </div>
    );
}
