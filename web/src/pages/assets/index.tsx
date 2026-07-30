import { CloudDownload, Copy, Download, ImagePlus, PencilLine, Search, Trash2, Upload, VideoIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Card, Drawer, Empty, Form, Image, Input, Modal, Pagination, Select, Space, Spin, Tag, Typography } from "antd";
import { saveAs } from "file-saver";

import { useCopyText } from "@/hooks/use-copy-text";
import { cloudSyncColor } from "@/lib/cloud-sync";
import { formatBytes, readFileAsDataUrl } from "@/lib/image-utils";
import { uploadMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import {
    ALL_CATEGORIES_VALUE,
    assetCategoryLabel,
    buildAssetCategoryFilterOptions,
    collectAssetCategories,
    isUncategorizedAsset,
    matchesAssetCategoryFilter,
    resolveAssetCategoryForSave,
    standardAssetCategoryOptions,
    suggestAssetCategory,
} from "@/lib/asset-category";
import { cn } from "@/lib/utils";
import {
    getAssetCloudBadge,
    getAssetCloudStatusVersion,
    getAssetLibraryCloudSummary,
    hydrateAssetCloudStatus,
    subscribeAssetCloudStatus,
    syncAssetManifestNow,
    type AssetCloudBadge,
} from "@/services/asset-cloud-sync";
import { useAuthStore } from "@/stores/use-auth-store";
import { useAssetStore, type Asset, type AssetKind, type ImageAsset, type VideoAsset } from "@/stores/use-asset-store";
import { exportAssets, readAssetPackage } from "./asset-transfer";

type AssetFormValues = {
    kind: AssetKind;
    title: string;
    coverUrl: string;
    category?: string | string[];
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
};

type ImageDraft = ImageAsset["data"] | null;
type VideoDraft = VideoAsset["data"] | null;

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
];

export default function AssetsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const copyText = useCopyText();
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const assets = useAssetStore((state) => state.assets);
    const hydrated = useAssetStore((state) => state.hydrated);
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const cloudUser = useAuthStore((state) => state.user);
    const cloudPullDoneRef = useRef(false);
    const [cloudSyncing, setCloudSyncing] = useState(false);
    // Force re-render when sync snapshot changes outside React state (after successful/failed sync).
    const cloudStatusVersion = useSyncExternalStore(subscribeAssetCloudStatus, getAssetCloudStatusVersion, () => 0);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES_VALUE);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [imageDraft, setImageDraft] = useState<ImageDraft>(null);
    const [videoDraft, setVideoDraft] = useState<VideoDraft>(null);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const tags = Form.useWatch("tags", form) || [];
    const content = Form.useWatch("content", form) || "";
    const validAssets = useMemo(() => assets.filter((asset) => asset.kind === "text" || asset.kind === "image" || asset.kind === "video"), [assets]);

    // 固定展示 人物/场景/道具…，并合并资产里出现的自定义分类
    const categoryOptions = useMemo(() => buildAssetCategoryFilterOptions(validAssets), [validAssets]);

    const filteredAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return validAssets.filter((asset) => {
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (!matchesAssetCategoryFilter(asset.category, categoryFilter)) return false;
            if (!query) return true;
            return assetSearchText(asset).includes(query);
        });
    }, [validAssets, keyword, kindFilter, categoryFilter]);

    const visibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filteredAssets.slice(start, start + pageSize);
    }, [filteredAssets, page, pageSize]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filteredAssets.length / pageSize));
        setPage((value) => Math.min(value, maxPage));
    }, [filteredAssets.length, pageSize]);

    useEffect(() => {
        void hydrateAssetCloudStatus();
    }, []);

    // One safe login pull. It merges by updatedAt + tombstones and never deletes local-only newer data.
    useEffect(() => {
        if (!hydrated || !cloudUser || cloudPullDoneRef.current) return;
        cloudPullDoneRef.current = true;
        setCloudSyncing(true);
        void syncAssetManifestNow({ pull: true })
            .then((result) => {
                if (!result.ok) return;
                const changes = result.merged + result.deleted + result.mediaDownloaded;
                if (changes > 0) message.success(`资产云同步完成（更新 ${changes} 项）`);
            })
            .finally(() => setCloudSyncing(false));
    }, [cloudUser, hydrated, message]);

    const cloudSummary = useMemo(
        () => getAssetLibraryCloudSummary(validAssets, { loggedIn: Boolean(cloudUser), syncing: cloudSyncing }),
        // cloudStatusVersion intentionally forces refresh after sync snapshot writes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [validAssets, cloudUser, cloudSyncing, cloudStatusVersion],
    );

    const syncCloudAssets = async () => {
        if (!cloudUser) {
            message.info("登录后可同步资产清单与本地媒体，云失败不影响本机资产");
            return;
        }
        setCloudSyncing(true);
        try {
            const result = await syncAssetManifestNow({ pull: true });
            if (!result.ok) {
                message.warning("云端资产暂不可用，本机资产已保留");
                return;
            }
            const changed = result.merged + result.deleted + result.mediaDownloaded + result.mediaUploaded;
            message.success(changed > 0 ? `资产同步完成（处理 ${changed} 项）` : "资产已与云端对齐（无更新）");
        } finally {
            setCloudSyncing(false);
        }
    };

    const openCreate = () => {
        setEditingAsset(null);
        setImageDraft(null);
        setVideoDraft(null);
        setFormKind("text");
        form.setFieldsValue({ kind: "text", title: "", coverUrl: "", category: [], tags: [], source: "手动添加", note: "", content: "" });
        setIsAssetOpen(true);
    };

    const openEdit = (asset: Asset) => {
        setEditingAsset(asset);
        setFormKind(asset.kind);
        setImageDraft(asset.kind === "image" ? asset.data : null);
        setVideoDraft(asset.kind === "video" ? asset.data : null);
        form.setFieldsValue({
            kind: asset.kind,
            title: asset.title,
            coverUrl: asset.coverUrl,
            category: asset.category ? [asset.category] : [],
            tags: asset.tags || [],
            source: asset.source,
            note: asset.note,
            content: asset.kind === "text" ? asset.data.content : "",
        });
        setIsAssetOpen(true);
    };

    const saveAsset = async () => {
        const values = await form.validateFields();
        const title = values.title.trim();
        const tags = values.tags || [];
        const source = values.source?.trim();
        const note = values.note?.trim();
        const content = (values.content || "").trim();
        const category =
            resolveAssetCategoryForSave(values.category) ||
            suggestAssetCategory({ title, tags, source, note, content, kind: values.kind });
        const base = {
            title,
            coverUrl: values.coverUrl?.trim() || (values.kind === "image" && imageDraft ? imageDraft.dataUrl : ""),
            category,
            tags,
            source,
            note,
            metadata: editingAsset?.metadata || { source: "manual" },
        };

        if (values.kind === "text") {
            const asset = { ...base, kind: "text" as const, data: { content } };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else if (values.kind === "video") {
            if (!videoDraft) {
                message.error("请选择视频文件");
                return;
            }
            const asset = { ...base, kind: "video" as const, data: videoDraft };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else {
            if (!imageDraft) {
                message.error("请选择图片文件");
                return;
            }
            const asset = { ...base, kind: "image" as const, data: imageDraft };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        }

        message.success(editingAsset ? "资产已更新" : "资产已保存");
        setIsAssetOpen(false);
    };

    const readCoverFile = async (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            message.warning("封面请选择图片文件");
            return;
        }
        const dataUrl = await readFileAsDataUrl(file);
        form.setFieldValue("coverUrl", dataUrl);
    };

    const readImageFile = async (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith("image/") && !isLikelyImageFile(file)) {
            message.warning("请选择图片文件");
            return;
        }
        const image = await uploadImage(file);
        const draft = { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType || file.type || "image/png" };
        setImageDraft(draft);
        setVideoDraft(null);
        setFormKind("image");
        form.setFieldValue("kind", "image");
        if (!form.getFieldValue("coverUrl")) form.setFieldValue("coverUrl", draft.dataUrl);
        if (!form.getFieldValue("title")) form.setFieldValue("title", fileNameWithoutExtension(file.name));
    };

    const readVideoFile = async (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith("video/") && !isLikelyVideoFile(file)) {
            message.warning("请选择视频文件");
            return;
        }
        const video = await uploadMediaFile(file, "video-asset");
        const draft = {
            url: video.url,
            storageKey: video.storageKey,
            width: video.width || 1280,
            height: video.height || 720,
            bytes: video.bytes,
            mimeType: video.mimeType || file.type || "video/mp4",
        };
        setVideoDraft(draft);
        setImageDraft(null);
        setFormKind("video");
        form.setFieldValue("kind", "video");
        if (!form.getFieldValue("title")) form.setFieldValue("title", fileNameWithoutExtension(file.name));
        if (!form.getFieldValue("coverUrl")) form.setFieldValue("coverUrl", "");
    };

    const copyAssetText = async (asset: Asset) => {
        if (asset.kind !== "text") return;
        copyText(asset.data.content, "文本已复制");
    };

    const downloadImage = (asset: Asset) => {
        if (asset.kind !== "image" && asset.kind !== "video") return;
        saveAs(asset.kind === "video" ? asset.data.url : asset.data.dataUrl, `${asset.title || "asset"}.${asset.data.mimeType.split("/")[1] || "png"}`);
    };

    const exportAllAssets = async () => {
        if (!validAssets.length) {
            message.warning("暂无资产可导出");
            return;
        }
        await exportAssets(validAssets);
    };

    const importAssetFiles = async (files?: FileList | null) => {
        const selectedFiles = Array.from(files || []);
        if (!selectedFiles.length) return;
        let importedCount = 0;
        let packageCount = 0;
        let failedCount = 0;

        for (const file of selectedFiles) {
            try {
                if (isAssetPackageFile(file)) {
                    const importedAssets = await readAssetPackage(file);
                    importedAssets.forEach((asset) => {
                        const payload = { ...asset } as Record<string, unknown>;
                        delete payload.id;
                        delete payload.createdAt;
                        delete payload.updatedAt;
                        addAsset(payload as Parameters<typeof addAsset>[0]);
                    });
                    packageCount += importedAssets.length;
                    importedCount += 1;
                    continue;
                }

                if (file.type.startsWith("image/") || isLikelyImageFile(file)) {
                    const image = await uploadImage(file);
                    const title = fileNameWithoutExtension(file.name) || "本地图片";
                    addAsset({
                        kind: "image",
                        title,
                        coverUrl: image.url,
                        category: suggestAssetCategory({ title, source: "本地导入", fileName: file.name, kind: "image" }),
                        tags: [],
                        source: "本地导入",
                        data: {
                            dataUrl: image.url,
                            storageKey: image.storageKey,
                            width: image.width,
                            height: image.height,
                            bytes: image.bytes,
                            mimeType: image.mimeType || file.type || "image/png",
                        },
                        metadata: { source: "local-import", fileName: file.name },
                    });
                    importedCount += 1;
                    continue;
                }

                if (file.type.startsWith("video/") || isLikelyVideoFile(file)) {
                    const video = await uploadMediaFile(file, "video-asset");
                    const title = fileNameWithoutExtension(file.name) || "本地视频";
                    addAsset({
                        kind: "video",
                        title,
                        coverUrl: "",
                        category: suggestAssetCategory({ title, source: "本地导入", fileName: file.name, kind: "video" }),
                        tags: [],
                        source: "本地导入",
                        data: {
                            url: video.url,
                            storageKey: video.storageKey,
                            width: video.width || 1280,
                            height: video.height || 720,
                            bytes: video.bytes,
                            mimeType: video.mimeType || file.type || "video/mp4",
                        },
                        metadata: { source: "local-import", fileName: file.name },
                    });
                    importedCount += 1;
                    continue;
                }

                failedCount += 1;
            } catch {
                failedCount += 1;
            }
        }

        if (importedCount) {
            const packageHint = packageCount ? `（含压缩包内 ${packageCount} 项）` : "";
            message.success(`已导入 ${importedCount} 个文件${packageHint}`);
        }
        if (failedCount) message.warning(`有 ${failedCount} 个文件未能识别，请选择图片、视频或资产压缩包`);
        if (assetInputRef.current) assetInputRef.current.value = "";
    };

    const confirmDelete = () => {
        if (!deletingAsset) return;
        removeAsset(deletingAsset.id);
        message.success("资产已删除");
        setDeletingAsset(null);
    };

    const changeAssetCategory = (asset: Asset, next?: string | null) => {
        updateAsset(asset.id, { category: resolveAssetCategoryForSave(next) });
        message.success(next ? `已设为「${assetCategoryLabel(next)}」` : "已清除分类");
    };

    const autoClassifyUncategorized = () => {
        const targets = validAssets.filter((asset) => isUncategorizedAsset(asset.category));
        if (!targets.length) {
            message.info("当前没有未分类资产");
            return;
        }
        let classified = 0;
        let skipped = 0;
        for (const asset of targets) {
            const content = asset.kind === "text" ? asset.data.content : "";
            const prompt = typeof asset.metadata?.prompt === "string" ? asset.metadata.prompt : "";
            const fileName = typeof asset.metadata?.fileName === "string" ? asset.metadata.fileName : "";
            const suggested = suggestAssetCategory({
                title: asset.title,
                tags: asset.tags,
                source: asset.source,
                note: asset.note,
                content,
                prompt,
                fileName,
                kind: asset.kind,
            });
            if (!suggested) {
                skipped += 1;
                continue;
            }
            updateAsset(asset.id, { category: suggested });
            classified += 1;
        }
        if (classified) {
            message.success(`已智能归类 ${classified} 项${skipped ? `，另有 ${skipped} 项证据不足仍保持未分类` : ""}`);
            return;
        }
        message.info("暂无法从标题/标签/提示词判断分类，可在卡片上直接选择");
    };

    const uncategorizedCount = useMemo(() => validAssets.filter((asset) => isUncategorizedAsset(asset.category)).length, [validAssets]);

    const useAssetInWorkbench = (asset: Asset, target: "image" | "video") => {
        if (asset.kind === "text") {
            const params = new URLSearchParams({ prompt: asset.data.content || "" });
            navigate(`/${target}?${params.toString()}`);
            return;
        }
        if (asset.kind === "image" && target === "image") {
            message.info("图片资产可在生图工作台通过“查看我的资产”插入为参考图");
            navigate("/image");
            return;
        }
        if (asset.kind === "image" && target === "video") {
            message.info("图片资产可在视频工作台通过“查看我的资产”插入为参考图");
            navigate("/video");
            return;
        }
        if (asset.kind === "video") {
            message.info("视频资产可在视频工作台通过“查看我的资产”插入");
            navigate("/video");
        }
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">我的资产</h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">长期保存文本、图片、视频资产，可按分类管理；默认本机，登录后可同步清单与 storageKey 媒体到云端。</p>
                        <div className="mt-4 flex justify-center">
                            <Tag
                                className="m-0 inline-flex h-7 items-center rounded-full px-3 text-xs"
                                color={
                                    cloudSummary.tone === "synced"
                                        ? "success"
                                        : cloudSummary.tone === "failed"
                                          ? "error"
                                          : cloudSummary.tone === "pending"
                                            ? "processing"
                                            : "default"
                                }
                            >
                                {cloudSummary.label}
                                {cloudSummary.detail ? ` · ${cloudSummary.detail}` : ""}
                            </Tag>
                        </div>
                    </div>

                    <div className="mx-auto mt-8 w-full max-w-2xl">
                        <Input.Search
                            className="w-full"
                            size="large"
                            allowClear
                            disabled={!hydrated}
                            prefix={<Search className="size-4 text-stone-400" />}
                            value={keyword}
                            placeholder={hydrated ? "搜索标题、内容、标签、分类或来源" : "正在加载我的资产..."}
                            onChange={(event) => {
                                setPage(1);
                                setKeyword(event.target.value);
                            }}
                            onSearch={(value) => {
                                setPage(1);
                                setKeyword(value);
                            }}
                        />
                    </div>

                    <div className="mx-auto mt-6 grid max-w-6xl gap-3 text-left">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex min-w-0 flex-1 flex-col gap-2">
                                <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                                    <div className="text-xs font-medium text-stone-500 dark:text-stone-400">类型</div>
                                    <div className="flex flex-wrap gap-2">
                                        {kindOptions.map((option) => (
                                            <Tag.CheckableTag
                                                key={option.value}
                                                checked={kindFilter === option.value}
                                                className={cn("prompt-filter-tag", kindFilter === option.value && "is-active")}
                                                onChange={() => {
                                                    if (!hydrated) return;
                                                    setPage(1);
                                                    setKindFilter(option.value as AssetKind | "all");
                                                }}
                                            >
                                                {option.label}
                                            </Tag.CheckableTag>
                                        ))}
                                    </div>
                                </div>
                                <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                                    <div className="text-xs font-medium text-stone-500 dark:text-stone-400">分类</div>
                                    <div className="flex flex-wrap gap-2">
                                        {categoryOptions.map((option) => (
                                            <Tag.CheckableTag
                                                key={option.value}
                                                checked={categoryFilter === option.value}
                                                className={cn("prompt-filter-tag", categoryFilter === option.value && "is-active")}
                                                onChange={() => {
                                                    if (!hydrated) return;
                                                    setPage(1);
                                                    setCategoryFilter(option.value);
                                                }}
                                            >
                                                {option.label}
                                            </Tag.CheckableTag>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-4">
                                <button
                                    type="button"
                                    disabled={!hydrated || cloudSyncing}
                                    className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-stone-300"
                                    onClick={() => void syncCloudAssets()}
                                >
                                    <CloudDownload className={`size-4 ${cloudSyncing ? "animate-pulse" : ""}`} />
                                    {cloudSyncing ? "同步中..." : "同步云端"}
                                </button>
                                <button
                                    type="button"
                                    disabled={!hydrated}
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-stone-300"
                                    onClick={() => void exportAllAssets()}
                                >
                                    导出资产
                                </button>
                                <button
                                    type="button"
                                    disabled={!hydrated || !uncategorizedCount}
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-stone-300"
                                    onClick={autoClassifyUncategorized}
                                >
                                    智能归类未分类{uncategorizedCount ? `（${uncategorizedCount}）` : ""}
                                </button>
                                <button
                                    type="button"
                                    disabled={!hydrated}
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-stone-300"
                                    onClick={() => assetInputRef.current?.click()}
                                >
                                    导入本地文件
                                </button>
                                <button
                                    type="button"
                                    disabled={!hydrated}
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-stone-300"
                                    onClick={openCreate}
                                >
                                    新增资产
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mx-auto flex max-w-7xl flex-col gap-5">
                    {!hydrated ? (
                        <section className="flex min-h-[360px] flex-col items-center justify-center gap-3 border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">
                            <Spin />
                            <span>正在加载我的资产...</span>
                        </section>
                    ) : (
                        <>
                            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                {visibleAssets.map((asset) => (
                                    <AssetCard
                                        key={asset.id}
                                        asset={asset}
                                        cloudBadge={getAssetCloudBadge(asset, { loggedIn: Boolean(cloudUser), syncing: cloudSyncing })}
                                        categoryOptions={collectAssetCategories(validAssets).map((name) => ({ label: name, value: name }))}
                                        onOpen={() => setPreviewAsset(asset)}
                                        onEdit={() => openEdit(asset)}
                                        onCategoryChange={(next) => changeAssetCategory(asset, next)}
                                        onCopy={copyAssetText}
                                        onDownload={downloadImage}
                                        onUseImage={() => useAssetInWorkbench(asset, "image")}
                                        onUseVideo={() => useAssetInWorkbench(asset, "video")}
                                        onDelete={() => setDeletingAsset(asset)}
                                    />
                                ))}
                            </div>

                            {!visibleAssets.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={validAssets.length ? "没有找到资产" : "还没有资产"} className="py-20" /> : null}

                            <div className="flex justify-center">
                                <Pagination
                                    current={page}
                                    pageSize={pageSize}
                                    total={filteredAssets.length}
                                    showSizeChanger
                                    pageSizeOptions={[10, 20, 50, 100]}
                                    onChange={(nextPage, nextPageSize) => {
                                        setPage(nextPage);
                                        setPageSize(nextPageSize);
                                    }}
                                />
                            </div>
                        </>
                    )}
                </div>
            </main>

            <Modal title={editingAsset ? "编辑资产" : "新增资产"} open={isAssetOpen} width={980} onCancel={() => setIsAssetOpen(false)} onOk={() => void saveAsset()} okText="保存" cancelText="取消" destroyOnHidden>
                <div className="grid gap-6 pt-1 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <Form form={form} layout="vertical" requiredMark={false} initialValues={{ kind: "text", tags: [], category: [] }}>
                        <Form.Item name="kind" label="类型">
                            <Select
                                options={[
                                    { label: "文本", value: "text" },
                                    { label: "图片", value: "image" },
                                    { label: "视频", value: "video" },
                                ]}
                                onChange={(value) => {
                                    setFormKind(value);
                                    if (value === "text") {
                                        setImageDraft(null);
                                        setVideoDraft(null);
                                    } else if (value === "image") {
                                        setVideoDraft(null);
                                    } else if (value === "video") {
                                        setImageDraft(null);
                                    }
                                }}
                            />
                        </Form.Item>
                        <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                            <Input size="large" placeholder="给资产起一个容易检索的名字" />
                        </Form.Item>
                        <Form.Item name="category" label="分类" extra="按用途区分：人物 / 场景 / 道具等；也可输入自定义分类。留空为未分类。">
                            <Select
                                allowClear
                                showSearch
                                mode="tags"
                                maxCount={1}
                                tokenSeparators={[",", "，"]}
                                placeholder="人物 / 场景 / 道具 / 风格参考 / 分镜 / 其他"
                                options={collectAssetCategories(validAssets).map((name) => ({ label: name, value: name }))}
                            />
                        </Form.Item>
                        <Form.Item name="coverUrl" label="封面 URL">
                            <Space.Compact className="w-full">
                                <Input placeholder="可粘贴图片 URL，也可以上传本地封面" />
                                <Button icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                    上传
                                </Button>
                            </Space.Compact>
                        </Form.Item>
                        <Form.Item name="tags" label="标签">
                            <Select mode="tags" tokenSeparators={[",", "，"]} placeholder="输入标签后回车" />
                        </Form.Item>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="source" label="来源">
                                <Input placeholder="手动添加 / 画布 / 提示词库 / 本地导入" />
                            </Form.Item>
                            <Form.Item name="note" label="备注">
                                <Input placeholder="可选" />
                            </Form.Item>
                        </div>
                        {formKind === "text" ? (
                            <Form.Item name="content" label="文本内容" rules={[{ required: true, message: "请输入文本内容" }]}>
                                <Input.TextArea rows={8} placeholder="保存提示词、说明文案、参考描述等文本资产" />
                            </Form.Item>
                        ) : formKind === "video" ? (
                            <Form.Item label="视频内容" required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
                                        选择视频文件
                                    </Button>
                                    {videoDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {videoDraft.width}x{videoDraft.height} · {formatBytes(videoDraft.bytes)} · {videoDraft.mimeType}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            未选择视频
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        ) : (
                            <Form.Item label="图片内容" required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
                                        选择图片文件
                                    </Button>
                                    {imageDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {imageDraft.width}x{imageDraft.height} · {formatBytes(imageDraft.bytes)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            未选择图片
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        )}
                    </Form>
                    <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-950">
                        <Typography.Text strong>预览</Typography.Text>
                        <div className="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                            {formKind === "video" && videoDraft?.url ? (
                                <video src={videoDraft.url} controls className="aspect-[4/3] w-full bg-black object-contain" />
                            ) : coverUrl || imageDraft?.dataUrl ? (
                                <img src={coverUrl || imageDraft?.dataUrl} alt="" className="aspect-[4/3] w-full object-cover" />
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm text-stone-500 dark:bg-stone-900">{content || "暂无封面"}</div>
                            )}
                            <div className="p-4">
                                <Typography.Text strong ellipsis className="block">
                                    {title || "未命名资产"}
                                </Typography.Text>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {tags.length ? (
                                        tags.map((tag) => (
                                            <Tag key={tag} className="m-0">
                                                {tag}
                                            </Tag>
                                        ))
                                    ) : (
                                        <Tag className="m-0">未打标签</Tag>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readCoverFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept={formKind === "video" ? "video/*,.mp4,.webm,.mov,.m4v" : "image/*"}
                    className="hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (formKind === "video") void readVideoFile(file);
                        else void readImageFile(file);
                        event.target.value = "";
                    }}
                />
            </Modal>

            <AssetDrawer asset={previewAsset} onClose={() => setPreviewAsset(null)} onCopy={copyAssetText} onDownload={downloadImage} />

            <input
                ref={assetInputRef}
                type="file"
                multiple
                accept="image/*,video/*,.zip,application/zip,.png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.mov,.m4v"
                className="hidden"
                onChange={(event) => void importAssetFiles(event.target.files)}
            />

            <Modal title="删除资产" open={Boolean(deletingAsset)} onCancel={() => setDeletingAsset(null)} onOk={confirmDelete} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除「{deletingAsset?.title}」吗？删除后会从我的资产中移除。
            </Modal>
        </div>
    );
}

function assetCloudBadgeLabel(badge: AssetCloudBadge) {
    if (badge === "synced") return "已上云";
    if (badge === "pending") return "待同步";
    if (badge === "failed") return "上云失败";
    return "仅本机";
}

function assetCloudBadgeColor(badge: AssetCloudBadge) {
    if (badge === "synced") return cloudSyncColor("synced");
    if (badge === "pending") return cloudSyncColor("pending");
    if (badge === "failed") return cloudSyncColor("failed");
    return cloudSyncColor("skipped");
}

function AssetCard({
    asset,
    cloudBadge,
    categoryOptions,
    onOpen,
    onEdit,
    onCategoryChange,
    onCopy,
    onDownload,
    onUseImage,
    onUseVideo,
    onDelete,
}: {
    asset: Asset;
    cloudBadge: AssetCloudBadge;
    categoryOptions: Array<{ label: string; value: string }>;
    onOpen: () => void;
    onEdit: () => void;
    onCategoryChange: (next?: string) => void;
    onCopy: (asset: Asset) => void;
    onDownload: (asset: Asset) => void;
    onUseImage: () => void;
    onUseVideo: () => void;
    onDelete: () => void;
}) {
    const cover = asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "");
    const summary = assetSummary(asset);
    const categoryValue = resolveAssetCategoryForSave(asset.category);
    const selectOptions = categoryOptions.length ? categoryOptions : standardAssetCategoryOptions();
    return (
        <Card
            hoverable
            className="overflow-hidden"
            styles={{ body: { padding: 0 } }}
            cover={
                <button type="button" className="relative block w-full text-left" onClick={onOpen}>
                    {asset.kind === "video" && asset.data.url ? (
                        <video src={asset.data.url} muted playsInline preload="metadata" className="aspect-[4/3] w-full bg-black object-cover" />
                    ) : cover ? (
                        <img src={cover} alt={asset.title} className="aspect-[4/3] w-full object-cover" />
                    ) : (
                        <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm leading-6 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : "暂无封面"}</div>
                    )}
                    <Tag className="absolute right-2 top-2 m-0 rounded-md px-1.5 text-[11px] shadow-sm" color={assetCloudBadgeColor(cloudBadge)}>
                        {assetCloudBadgeLabel(cloudBadge)}
                    </Tag>
                </button>
            }
        >
            <button type="button" className="block w-full text-left" onClick={onOpen}>
                <div className="p-4 pb-2">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{asset.title}</h2>
                            <Typography.Text type="secondary" className="mt-1 block text-xs">
                                {asset.source || "未标注来源"}
                            </Typography.Text>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                            <Tag className="m-0 text-[11px]">{asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "文本"}</Tag>
                            <Tag className="m-0 text-[11px]" color={assetCloudBadgeColor(cloudBadge)}>
                                {assetCloudBadgeLabel(cloudBadge)}
                            </Tag>
                        </div>
                    </div>
                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} className="!mb-0 !mt-2 !text-xs !leading-5">
                        {summary}
                    </Typography.Paragraph>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        <Tag className="m-0 text-[11px]" color="blue">
                            {assetCategoryLabel(asset.category)}
                        </Tag>
                        {(asset.tags || []).slice(0, 3).map((tag) => (
                            <Tag key={tag} className="m-0 text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                        {!asset.tags?.length ? <Tag className="m-0 text-[11px]">无标签</Tag> : null}
                    </div>
                </div>
            </button>
            <div className="px-4 pb-2" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                <Select
                    size="small"
                    allowClear
                    showSearch
                    className="w-full"
                    placeholder="快速设分类"
                    value={categoryValue}
                    options={selectOptions}
                    onChange={(value) => onCategoryChange(typeof value === "string" ? value : undefined)}
                />
            </div>
            <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
                {asset.kind === "text" ? (
                    <>
                        <Button size="small" type="primary" icon={<ImagePlus className="size-3.5" />} onClick={onUseImage}>
                            生图
                        </Button>
                        <Button size="small" icon={<VideoIcon className="size-3.5" />} onClick={onUseVideo}>
                            视频
                        </Button>
                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void onCopy(asset)}>
                            复制
                        </Button>
                    </>
                ) : (
                    <>
                        <Button size="small" type="primary" onClick={onUseImage}>
                            去工作台
                        </Button>
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(asset)}>
                            下载
                        </Button>
                    </>
                )}
                <Button size="small" icon={<PencilLine className="size-3.5" />} onClick={onEdit}>
                    编辑
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                    删除
                </Button>
            </div>
        </Card>
    );
}

function AssetDrawer({ asset, onClose, onCopy, onDownload }: { asset: Asset | null; onClose: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void }) {
    const cover = asset ? asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "") : "";
    return (
        <Drawer title="资产详情" open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {asset.kind === "video" && asset.data.url ? (
                        <video src={asset.data.url} controls className="w-full rounded-lg bg-black" />
                    ) : cover ? (
                        <Image src={cover} alt={asset.title} className="rounded-lg" />
                    ) : (
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : "暂无封面"}</div>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <Tag className="m-0">{asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "文本"}</Tag>
                        <Tag className="m-0" color="blue">
                            {assetCategoryLabel(asset.category)}
                        </Tag>
                        <Tag className="m-0" color={assetCloudBadgeColor(getAssetCloudBadge(asset))}>
                            {assetCloudBadgeLabel(getAssetCloudBadge(asset))}
                        </Tag>
                    </div>
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "文本"}</Tag>
                            {(asset.tags || []).map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                        </Space>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                        <Typography.Text type="secondary" className="block text-xs">
                            内容
                        </Typography.Text>
                        {asset.kind === "text" ? (
                            <Typography.Paragraph className="mt-2 whitespace-pre-wrap">{asset.data.content}</Typography.Paragraph>
                        ) : asset.kind === "video" ? (
                            <video src={asset.data.url} controls className="mt-2 aspect-video w-full rounded-lg bg-black" />
                        ) : (
                            <Typography.Text className="mt-2 block">
                                {asset.data.width}x{asset.data.height} · {formatBytes(asset.data.bytes)} · {asset.data.mimeType}
                            </Typography.Text>
                        )}
                    </div>
                    {asset.note ? (
                        <div>
                            <Typography.Text type="secondary">备注</Typography.Text>
                            <Typography.Paragraph className="mt-1">{asset.note}</Typography.Paragraph>
                        </div>
                    ) : null}
                    <Space>
                        {asset.kind === "text" ? (
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(asset)}>
                                复制文本
                            </Button>
                        ) : null}
                        {asset.kind === "image" || asset.kind === "video" ? (
                            <Button type="primary" icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                                {asset.kind === "video" ? "下载视频" : "下载图片"}
                            </Button>
                        ) : null}
                    </Space>
                </div>
            ) : null}
        </Drawer>
    );
}

function assetSummary(asset: Asset) {
    if (asset.kind === "text") return asset.data.content;
    return `${asset.data.width}x${asset.data.height} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
}

function assetSearchText(asset: Asset) {
    return [asset.title, asset.category || "", asset.source || "", asset.note || "", (asset.tags || []).join(" "), asset.kind === "text" ? asset.data.content : asset.data.mimeType].join(" ").toLowerCase();
}

function fileNameWithoutExtension(name: string) {
    return name.replace(/\.[^.]+$/, "").trim() || name;
}

function isAssetPackageFile(file: File) {
    const name = file.name.toLowerCase();
    return file.type === "application/zip" || file.type === "application/x-zip-compressed" || name.endsWith(".zip");
}

function isLikelyImageFile(file: File) {
    return /\.(png|jpe?g|webp|gif|bmp|svg|avif|heic|heif)$/i.test(file.name);
}

function isLikelyVideoFile(file: File) {
    return /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(file.name);
}
