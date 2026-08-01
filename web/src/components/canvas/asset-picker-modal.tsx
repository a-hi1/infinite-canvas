import { useEffect, useMemo, useState } from "react";
import { App, Empty, Input, Modal, Pagination, Select, Spin, Tabs, Tag } from "antd";
import { Search, Users } from "lucide-react";

import {
    ALL_CATEGORIES_VALUE,
    assetCategoryLabel,
    buildAssetCategoryFilterOptions,
    matchesAssetCategoryFilter,
} from "@/lib/asset-category";
import { cn } from "@/lib/utils";
import { getLastWorkspaceId, setLastWorkspaceId } from "@/lib/workspace-preference";
import {
    isWorkspaceItemInsertable,
    matchesWorkspaceInsertFilter,
    workspaceItemMediaKind,
    workspaceItemToInsertPayload,
    type WorkspaceInsertKindFilter,
} from "@/lib/workspace-to-insert";
import { useAuthStore } from "@/stores/use-auth-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import {
    listWorkspaceItems,
    listWorkspaces,
    workspaceFileObjectUrl,
    type WorkspaceItem,
    type WorkspaceSummary,
} from "@/services/workspace-api";
import { AuthModal } from "@/components/layout/auth-modal";

export type InsertAssetPayload =
    | { kind: "text"; content: string; title: string }
    | { kind: "image"; dataUrl: string; title: string; storageKey?: string }
    | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number };

type Props = {
    open: boolean;
    /** "my-assets" | "workspace" */
    defaultTab?: string;
    onInsert: (payload: InsertAssetPayload) => void | Promise<void>;
    onClose: () => void;
};

export function AssetPickerModal({ open, defaultTab = "my-assets", onInsert, onClose }: Props) {
    const [tab, setTab] = useState(defaultTab === "workspace" ? "workspace" : "my-assets");

    useEffect(() => {
        if (!open) return;
        setTab(defaultTab === "workspace" ? "workspace" : "my-assets");
    }, [open, defaultTab]);

    return (
        <Modal
            title="选择资产"
            open={open}
            onCancel={onClose}
            footer={null}
            width={900}
            destroyOnHidden
            styles={{ body: { padding: "0 24px 24px", minHeight: 520 } }}
        >
            <Tabs
                activeKey={tab}
                onChange={setTab}
                destroyOnHidden
                items={[
                    {
                        key: "my-assets",
                        label: "我的资产",
                        children: <MyAssetsTab onInsert={onInsert} />,
                    },
                    {
                        key: "workspace",
                        label: "工作空间",
                        children: <WorkspaceAssetsTab onInsert={onInsert} />,
                    },
                ]}
            />
        </Modal>
    );
}

const PAGE_SIZE = 8;

const kindOptions: Array<{ label: string; value: WorkspaceInsertKindFilter }> = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
];

function PickerCard({
    title,
    kind,
    category,
    cover,
    badge,
    loading,
    onClick,
}: {
    title: string;
    kind: string;
    category?: string;
    cover: string;
    badge?: string;
    loading?: boolean;
    onClick: () => void;
}) {
    const kindLabel = kind === "image" ? "图片" : kind === "video" ? "视频" : "文本";
    return (
        <button
            type="button"
            disabled={loading}
            className="group relative cursor-pointer overflow-hidden rounded-lg border border-stone-200 bg-white text-left transition hover:border-stone-400 hover:shadow-md disabled:cursor-wait disabled:opacity-70 dark:border-stone-700 dark:bg-stone-900 dark:hover:border-stone-500"
            onClick={onClick}
        >
            {cover ? (
                kind === "video" ? (
                    <video src={cover} muted playsInline preload="metadata" className="aspect-[4/3] w-full object-cover" />
                ) : (
                    <img src={cover} alt={title} className="aspect-[4/3] w-full object-cover" />
                )
            ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">
                    {title}
                </div>
            )}
            <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-medium text-stone-800 dark:text-stone-200">{title}</span>
                    <Tag className="m-0 shrink-0 text-[10px]">{badge || kindLabel}</Tag>
                </div>
                <div className="mt-1 line-clamp-1 text-[10px] text-stone-500 dark:text-stone-400">{assetCategoryLabel(category)}</div>
            </div>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-stone-950/0 text-sm font-medium text-white opacity-0 transition group-hover:bg-stone-950/55 group-hover:opacity-100">
                {loading ? "导入中…" : "使用"}
            </div>
        </button>
    );
}

function MyAssetsTab({ onInsert }: { onInsert: (payload: InsertAssetPayload) => void | Promise<void> }) {
    const assets = useAssetStore((state) => state.assets);
    const hydrated = useAssetStore((state) => state.hydrated);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<WorkspaceInsertKindFilter>("all");
    const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES_VALUE);
    const [page, setPage] = useState(1);

    const categoryOptions = useMemo(() => buildAssetCategoryFilterOptions(assets), [assets]);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video")
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => matchesAssetCategoryFilter(a.category, categoryFilter))
            .filter((a) => !query || [a.title, a.category || "", ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter, categoryFilter]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    useEffect(() => {
        if (!categoryOptions.some((option) => option.value === categoryFilter)) {
            setCategoryFilter(ALL_CATEGORIES_VALUE);
        }
    }, [categoryOptions, categoryFilter]);

    const handleInsert = (asset: Asset) => {
        if (asset.kind === "text") {
            void onInsert({ kind: "text", content: asset.data.content, title: asset.title });
        } else {
            void onInsert(
                asset.kind === "video"
                    ? {
                          kind: "video",
                          url: asset.data.url,
                          storageKey: asset.data.storageKey,
                          title: asset.title,
                          width: asset.data.width,
                          height: asset.data.height,
                      }
                    : { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title },
            );
        }
    };

    return (
        <div className="space-y-4 pt-2">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    disabled={!hydrated}
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder={hydrated ? "搜索资产" : "正在加载资产..."}
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex flex-wrap gap-1.5">
                    {kindOptions.map((opt) => (
                        <Tag.CheckableTag
                            key={opt.value}
                            checked={kindFilter === opt.value}
                            className={cn("prompt-filter-tag", kindFilter === opt.value && "is-active")}
                            onChange={() => {
                                if (!hydrated) return;
                                setPage(1);
                                setKindFilter(opt.value);
                            }}
                        >
                            {opt.label}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
                {categoryOptions.map((opt) => (
                    <Tag.CheckableTag
                        key={opt.value}
                        checked={categoryFilter === opt.value}
                        className={cn("prompt-filter-tag", categoryFilter === opt.value && "is-active")}
                        onChange={() => {
                            if (!hydrated) return;
                            setPage(1);
                            setCategoryFilter(opt.value);
                        }}
                    >
                        {opt.label}
                    </Tag.CheckableTag>
                ))}
            </div>

            {!hydrated ? (
                <div className="flex min-h-75 flex-col items-center justify-center gap-3 text-sm text-stone-500">
                    <Spin />
                    <span>正在加载资产...</span>
                </div>
            ) : visible.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {visible.map((asset) => (
                        <PickerCard
                            key={asset.id}
                            title={asset.title}
                            kind={asset.kind}
                            category={asset.category}
                            cover={asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : asset.kind === "video" ? asset.data.url : "")}
                            onClick={() => handleInsert(asset)}
                        />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有资产" className="py-12" />
            )}

            {hydrated && filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}

function WorkspaceAssetsTab({ onInsert }: { onInsert: (payload: InsertAssetPayload) => void | Promise<void> }) {
    const { message } = App.useApp();
    const user = useAuthStore((s) => s.user);
    const userId = user?.id || "";
    const [authOpen, setAuthOpen] = useState(false);
    const [loadingList, setLoadingList] = useState(false);
    const [loadingItems, setLoadingItems] = useState(false);
    const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
    const [workspaceId, setWorkspaceId] = useState("");
    const [items, setItems] = useState<WorkspaceItem[]>([]);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<WorkspaceInsertKindFilter>("all");
    const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES_VALUE);
    const [page, setPage] = useState(1);
    const [insertingId, setInsertingId] = useState("");
    const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});

    useEffect(() => {
        if (!userId) {
            setWorkspaces([]);
            setWorkspaceId("");
            setItems([]);
            return;
        }
        let active = true;
        setLoadingList(true);
        void listWorkspaces()
            .then((data) => {
                if (!active) return;
                const list = data.items || [];
                setWorkspaces(list);
                const last = getLastWorkspaceId();
                const preferred = (last && list.find((w) => w.id === last)?.id) || list[0]?.id || "";
                setWorkspaceId(preferred);
            })
            .catch((error) => {
                if (!active) return;
                message.error(error instanceof Error ? error.message : "加载工作空间失败");
            })
            .finally(() => {
                if (active) setLoadingList(false);
            });
        return () => {
            active = false;
        };
    }, [message, userId]);

    useEffect(() => {
        if (!userId || !workspaceId) {
            setItems([]);
            return;
        }
        let active = true;
        setLoadingItems(true);
        setItems([]);
        setPage(1);
        setThumbUrls({});
        void listWorkspaceItems(workspaceId, { pageSize: 100 })
            .then((data) => {
                if (!active) return;
                setItems((data.items || []).filter((item) => isWorkspaceItemInsertable(item)));
                setLastWorkspaceId(workspaceId);
            })
            .catch((error) => {
                if (!active) return;
                message.error(error instanceof Error ? error.message : "加载工作空间素材失败");
                setItems([]);
            })
            .finally(() => {
                if (active) setLoadingItems(false);
            });
        return () => {
            active = false;
        };
    }, [message, userId, workspaceId]);

    const categoryOptions = useMemo(() => buildAssetCategoryFilterOptions(items), [items]);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return items
            .filter((item) => matchesWorkspaceInsertFilter(item, kindFilter))
            .filter((item) => matchesAssetCategoryFilter(item.category, categoryFilter))
            .filter((item) => {
                if (!query) return true;
                return [item.title, item.category || "", item.prompt || "", ...(item.tags || [])].join(" ").toLowerCase().includes(query);
            });
    }, [items, keyword, kindFilter, categoryFilter]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    useEffect(() => {
        if (!categoryOptions.some((option) => option.value === categoryFilter)) {
            setCategoryFilter(ALL_CATEGORIES_VALUE);
        }
    }, [categoryOptions, categoryFilter]);

    // Lazy thumbs for visible media only; uses session file-url cache.
    useEffect(() => {
        let active = true;
        const targets = visible.filter((item) => {
            const media = workspaceItemMediaKind(item);
            return (media === "image" || media === "video") && item.file_url && !thumbUrls[item.id];
        });
        if (!targets.length) return;
        void Promise.all(
            targets.map(async (item) => {
                try {
                    const url = await workspaceFileObjectUrl(item.file_url!);
                    if (!active) return;
                    setThumbUrls((prev) => (prev[item.id] ? prev : { ...prev, [item.id]: url }));
                } catch {
                    // ignore thumb failures
                }
            }),
        );
        return () => {
            active = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fetch missing thumbs for visible page
    }, [visible.map((item) => item.id).join("|")]);

    const handleInsert = async (item: WorkspaceItem) => {
        if (insertingId) return;
        setInsertingId(item.id);
        try {
            const payload = await workspaceItemToInsertPayload(item);
            await onInsert(payload);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导入工作空间素材失败");
        } finally {
            setInsertingId("");
        }
    };

    if (!userId) {
        return (
            <div className="flex min-h-75 flex-col items-center justify-center gap-3 py-10 text-center">
                <Users className="size-10 text-stone-400" />
                <div className="text-sm text-stone-600 dark:text-stone-300">登录后可直接使用工作空间里的图片、视频与文本</div>
                <button
                    type="button"
                    className="rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white dark:bg-stone-100 dark:text-stone-900"
                    onClick={() => setAuthOpen(true)}
                >
                    登录
                </button>
                <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
            </div>
        );
    }

    return (
        <div className="space-y-4 pt-2">
            <div className="flex flex-wrap items-center gap-3">
                <Select
                    className="min-w-52"
                    size="small"
                    placeholder={loadingList ? "加载空间…" : "选择工作空间"}
                    loading={loadingList}
                    value={workspaceId || undefined}
                    options={workspaces.map((ws) => ({
                        value: ws.id,
                        label: `${ws.name}${ws.role === "owner" ? " · 所有者" : ""}`,
                    }))}
                    onChange={(value) => setWorkspaceId(value)}
                    notFoundContent={loadingList ? <Spin size="small" /> : "暂无工作空间"}
                />
                <Input
                    className="w-48"
                    size="small"
                    disabled={!workspaceId || loadingItems}
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder="搜索标题/分类"
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex flex-wrap gap-1.5">
                    {kindOptions.map((opt) => (
                        <Tag.CheckableTag
                            key={opt.value}
                            checked={kindFilter === opt.value}
                            className={cn("prompt-filter-tag", kindFilter === opt.value && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(opt.value);
                            }}
                        >
                            {opt.label}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
                {categoryOptions.map((opt) => (
                    <Tag.CheckableTag
                        key={opt.value}
                        checked={categoryFilter === opt.value}
                        className={cn("prompt-filter-tag", categoryFilter === opt.value && "is-active")}
                        onChange={() => {
                            setPage(1);
                            setCategoryFilter(opt.value);
                        }}
                    >
                        {opt.label}
                    </Tag.CheckableTag>
                ))}
            </div>

            <div className="text-xs text-stone-500 dark:text-stone-400">
                从工作空间导入会复制到本机后使用，不改动空间原文件；与「分享到工作空间」方向相反。
            </div>

            {loadingList || loadingItems ? (
                <div className="flex min-h-75 flex-col items-center justify-center gap-3 text-sm text-stone-500">
                    <Spin />
                    <span>{loadingList ? "正在加载工作空间…" : "正在加载素材…"}</span>
                </div>
            ) : !workspaceId ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有工作空间，请先到「工作空间」创建或加入" className="py-12" />
            ) : visible.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {visible.map((item) => {
                        const media = workspaceItemMediaKind(item);
                        const cover =
                            media === "text"
                                ? ""
                                : thumbUrls[item.id] || "";
                        const badge =
                            item.kind === "asset_document"
                                ? "文档"
                                : item.kind.startsWith("gen_")
                                  ? media === "image"
                                      ? "生成图"
                                      : "生成视频"
                                  : undefined;
                        return (
                            <PickerCard
                                key={item.id}
                                title={item.title || item.id.slice(0, 8)}
                                kind={media === "unknown" ? "text" : media}
                                category={item.category}
                                cover={cover}
                                badge={badge}
                                loading={insertingId === item.id}
                                onClick={() => void handleInsert(item)}
                            />
                        );
                    })}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该空间暂无可导入的图片/视频/文本" className="py-12" />
            )}

            {!loadingItems && filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}
