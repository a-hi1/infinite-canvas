/** Workspace item folder helpers — orthogonal to asset category taxonomy. */

/** Client filter sentinel: empty / missing folder. */
export const WORKSPACE_UNFILED_VALUE = "__unfiled__";
/** Client filter sentinel: show every folder. */
export const ALL_FOLDERS_VALUE = "all";

export function normalizeWorkspaceFolder(value?: string | null): string {
    // Strip C0 control chars + DEL so free-text folder names stay printable.
    return String(value || "")
        .replace(/[\x00-\x1F\x7F]/g, "")
        .trim()
        .slice(0, 80);
}

/** Stable filter key for chips (empty → unfiled sentinel). */
export function workspaceFolderFilterKey(value?: string | null): string {
    const name = normalizeWorkspaceFolder(value);
    return name || WORKSPACE_UNFILED_VALUE;
}

export function matchesWorkspaceFolderFilter(value: string | undefined | null, filter: string): boolean {
    if (!filter || filter === ALL_FOLDERS_VALUE) return true;
    return workspaceFolderFilterKey(value) === filter;
}

/** Unique non-empty folder names, locale-sorted. */
export function collectWorkspaceFolders(items: Array<{ folder?: string | null }>): string[] {
    const names = new Set<string>();
    for (const item of items) {
        const name = normalizeWorkspaceFolder(item.folder);
        if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export type WorkspaceFolderFilterOption = {
    label: string;
    value: string;
    count: number;
};

/**
 * Build chip options: named folders + 未归入 (if any).
 * No 「全部」 chip — empty/all filter is the default (no chip selected).
 * ALL_FOLDERS_VALUE remains the client sentinel for “show every folder”.
 */
export function buildWorkspaceFolderFilterOptions(
    items: Array<{ folder?: string | null }>,
): WorkspaceFolderFilterOption[] {
    const counts = new Map<string, number>();
    let unfiled = 0;
    for (const item of items) {
        const name = normalizeWorkspaceFolder(item.folder);
        if (!name) {
            unfiled += 1;
            continue;
        }
        counts.set(name, (counts.get(name) || 0) + 1);
    }
    const options: WorkspaceFolderFilterOption[] = [...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))
        .map(([name, count]) => ({ label: name, value: name, count }));
    if (unfiled > 0) {
        options.push({ label: "未归入", value: WORKSPACE_UNFILED_VALUE, count: unfiled });
    }
    return options;
}

/** Select options for upload / batch / share (empty = 未归入). */
export function workspaceFolderSelectOptions(
    items: Array<{ folder?: string | null }>,
    extra?: string | null,
): Array<{ label: string; value: string }> {
    const names = collectWorkspaceFolders(items);
    const extraName = normalizeWorkspaceFolder(extra);
    if (extraName && !names.includes(extraName)) names.unshift(extraName);
    return [
        { label: "未归入文件夹", value: "" },
        ...names.map((name) => ({ label: name, value: name })),
    ];
}

/** Resolve UI value for save (trim; empty stays empty). */
export function resolveWorkspaceFolderForSave(value?: string | null): string {
    return normalizeWorkspaceFolder(value);
}
