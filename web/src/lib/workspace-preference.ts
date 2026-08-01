/** Remember last opened workspace so /workspace can open it directly. */

const LAST_WORKSPACE_KEY = "infinite-canvas:last-workspace-id";

export function getLastWorkspaceId(): string {
    if (typeof window === "undefined") return "";
    try {
        return String(localStorage.getItem(LAST_WORKSPACE_KEY) || "").trim();
    } catch {
        return "";
    }
}

export function setLastWorkspaceId(id: string) {
    if (typeof window === "undefined") return;
    const value = String(id || "").trim();
    if (!value) return;
    try {
        localStorage.setItem(LAST_WORKSPACE_KEY, value);
    } catch {
        // ignore quota / private mode
    }
}

export function clearLastWorkspaceId() {
    if (typeof window === "undefined") return;
    try {
        localStorage.removeItem(LAST_WORKSPACE_KEY);
    } catch {
        // ignore
    }
}

/** True when URL asks to stay on the list (switch workspace) instead of auto-entering. */
export function shouldStayOnWorkspaceList(search: string) {
    const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
    return params.get("list") === "1" || params.get("select") === "1";
}
