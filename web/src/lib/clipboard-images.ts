/** Clipboard image helpers for workbench/canvas.
 *
 * `navigator.clipboard.read()` only works in secure contexts (HTTPS / localhost).
 * Server deployments over plain `http://IP:port` fail that API; paste events still
 * expose images via `event.clipboardData` and work without permissions.
 */

export const CLIPBOARD_INSECURE_HINT =
    "当前为 HTTP 页面，浏览器禁止主动读取剪贴板。请在参考图区域按 Ctrl+V 粘贴截图，或改用上传/拖拽。";

export const CLIPBOARD_EMPTY_HINT = "剪切板里没有可读取的图片";

export const CLIPBOARD_DENIED_HINT =
    "浏览器拒绝读取剪贴板。请允许剪贴板权限，或在参考图区域按 Ctrl+V 粘贴。";

export function isClipboardAsyncReadAvailable() {
    return typeof window !== "undefined" && Boolean(window.isSecureContext && navigator.clipboard?.read);
}

export function clipboardImagesFromDataTransfer(data: DataTransfer | null | undefined): File[] {
    if (!data) return [];
    const fromFiles = Array.from(data.files || []).filter((file) => file.type.startsWith("image/"));
    if (fromFiles.length) return fromFiles;

    const items = Array.from(data.items || []);
    const blobs: File[] = [];
    items.forEach((item, index) => {
        if (item.kind !== "file" || !item.type.startsWith("image/")) return;
        const file = item.getAsFile();
        if (!file) return;
        const name = file.name && file.name !== "image.png" ? file.name : `clipboard-${index + 1}.png`;
        blobs.push(file.name ? file : new File([file], name, { type: file.type || "image/png" }));
    });
    return blobs;
}

export function clipboardImagesFromPasteEvent(event: ClipboardEvent | { clipboardData?: DataTransfer | null }): File[] {
    return clipboardImagesFromDataTransfer(event.clipboardData || null);
}

export async function readClipboardImageBlobs(): Promise<Blob[]> {
    if (typeof window === "undefined") throw new Error(CLIPBOARD_EMPTY_HINT);
    if (!window.isSecureContext || !navigator.clipboard?.read) {
        throw new Error(CLIPBOARD_INSECURE_HINT);
    }
    try {
        const items = await navigator.clipboard.read();
        const blobs = await Promise.all(
            items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))),
        );
        if (!blobs.length) throw new Error(CLIPBOARD_EMPTY_HINT);
        return blobs;
    } catch (error) {
        if (error instanceof Error && (error.message === CLIPBOARD_INSECURE_HINT || error.message === CLIPBOARD_EMPTY_HINT)) {
            throw error;
        }
        const name = error instanceof DOMException ? error.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
            throw new Error(CLIPBOARD_DENIED_HINT);
        }
        throw new Error(CLIPBOARD_EMPTY_HINT);
    }
}

/** True when paste should not steal images from form fields / contenteditable. */
export function shouldIgnoreClipboardPasteTarget(target: EventTarget | null) {
    // Guard for non-DOM runtimes (unit tests) and non-element targets.
    if (!target || typeof Element === "undefined" || !(target instanceof Element)) return false;
    if (
        (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) ||
        (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement) ||
        (typeof HTMLSelectElement !== "undefined" && target instanceof HTMLSelectElement)
    ) {
        return true;
    }
    return Boolean(target.closest?.("input, textarea, select, [contenteditable='true'], [data-no-clipboard-paste]"));
}
