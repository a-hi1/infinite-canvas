import { FolderPlus, ImagePlus, Plus, RefreshCw, Search, Star, Trash2, VideoIcon, WandSparkles } from "lucide-react";
import { type UIEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Empty, Form, Input, Modal, Segmented, Space, Spin, Tag } from "antd";

import { PromptCard } from "@/components/prompts/prompt-card";
import { usePromptList, type PromptLibraryScope } from "@/components/prompts/use-prompt-list";
import { PromptDetailDialog } from "./components/prompt-detail-dialog";
import { useCopyText } from "@/hooks/use-copy-text";
import { optimizeGenerationPrompt } from "@/lib/prompt-optimize";
import { cn } from "@/lib/utils";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import {
    ALL_PROMPTS_OPTION,
    PROMPT_QUALITY_MODES,
    deleteMyPrompt,
    rememberRecentPrompt,
    saveMyPrompt,
    savePromptToMine,
    toggleFavoritePrompt,
    type Prompt,
    type PromptQualityMode,
} from "@/services/api/prompts";

type MyPromptForm = {
    title: string;
    prompt: string;
    tagsText: string;
};

export default function PromptsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [form] = Form.useForm<MyPromptForm>();
    const [titleKeyword, setTitleKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [qualityMode, setQualityMode] = useState<PromptQualityMode>("featured");
    const [scope, setScope] = useState<PromptLibraryScope>("browse");
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [editingMine, setEditingMine] = useState<Prompt | null>(null);
    const [mineModalOpen, setMineModalOpen] = useState(false);
    const [optimizingMine, setOptimizingMine] = useState(false);
    const addAsset = useAssetStore((state) => state.addAsset);
    const copyText = useCopyText();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const textModel = effectiveConfig.textModel || effectiveConfig.model;

    const {
        query,
        items: promptItems,
        tags: promptTags,
        categories: promptCategoryOptions,
        getLabel,
        total: totalPrompts,
        featuredTotal,
        sources,
        fetchedAt,
        fromCache,
        recentItems,
        favoriteIds,
        refreshRecent,
        refreshLocal,
        refresh,
    } = usePromptList({
        keyword: titleKeyword,
        tags: selectedTags,
        category: selectedCategory,
        qualityMode,
        scope,
    });

    useEffect(() => {
        if (query.isError && scope === "browse") {
            message.error(query.error instanceof Error ? query.error.message : "获取提示词失败");
        }
    }, [message, query.error, query.isError, scope]);

    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };

    const savePromptAsset = (item: Prompt) => {
        addAsset({
            kind: "text",
            title: item.title,
            coverUrl: item.coverUrl,
            tags: item.tags,
            source: item.category,
            data: { content: item.prompt },
            metadata: { source: "prompt-library", promptId: item.id, githubUrl: item.githubUrl },
        });
        message.success({
            content: (
                <span className="inline-flex items-center gap-2">
                    <span>已加入我的素材</span>
                    <button type="button" className="underline underline-offset-2" onClick={() => navigate("/assets")}>
                        去查看
                    </button>
                </span>
            ),
            duration: 2.5,
        });
    };

    const openWorkbench = async (item: Prompt, target: "image" | "video", optimize = false) => {
        await rememberRecentPrompt(item);
        void refreshRecent();
        const params = new URLSearchParams({ prompt: item.prompt });
        if (optimize) params.set("optimize", "1");
        navigate(`/${target}?${params.toString()}`);
    };

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            if (scope === "browse") {
                await refresh();
                message.success("提示词库已刷新");
            } else {
                await refreshLocal();
                message.success("本地列表已刷新");
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "刷新失败");
        } finally {
            setRefreshing(false);
        }
    };

    const handleToggleFavorite = async (item: Prompt) => {
        const result = await toggleFavoritePrompt(item);
        await refreshLocal();
        message.success(result.favorited ? "已加入收藏夹" : "已取消收藏");
        if (selectedPrompt?.id === item.id) setSelectedPrompt(item);
    };

    const handleSaveToMine = async (item: Prompt) => {
        await savePromptToMine(item);
        await refreshLocal();
        message.success("已保存到我的提示词");
    };

    const openCreateMine = () => {
        setEditingMine(null);
        form.setFieldsValue({ title: "", prompt: "", tagsText: "" });
        setMineModalOpen(true);
    };

    const openEditMine = (item: Prompt) => {
        setEditingMine(item);
        form.setFieldsValue({
            title: item.title,
            prompt: item.prompt,
            tagsText: (item.tags || []).join(", "),
        });
        setMineModalOpen(true);
    };

    const submitMine = async () => {
        try {
            const values = await form.validateFields();
            const tags = values.tagsText
                .split(/[,，]/)
                .map((item) => item.trim())
                .filter(Boolean);
            const saved = await saveMyPrompt({
                id: editingMine?.id,
                title: values.title,
                prompt: values.prompt,
                tags,
                coverUrl: editingMine?.coverUrl,
            });
            await refreshLocal();
            setMineModalOpen(false);
            setSelectedPrompt(saved);
            message.success(editingMine ? "我的提示词已更新" : "我的提示词已创建");
        } catch (error) {
            if (error && typeof error === "object" && "errorFields" in error) return;
            message.error(error instanceof Error ? error.message : "保存失败");
        }
    };

    const optimizeMineDraft = async () => {
        const draft = (form.getFieldValue("prompt") || "").trim();
        if (!draft) {
            message.warning("请先填写提示词内容");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, textModel)) {
            message.warning("请先配置可用的文本模型，用于优化提示词");
            openConfigDialog(true);
            return;
        }
        setOptimizingMine(true);
        try {
            const optimized = await optimizeGenerationPrompt(effectiveConfig, draft, "image", {
                onDelta: (value) => form.setFieldValue("prompt", value),
            });
            form.setFieldValue("prompt", optimized);
            message.success("已优化到编辑框，确认后可保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "提示词优化失败");
        } finally {
            setOptimizingMine(false);
        }
    };

    const optimizeMineAndUse = async (item: Prompt) => {
        if (!isAiConfigReady(effectiveConfig, textModel)) {
            message.warning("请先配置可用的文本模型，用于优化提示词");
            openConfigDialog(true);
            return;
        }
        setOptimizingMine(true);
        try {
            const optimized = await optimizeGenerationPrompt(effectiveConfig, item.prompt, "image");
            // 默认另存为新模板，不覆盖原文
            const saved = await saveMyPrompt({
                title: `${item.title}（优化）`,
                prompt: optimized,
                tags: [...(item.tags || []), "AI优化"],
                coverUrl: item.coverUrl,
            });
            await refreshLocal();
            await openWorkbench(saved, "image");
            message.success("已优化并保存为新模板，正在进入生图");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "提示词优化失败");
        } finally {
            setOptimizingMine(false);
        }
    };

    const handleDeleteMine = async (item: Prompt) => {
        await deleteMyPrompt(item.id);
        await refreshLocal();
        if (selectedPrompt?.id === item.id) setSelectedPrompt(null);
        message.success("已删除我的提示词");
    };

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        if (scope !== "browse") return;
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) {
            void query.fetchNextPage();
        }
    };

    const okSources = sources.filter((item) => item.ok).length;
    const failedSources = sources.filter((item) => !item.ok);
    const loading = scope === "browse" ? query.isLoading : false;
    const emptyText = useMemo(() => {
        if (scope === "favorites") return "收藏夹还是空的，去浏览里给模板点星标吧";
        if (scope === "mine") return "还没有我的提示词，点击右上角新建";
        return qualityMode === "all" ? "没有找到匹配的提示词" : "当前筛选下没有精选结果，可切换到“全部”";
    }, [qualityMode, scope]);

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)]" onScroll={handleListScroll}>
                <div className="pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">提示词中心</h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">浏览公共模板、管理收藏与我的提示词；最近使用只做快捷入口。</p>
                        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                            <Segmented
                                value={scope}
                                options={[
                                    { label: "浏览", value: "browse" },
                                    { label: "收藏夹", value: "favorites" },
                                    { label: "我的提示词", value: "mine" },
                                ]}
                                onChange={(value) => {
                                    setScope(value as PromptLibraryScope);
                                    setSelectedTags([]);
                                    setSelectedCategory(ALL_PROMPTS_OPTION);
                                }}
                            />
                            {scope === "browse" ? (
                                <Segmented value={qualityMode} options={PROMPT_QUALITY_MODES.map((item) => ({ label: item.label, value: item.value }))} onChange={(value) => setQualityMode(value as PromptQualityMode)} />
                            ) : null}
                            <Button icon={<RefreshCw className={cn("size-4", refreshing && "animate-spin")} />} loading={refreshing} onClick={() => void handleRefresh()}>
                                {scope === "browse" ? "强制刷新" : "刷新本地"}
                            </Button>
                            {scope === "mine" ? (
                                <Button type="primary" icon={<Plus className="size-4" />} onClick={openCreateMine}>
                                    新建提示词
                                </Button>
                            ) : null}
                        </div>
                        <div className="mt-3 text-xs text-stone-500 dark:text-stone-400">
                            {scope === "browse" ? (
                                <>
                                    当前 {totalPrompts} 条 · 精选池约 {featuredTotal} 条 · 来源 {okSources}/{sources.length || 0}
                                    {fromCache ? " · 缓存" : " · 最新"}
                                    {fetchedAt ? ` · ${new Date(fetchedAt).toLocaleString("zh-CN")}` : ""}
                                </>
                            ) : (
                                <>当前 {totalPrompts} 条本地{scope === "favorites" ? "收藏" : "模板"}</>
                            )}
                        </div>
                        {scope === "browse" && failedSources.length ? (
                            <div className="mx-auto mt-3 max-w-3xl rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-left text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
                                部分来源同步失败：{failedSources.map((item) => `${item.label || item.category}${item.error ? `(${item.error})` : ""}`).join("；")}
                            </div>
                        ) : null}
                    </div>

                    {loading ? (
                        <div className="flex h-60 items-center justify-center">
                            <Spin />
                        </div>
                    ) : null}

                    {!loading ? (
                        <>
                            <div className="mx-auto mt-8 w-full max-w-2xl">
                                <Input size="large" className="w-full" prefix={<Search className="size-4 text-stone-400" />} value={titleKeyword} placeholder="搜索标题、用途摘要、标签" onChange={(event) => setTitleKeyword(event.target.value)} />
                            </div>
                            <div className="mx-auto mt-6 grid max-w-6xl gap-3 text-left">
                                {scope === "browse" ? (
                                    <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-start">
                                        <div className="pt-2 text-xs font-medium text-stone-500 dark:text-stone-400">分类</div>
                                        <div className="flex flex-wrap gap-2">
                                            {promptCategoryOptions.map((category) => (
                                                <Tag.CheckableTag key={category} checked={selectedCategory === category} className={cn("prompt-filter-tag", selectedCategory === category && "is-active")} onChange={() => setSelectedCategory(category)}>
                                                    {getLabel(category)}
                                                </Tag.CheckableTag>
                                            ))}
                                        </div>
                                    </div>
                                ) : null}
                                <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-start">
                                    <div className="pt-2 text-xs font-medium text-stone-500 dark:text-stone-400">标签</div>
                                    <div className="flex flex-wrap gap-2">
                                        {promptTags.slice(0, 24).map((tag) => (
                                            <Tag.CheckableTag
                                                key={tag}
                                                checked={tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag)}
                                                className={cn("prompt-filter-tag", (tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag)) && "is-active")}
                                                onChange={() => toggleTag(tag)}
                                            >
                                                {tag}
                                            </Tag.CheckableTag>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : null}
                </div>

                {!loading && scope === "browse" && recentItems.length ? (
                    <div className="mx-auto mb-8 max-w-7xl">
                        <div className="mb-2">
                            <div className="text-sm font-semibold text-stone-700 dark:text-stone-200">最近使用</div>
                            <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">横向快捷入口；收藏请点星标，长期资源请进我的素材</div>
                        </div>
                        <div className="hover-scrollbar flex gap-3 overflow-x-auto pb-2">
                            {recentItems.slice(0, 8).map((item) => (
                                <div key={`recent-${item.id}`} className="w-72 shrink-0 rounded-xl border border-stone-200 bg-card p-3 shadow-sm dark:border-stone-800">
                                    <button type="button" className="block w-full text-left" onClick={() => setSelectedPrompt(item)}>
                                        <div className="line-clamp-1 text-sm font-semibold text-stone-900 dark:text-stone-100">{item.title}</div>
                                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{item.summary || item.prompt}</div>
                                    </button>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        <Button size="small" type="primary" icon={<ImagePlus className="size-3.5" />} onClick={() => void openWorkbench(item, "image")}>
                                            生图
                                        </Button>
                                        <Button size="small" icon={<VideoIcon className="size-3.5" />} onClick={() => void openWorkbench(item, "video")}>
                                            视频
                                        </Button>
                                        <Button size="small" icon={<Star className="size-3.5" />} onClick={() => void handleToggleFavorite(item)}>
                                            {favoriteIds.has(item.id) ? "已收藏" : "收藏"}
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(item)}>
                                            素材
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}

                {!loading ? (
                    <div>
                        <div className="mx-auto grid max-w-7xl gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                            {promptItems.map((item) => (
                                <PromptCard
                                    key={`${scope}-${item.id}`}
                                    item={item}
                                    onOpen={() => setSelectedPrompt(item)}
                                    onCopy={() => void openWorkbench(item, "image")}
                                    actionLabel="用于生图"
                                    actionIcon={<ImagePlus className="size-3.5" />}
                                    actionType="primary"
                                    extraAction={
                                        <>
                                            <Button className="shrink-0" size="small" icon={<VideoIcon className="size-3.5" />} onClick={() => void openWorkbench(item, "video")}>
                                                视频
                                            </Button>
                                            {scope === "mine" ? (
                                                <>
                                                    <Button className="shrink-0" size="small" icon={<WandSparkles className="size-3.5" />} loading={optimizingMine} onClick={() => void optimizeMineAndUse(item)}>
                                                        优化使用
                                                    </Button>
                                                    <Button className="shrink-0" size="small" onClick={() => openEditMine(item)}>
                                                        编辑
                                                    </Button>
                                                    <Button className="shrink-0" size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => void handleDeleteMine(item)}>
                                                        删除
                                                    </Button>
                                                </>
                                            ) : (
                                                <>
                                                    <Button className="shrink-0" size="small" icon={<Star className="size-3.5" />} type={favoriteIds.has(item.id) ? "primary" : "default"} onClick={() => void handleToggleFavorite(item)}>
                                                        {favoriteIds.has(item.id) ? "已收藏" : "收藏"}
                                                    </Button>
                                                    <Button className="shrink-0" size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(item)}>
                                                        素材
                                                    </Button>
                                                </>
                                            )}
                                        </>
                                    }
                                />
                            ))}
                        </div>
                        {promptItems.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} className="py-16" /> : null}
                        {scope === "browse" ? (
                            <div className="mx-auto mt-6 max-w-7xl text-center text-xs text-stone-500 dark:text-stone-400">
                                {query.isFetchingNextPage ? "加载中..." : query.hasNextPage ? "继续向下滚动加载更多" : promptItems.length > 0 ? "已经到底了" : null}
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </main>

            <PromptDetailDialog
                prompt={selectedPrompt}
                onClose={() => setSelectedPrompt(null)}
                onCopy={(prompt) => copyText(prompt, "提示词已复制")}
                onSaveAsset={savePromptAsset}
                onUseImage={(item) => void openWorkbench(item, "image")}
                onUseVideo={(item) => void openWorkbench(item, "video")}
                onOptimizeAndUseImage={(item) => void openWorkbench(item, "image", true)}
                favorited={selectedPrompt ? favoriteIds.has(selectedPrompt.id) : false}
                onToggleFavorite={(item) => void handleToggleFavorite(item)}
                onSaveToMine={scope === "mine" ? undefined : (item) => void handleSaveToMine(item)}
                onOptimizeMine={scope === "mine" ? (item) => void optimizeMineAndUse(item) : undefined}
            />

            <Modal
                title={editingMine ? "编辑我的提示词" : "新建我的提示词"}
                open={mineModalOpen}
                onCancel={() => setMineModalOpen(false)}
                footer={[
                    <Button key="cancel" onClick={() => setMineModalOpen(false)}>
                        取消
                    </Button>,
                    <Button key="optimize" icon={<WandSparkles className="size-4" />} loading={optimizingMine} onClick={() => void optimizeMineDraft()}>
                        AI 优化
                    </Button>,
                    <Button key="save" type="primary" onClick={() => void submitMine()}>
                        保存
                    </Button>,
                ]}
                destroyOnHidden
            >
                <Form form={form} layout="vertical" requiredMark={false} className="mt-2">
                    <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                        <Input placeholder="例如：电商主图-白底产品" />
                    </Form.Item>
                    <Form.Item name="prompt" label="提示词" rules={[{ required: true, message: "请输入提示词" }]}>
                        <Input.TextArea rows={8} placeholder="写你验证过能出好图的完整提示词" disabled={optimizingMine} />
                    </Form.Item>
                    <Form.Item name="tagsText" label="标签">
                        <Input placeholder="逗号分隔，如：人像, 电影感, 电商" />
                    </Form.Item>
                </Form>
                <Space className="text-xs text-stone-500">
                    <span>编辑框内 AI 优化会写入当前草稿；卡片上的“优化使用”会另存为新模板，不覆盖原文。</span>
                </Space>
            </Modal>
        </div>
    );
}
