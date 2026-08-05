/** Workspace item wall order helpers — per-folder custom sort. */

import {
    ALL_FOLDERS_VALUE,
    WORKSPACE_UNFILED_VALUE,
    normalizeWorkspaceFolder,
    workspaceFolderFilterKey,
} from "@/lib/workspace-folder";

export type WorkspaceSortableItem = {
    id: string;
    folder?: string | null;
    folder_sort_order?: number | null;
    is_final?: boolean;
    created_at?: string;
};

export function workspaceItemFolderKey(item: Pick<WorkspaceSortableItem, "folder">): string {
    return workspaceFolderFilterKey(item.folder);
}

export function hasExplicitFolderSortOrder(item: Pick<WorkspaceSortableItem, "folder_sort_order">): boolean {
    return item.folder_sort_order != null && Number.isFinite(Number(item.folder_sort_order));
}

/** True when any item in the same folder key already has an explicit order. */
export function folderHasCustomOrder(items: WorkspaceSortableItem[], folderKey: string): boolean {
    return items.some((item) => workspaceItemFolderKey(item) === folderKey && hasExplicitFolderSortOrder(item));
}

/**
 * Compare within one folder:
 * - if any sibling has explicit order (caller may pass only folder peers), use order then created_at;
 * - else finals-first + newest (legacy wall feel).
 */
export function compareWorkspaceItemsInFolder(
    a: WorkspaceSortableItem,
    b: WorkspaceSortableItem,
    options?: { useCustomOrder?: boolean },
): number {
    const useCustom = options?.useCustomOrder;
    if (useCustom) {
        const aHas = hasExplicitFolderSortOrder(a);
        const bHas = hasExplicitFolderSortOrder(b);
        const ao = aHas ? Number(a.folder_sort_order) : Number.MAX_SAFE_INTEGER;
        const bo = bHas ? Number(b.folder_sort_order) : Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return String(b.created_at || "").localeCompare(String(a.created_at || "")) || String(a.id).localeCompare(String(b.id));
    }
    const af = a.is_final ? 1 : 0;
    const bf = b.is_final ? 1 : 0;
    if (af !== bf) return bf - af;
    return String(b.created_at || "").localeCompare(String(a.created_at || "")) || String(a.id).localeCompare(String(b.id));
}

/**
 * Display sort for wall lists.
 * - single folder / unfiled filter: sort inside that folder only
 * - all folders: group by folder name, then same in-folder rules
 */
export function sortWorkspaceItemsForDisplay<T extends WorkspaceSortableItem>(
    items: T[],
    options?: { folderFilter?: string },
): T[] {
    const folderFilter = options?.folderFilter ?? ALL_FOLDERS_VALUE;
    if (!items.length) return [];

    if (folderFilter && folderFilter !== ALL_FOLDERS_VALUE) {
        const useCustom = folderHasCustomOrder(items, folderFilter);
        return [...items].sort((a, b) => compareWorkspaceItemsInFolder(a, b, { useCustomOrder: useCustom }));
    }

    // All folders: named folders first (locale), unfiled last; each group independent.
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const key = workspaceItemFolderKey(item);
        const list = groups.get(key);
        if (list) list.push(item);
        else groups.set(key, [item]);
    }
    const keys = [...groups.keys()].sort((a, b) => {
        if (a === WORKSPACE_UNFILED_VALUE) return 1;
        if (b === WORKSPACE_UNFILED_VALUE) return -1;
        return a.localeCompare(b, "zh-CN");
    });
    const out: T[] = [];
    for (const key of keys) {
        const group = groups.get(key) || [];
        const useCustom = folderHasCustomOrder(group, key);
        out.push(...group.sort((a, b) => compareWorkspaceItemsInFolder(a, b, { useCustomOrder: useCustom })));
    }
    return out;
}

/**
 * Optimistic local reorder: assign sparse folder_sort_order to orderedIds in list order.
 * Other items unchanged.
 */
export function applyLocalReorder<T extends WorkspaceSortableItem>(items: T[], orderedIds: string[]): T[] {
    const orderMap = new Map(orderedIds.map((id, index) => [id, (index + 1) * 1024]));
    return items.map((item) => {
        const next = orderMap.get(item.id);
        if (next == null) return item;
        return { ...item, folder_sort_order: next };
    });
}

/** API body folder: empty string for unfiled; never send __unfiled__. */
export function folderParamForReorderApi(folderFilter: string): string {
    if (!folderFilter || folderFilter === ALL_FOLDERS_VALUE || folderFilter === WORKSPACE_UNFILED_VALUE) {
        return "";
    }
    return normalizeWorkspaceFolder(folderFilter);
}

/** Whether wall drag-reorder is allowed for current folder chip. */
export function canDragReorderFolder(folderFilter: string): boolean {
    return Boolean(folderFilter) && folderFilter !== ALL_FOLDERS_VALUE;
}

/**
 * Move sourceId to the position of targetId (before if insertBefore, else after).
 * Returns new ordered id list for the visible items.
 */
export function moveOrderedId(visibleIds: string[], sourceId: string, targetId: string, insertBefore: boolean): string[] {
    if (sourceId === targetId) return visibleIds.slice();
    const without = visibleIds.filter((id) => id !== sourceId);
    const targetIndex = without.indexOf(targetId);
    if (targetIndex < 0) return visibleIds.slice();
    const insertAt = insertBefore ? targetIndex : targetIndex + 1;
    const next = without.slice();
    next.splice(insertAt, 0, sourceId);
    return next;
}
