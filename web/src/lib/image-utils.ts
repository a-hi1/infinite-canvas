import type { ReferenceImage } from "@/types/image";

export function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDuration(ms: number) {
    const value = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(value / 60);
    const seconds = value % 60;
    return minutes ? `${minutes}分${String(seconds).padStart(2, "0")}秒` : `${seconds}秒`;
}

export function getDataUrlByteSize(dataUrl: string) {
    const base64 = dataUrl.split(",", 2)[1];
    if (!base64) {
        return 0;
    }
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(file);
    });
}

export function readImageMeta(dataUrl: string) {
    return new Promise<{ width: number; height: number; mimeType: string }>((resolve) => {
        const image = new Image();
        // Do not set crossOrigin for remote provider URLs.
        // Hosts like imgen.x.ai often allow plain <img> display but reject CORS reads.
        const done = () => resolve({ width: image.naturalWidth || 1024, height: image.naturalHeight || 1024, mimeType: dataUrl.match(/^data:([^;]+)/)?.[1] || guessImageMimeType(dataUrl) });
        image.onload = done;
        image.onerror = done;
        setTimeout(done, 3000);
        image.src = dataUrl;
    });
}

export function dataUrlToFile(image: ReferenceImage) {
    if (!image.dataUrl.startsWith("data:")) {
        throw new Error("当前参考图是远程地址且无法在浏览器中读取，请重新上传本地图片，或使用返回 base64 的渠道");
    }
    const [header, content] = image.dataUrl.split(",", 2);
    const mimeType = header.match(/data:(.*?);base64/)?.[1] || image.type || "image/png";
    const binary = atob(content || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], image.name || "reference.png", { type: mimeType });
}

/** 压缩 data URI，避免 Grok / 中转站因 base64 过大直接 400。 */
export async function compressImageDataUrl(dataUrl: string, maxEdge = 1280, quality = 0.82) {
    if (!dataUrl.startsWith("data:image/")) return dataUrl;
    if (getDataUrlByteSize(dataUrl) <= 1.2 * 1024 * 1024 && !needsImageResize(dataUrl, maxEdge)) return dataUrl;

    const image = await loadHtmlImage(dataUrl);
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth || maxEdge, image.naturalHeight || maxEdge));
    const width = Math.max(1, Math.round((image.naturalWidth || maxEdge) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || maxEdge) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.drawImage(image, 0, 0, width, height);

    let nextQuality = quality;
    let compressed = canvas.toDataURL("image/jpeg", nextQuality);
    while (getDataUrlByteSize(compressed) > 1.5 * 1024 * 1024 && nextQuality > 0.5) {
        nextQuality -= 0.1;
        compressed = canvas.toDataURL("image/jpeg", nextQuality);
    }
    return compressed;
}

function needsImageResize(dataUrl: string, maxEdge: number) {
    // 快速路径：没有尺寸信息时也允许压缩函数走完整逻辑。
    return getDataUrlByteSize(dataUrl) > 800 * 1024 || maxEdge < 4096;
}

function loadHtmlImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("参考图解码失败"));
        image.src = src;
    });
}

function guessImageMimeType(url: string) {
    const lower = url.toLowerCase();
    if (lower.includes(".jpg") || lower.includes(".jpeg")) return "image/jpeg";
    if (lower.includes(".webp")) return "image/webp";
    if (lower.includes(".gif")) return "image/gif";
    return "image/png";
}
