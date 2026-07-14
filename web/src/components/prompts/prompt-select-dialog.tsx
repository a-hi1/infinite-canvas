import { Check, Eye, RefreshCw, Search, Star, WandSparkles } from "lucide-react";
import { type UIEvent, useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Input, Modal, Segmented, Space, Spin, Tag } from "antd";

import {
    ALL_PROMPTS_OPTION,
    PROMPT_QUALITY_MODES,
    getCategoryLabel,
    getPromptQualityLabel,
    getPromptSummary,
    rememberRecentPrompt,
    toggleFavoritePrompt,
    type Prompt,
    type PromptQualityMode,
} from "@/services/api/prompts";
import { optimizeGenerationPrompt } from "@/lib/prompt-optimize";
import { cn } from "@/lib/utils";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { PromptCard } from "./prompt-card";
import { usePromptList, type PromptLibraryScope } from "./use-prompt-list";

export function PromptSelectDialog({
    open,
    onOpenChange,
    onSelect,
    optimizeMode = "image",
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (prompt: string) => void;
    /** 画布/工作台上下文：优化后填入时使用的模式 */
    optimizeMode?: "image" | "video" | "text" | "audio";
}) {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const textModel = effectiveConfig.textModel || effectiveConfig.model;

    const [keyword, setKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [qualityMode, setQualityMode] = useState<PromptQualityMode>("featured");
    const [scope, setScope] = useState<PromptLibraryScope>("browse");
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [optimizing, setOptimizing] = useState(false);

    const {
        query,
        items,
        tags: promptTags,
        categories: promptCategories,
        getLabel,
        total,
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
        keyword,
        tags: selectedTags,
        category: selectedCategory,
        qualityMode,
        scope,
        enabled: open,
    });

    useEffect(() => {
        if (!open) {
            setSelectedPrompt(null);
            setOptimizing(false);
            return;
        }
    }, [open]);

    useEffect(() => {
        if (query.isError && scope === "browse") {
            message.error(query.error instanceof Error ? query.error.message : "获取提示词失败");
        }
    }, [message, query.error, query.isError, scope]);

    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((current) => (current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]));
    };

    const applyPrompt = async (item: Prompt, options?: { optimize?: boolean }) => {
        let text = item.prompt;
        if (options?.optimize) {
            if (!isAiConfigReady(effectiveConfig, textModel)) {
                message.warning("请先配置可用的文本模型，用于优化提示词");
                openConfigDialog(true);
                return;
            }
            setOptimizing(true);
            try {
                text = await optimizeGenerationPrompt(effectiveConfig, item.prompt, optimizeMode);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "提示词优化失败");
                setOptimizing(false);
                return;
            } finally {
                setOptimizing(false);
            }
        }

        await rememberRecentPrompt(item);
        void refreshRecent();
        onSelect(text);
        onOpenChange(false);
        message.success(options?.optimize ? "已优化并填入提示词" : "已填入提示词");
    };

    const handleToggleFavorite = async (item: Prompt) => {
        const result = await toggleFavoritePrompt(item);
        await refreshLocal();
        message.success(result.favorited ? "已加入收藏夹" : "已取消收藏");
        if (selectedPrompt?.id === item.id) setSelectedPrompt(item);
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

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        if (scope !== "browse") return;
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) {
            void query.fetchNextPage();
        }
    };

    const loading = scope === "browse" ? query.isLoading : false;
    const emptyText = useMemo(() => {
        if (scope === "favorites") return "收藏夹还是空的，去浏览里给模板点星标吧";
        if (scope === "mine") return "还没有我的提示词，可到提示词中心新建";
        return qualityMode === "all" ? "没有找到匹配的提示词" : "当前筛选下没有精选结果，可切换到“全部”";
    }, [qualityMode, scope]);
    const okSources = sources.filter((item) => item.ok).length;
    const failedSources = sources.filter((item) => !item.ok);

    return (
        <>
            <Modal
                title={
                    <div className="pr-8">
                        <div className="text-base font-semibold">提示词库</div>
                        <div className="mt-0.5 text-xs font-normal text-stone-500 dark:text-stone-400">挑选模板填入当前输入框，可先预览再使用</div>
                    </div>
                }
                open={open}
                onCancel={() => onOpenChange(false)}
                footer={null}
                width={1080}
                centered
                destroyOnHidden
                styles={{ body: { paddingTop: 12 } }}
            >
                <div data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                    <div className="flex flex-wrap items-center gap-2">
                        <Segmented
                            value={scope}
                            options={[
                                { label: "浏览", value: "browse" },
                                { label: "收藏夹", value: "favorites" },
                                { label: "我的", value: "mine" },
                            ]}
                            onChange={(value) => {
                                setScope(value as PromptLibraryScope);
                                setSelectedTags([]);
                                setSelectedCategory(ALL_PROMPTS_OPTION);
                                setSelectedPrompt(null);
                            }}
                        />
                        {scope === "browse" ? (
                            <Segmented value={qualityMode} options={PROMPT_QUALITY_MODES.map((item) => ({ label: item.label, value: item.value }))} onChange={(value) => setQualityMode(value as PromptQualityMode)} />
                        ) : null}
                        <Button size="small" icon={<RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />} loading={refreshing} onClick={() => void handleRefresh()}>
                            {scope === "browse" ? "强制刷新" : "刷新本地"}
                        </Button>
                        <div className="text-xs text-stone-500 dark:text-stone-400">
                            {scope === "browse" ? (
                                <>
                                    {total} 条 · 精选约 {featuredTotal} · 来源 {okSources}/{sources.length || 0}
                                    {fromCache ? " · 缓存" : " · 最新"}
                                    {fetchedAt ? ` · ${new Date(fetchedAt).toLocaleString("zh-CN")}` : ""}
                                </>
                            ) : (
                                <>{total} 条本地{scope === "favorites" ? "收藏" : "模板"}</>
                            )}
                        </div>
                    </div>

                    {scope === "browse" && failedSources.length ? (
                        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
                            部分来源同步失败：{failedSources.map((item) => `${item.label || item.category}${item.error ? `(${item.error})` : ""}`).join("；")}
                        </div>
                    ) : null}

                    <div className="mt-4">
                        <Input size="large" prefix={<Search className="size-4 text-stone-400" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索标题、用途摘要、标签" allowClear />
                    </div>

                    <div className="mt-4 grid gap-3">
                        {scope === "browse" ? (
                            <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-start">
                                <div className="pt-2 text-xs font-medium text-stone-500 dark:text-stone-400">分类</div>
                                <div className="flex flex-wrap gap-2">
                                    {promptCategories.map((category) => (
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
                                {promptTags.slice(0, 24).map((tag) => {
                                    const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                                    return (
                                        <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag", active && "is-active")} onChange={() => toggleTag(tag)}>
                                            {tag}
                                        </Tag.CheckableTag>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    {!loading && scope === "browse" && recentItems.length ? (
                        <div className="mt-4">
                            <div className="mb-2 text-xs font-medium text-stone-500 dark:text-stone-400">最近使用</div>
                            <div className="hover-scrollbar flex gap-2 overflow-x-auto pb-1">
                                {recentItems.slice(0, 8).map((item) => (
                                    <div key={`recent-${item.id}`} className="w-56 shrink-0 rounded-xl border border-stone-200 bg-card p-2.5 dark:border-stone-800">
                                        <button type="button" className="block w-full text-left" onClick={() => setSelectedPrompt(item)}>
                                            <div className="line-clamp-1 text-sm font-semibold text-stone-900 dark:text-stone-100">{item.title}</div>
                                            <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{item.summary || item.prompt}</div>
                                        </button>
                                        <div className="mt-2 flex gap-1.5">
                                            <Button size="small" type="primary" icon={<Check className="size-3.5" />} onClick={() => void applyPrompt(item)}>
                                                使用
                                            </Button>
                                            <Button size="small" icon={<Eye className="size-3.5" />} onClick={() => setSelectedPrompt(item)}>
                                                预览
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : null}

                    <div className="canvas-prompt-scrollbar mt-5 max-h-[min(520px,58vh)] overflow-y-auto pr-1" data-canvas-no-zoom onScroll={handleListScroll} onWheelCapture={(event) => event.stopPropagation()}>
                        {loading ? (
                            <div className="flex h-40 items-center justify-center">
                                <Spin />
                            </div>
                        ) : null}
                        {!loading ? (
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                {items.map((item) => (
                                    <PromptCard
                                        key={`${scope}-${item.id}`}
                                        item={item}
                                        onOpen={() => setSelectedPrompt(item)}
                                        onCopy={() => void applyPrompt(item)}
                                        actionLabel="使用"
                                        actionIcon={<Check className="size-3.5" />}
                                        actionType="primary"
                                        extraAction={
                                            <>
                                                <Button className="shrink-0" size="small" icon={<Eye className="size-3.5" />} onClick={() => setSelectedPrompt(item)}>
                                                    预览
                                                </Button>
                                                <Button className="shrink-0" size="small" icon={<WandSparkles className="size-3.5" />} loading={optimizing} onClick={() => void applyPrompt(item, { optimize: true })}>
                                                    优化使用
                                                </Button>
                                                <Button className="shrink-0" size="small" icon={<Star className={cn("size-3.5", favoriteIds.has(item.id) && "fill-current")} />} onClick={() => void handleToggleFavorite(item)}>
                                                    {favoriteIds.has(item.id) ? "已收藏" : "收藏"}
                                                </Button>
                                            </>
                                        }
                                    />
                                ))}
                            </div>
                        ) : null}
                        {!loading && items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} className="py-10" /> : null}
                        {query.isFetchingNextPage ? (
                            <div className="py-4 text-center">
                                <Spin size="small" />
                            </div>
                        ) : null}
                    </div>
                </div>
            </Modal>

            <Modal
                title={selectedPrompt?.title || "提示词预览"}
                open={Boolean(selectedPrompt)}
                onCancel={() => setSelectedPrompt(null)}
                footer={null}
                width={760}
                centered
                zIndex={1100}
                destroyOnHidden
            >
                {selectedPrompt ? (
                    <div className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]" data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                        <div className="space-y-3">
                            {selectedPrompt.coverUrl ? (
                                <img src={selectedPrompt.coverUrl} alt={selectedPrompt.title} className="aspect-[4/3] w-full rounded-lg object-cover" />
                            ) : (
                                <div className="flex aspect-[4/3] w-full items-center justify-center rounded-lg bg-stone-100 text-xs text-stone-400 dark:bg-stone-900 dark:text-stone-500">无预览图</div>
                            )}
                            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-5 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
                                <div className="mb-1 font-medium text-stone-800 dark:text-stone-100">用途摘要</div>
                                <div>{getPromptSummary(selectedPrompt)}</div>
                            </div>
                        </div>
                        <div className="min-w-0">
                            <div className="flex flex-wrap gap-1.5">
                                <Tag color="blue" className="m-0">
                                    {getCategoryLabel(selectedPrompt.category)}
                                </Tag>
                                <Tag color="processing" className="m-0">
                                    {getPromptQualityLabel(selectedPrompt.qualityScore || 0)}
                                </Tag>
                                {selectedPrompt.topic ? (
                                    <Tag className="m-0" color="geekblue">
                                        {selectedPrompt.topic}
                                    </Tag>
                                ) : null}
                                {Array.from(new Set(selectedPrompt.tags.filter(Boolean)))
                                    .slice(0, 8)
                                    .map((tag) => (
                                        <Tag key={tag} className="m-0">
                                            {tag}
                                        </Tag>
                                    ))}
                            </div>
                            <div className="canvas-prompt-scrollbar mt-4 max-h-[320px] overflow-y-auto whitespace-pre-wrap pr-1 text-sm leading-7 text-stone-800 dark:text-stone-300">{selectedPrompt.prompt}</div>
                            <Space wrap className="mt-5">
                                <Button type="primary" icon={<Check className="size-4" />} onClick={() => void applyPrompt(selectedPrompt)}>
                                    使用此提示词
                                </Button>
                                <Button icon={<WandSparkles className="size-4" />} loading={optimizing} onClick={() => void applyPrompt(selectedPrompt, { optimize: true })}>
                                    优化后使用
                                </Button>
                                <Button icon={<Star className={cn("size-4", favoriteIds.has(selectedPrompt.id) && "fill-current")} />} onClick={() => void handleToggleFavorite(selectedPrompt)}>
                                    {favoriteIds.has(selectedPrompt.id) ? "已收藏" : "收藏"}
                                </Button>
                            </Space>
                        </div>
                    </div>
                ) : null}
            </Modal>
        </>
    );
}
