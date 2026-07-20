import { useCallback, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    ALL_PROMPTS_OPTION,
    FAVORITES_CATEGORY,
    MY_PROMPTS_CATEGORY,
    arrangePrompts,
    fetchPrompts,
    getCategoryLabel,
    getFavoritePrompts,
    getMyPrompts,
    getRecentPrompts,
    refreshPromptLibrary,
    type Prompt,
    type PromptQualityMode,
} from "@/services/api/prompts";

export const PROMPT_PAGE_SIZE = 20;
export type PromptLibraryScope = "browse" | "favorites" | "mine";

export function usePromptList({
    keyword,
    tags,
    category,
    qualityMode = "featured",
    scope = "browse",
    enabled = true,
}: {
    keyword: string;
    tags: string[];
    category: string;
    qualityMode?: PromptQualityMode;
    scope?: PromptLibraryScope;
    enabled?: boolean;
}) {
    const queryClient = useQueryClient();
    const browseMode = scope === "browse";
    // 封面 onError 后 bump，触发本地 re-arrange（精选/仅有图会剔除坏图）
    const [coverEpoch, setCoverEpoch] = useState(0);

    const query = useInfiniteQuery({
        queryKey: ["prompts", keyword, tags, category, qualityMode],
        queryFn: ({ pageParam }) => fetchPrompts({ keyword, tag: tags, category, qualityMode, page: pageParam, pageSize: PROMPT_PAGE_SIZE }),
        initialPageParam: 1,
        getNextPageParam: (lastPage, pages) => (pages.reduce((total, page) => total + page.items.length, 0) < lastPage.total ? pages.length + 1 : undefined),
        enabled: enabled && browseMode,
    });

    const recentQuery = useQuery({
        queryKey: ["recent-prompts"],
        queryFn: getRecentPrompts,
        enabled,
    });
    const favoriteQuery = useQuery({
        queryKey: ["favorite-prompts"],
        queryFn: getFavoritePrompts,
        enabled,
    });
    const myPromptQuery = useQuery({
        queryKey: ["my-prompts"],
        queryFn: getMyPrompts,
        enabled,
    });

    const firstPage = query.data?.pages[0];
    const favoriteItems = favoriteQuery.data || [];
    const myItems = myPromptQuery.data || [];

    const scopedItems = useMemo(() => {
        void coverEpoch;
        if (scope === "favorites") return arrangePrompts(filterLocalPrompts(favoriteItems, keyword, tags), "all");
        if (scope === "mine") return arrangePrompts(filterLocalPrompts(myItems, keyword, tags), "all");
        const loaded = query.data?.pages.flatMap((page) => page.items) || [];
        // 浏览模式：按当前 qualityMode 再滤一遍（封面加载失败后从精选/仅有图中移除）
        return arrangePrompts(loaded, qualityMode);
    }, [coverEpoch, favoriteItems, keyword, myItems, qualityMode, query.data?.pages, scope, tags]);

    const noteCoverBroken = useCallback((_promptId: string, _coverUrl: string) => {
        setCoverEpoch((n) => n + 1);
    }, []);

    const refresh = async () => {
        await refreshPromptLibrary();
        setCoverEpoch(0);
        await queryClient.invalidateQueries({ queryKey: ["prompts"] });
        if (browseMode) await query.refetch();
    };

    const refreshLocal = async () => {
        await Promise.all([recentQuery.refetch(), favoriteQuery.refetch(), myPromptQuery.refetch()]);
    };

    return {
        query,
        items: scopedItems,
        tags: useMemo(() => {
            if (scope === "favorites") return [ALL_PROMPTS_OPTION, ...collectLocalTags(favoriteItems)];
            if (scope === "mine") return [ALL_PROMPTS_OPTION, ...collectLocalTags(myItems)];
            return [ALL_PROMPTS_OPTION, ...(firstPage?.tags || [])];
        }, [favoriteItems, firstPage?.tags, myItems, scope]),
        categories: useMemo(() => [ALL_PROMPTS_OPTION, ...(firstPage?.categories || [])], [firstPage?.categories]),
        categoryLabels: firstPage?.categoryLabels || {},
        total: scope === "browse" ? firstPage?.total || 0 : scopedItems.length,
        featuredTotal: firstPage?.featuredTotal || 0,
        sources: firstPage?.sources || [],
        fetchedAt: firstPage?.fetchedAt || 0,
        fromCache: Boolean(firstPage?.fromCache),
        recentItems: recentQuery.data || [],
        favoriteItems,
        myItems,
        favoriteIds: useMemo(() => new Set(favoriteItems.map((item) => item.id)), [favoriteItems]),
        refreshRecent: () => recentQuery.refetch(),
        refreshFavorites: () => favoriteQuery.refetch(),
        refreshMyPrompts: () => myPromptQuery.refetch(),
        refreshLocal,
        noteCoverBroken,
        getLabel: (categoryValue: string) => {
            if (categoryValue === FAVORITES_CATEGORY) return "收藏夹";
            if (categoryValue === MY_PROMPTS_CATEGORY) return "我的提示词";
            return getCategoryLabel(categoryValue);
        },
        refresh,
    };
}

function filterLocalPrompts(items: Prompt[], keyword: string, tags: string[]) {
    const q = keyword.trim().toLowerCase();
    return items.filter((item) => {
        if (tags.length && !tags.some((tag) => item.tags.includes(tag))) return false;
        if (!q) return true;
        return [item.title, item.prompt, item.summary || "", item.topic || "", ...item.tags].join(" ").toLowerCase().includes(q);
    });
}

function collectLocalTags(items: Prompt[]) {
    const counter = new Map<string, number>();
    for (const item of items) {
        for (const tag of item.tags || []) {
            if (!tag) continue;
            counter.set(tag, (counter.get(tag) || 0) + 1);
        }
    }
    return Array.from(counter.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
        .map(([tag]) => tag)
        .slice(0, 30);
}
