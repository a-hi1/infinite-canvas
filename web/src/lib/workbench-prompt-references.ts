/**
 * 工作台提示词 @ 引用：把已添加的参考素材映射为 CanvasPromptChipInput 所需结构。
 * 只负责 label / 预览；不改变生成 payload（媒体仍由 references 数组决定）。
 */
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

/** 图片工作台：label = 图片N（与 imageReferenceLabel / 参考条一致） */
export function workbenchImagePromptReferences(images: ReferenceImage[]): CanvasResourceReference[] {
    return images.map((item, index) => toImageReference(item, imageReferenceLabel(index)));
}

/**
 * 视频工作台：先图再视频再音频；各 kind 独立从 0 编号
 * （与 seedanceReferenceLabel / buildSeedancePromptText / 参考条角标一致）
 */
export function workbenchVideoPromptReferences(images: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[]): CanvasResourceReference[] {
    return [
        ...images.map((item, index) => toImageReference(item, seedanceReferenceLabel("image", index))),
        ...videos.map((item, index) => toVideoReference(item, seedanceReferenceLabel("video", index))),
        ...audios.map((item, index) => toAudioReference(item, seedanceReferenceLabel("audio", index))),
    ];
}

function toImageReference(item: ReferenceImage, label: string): CanvasResourceReference {
    return {
        id: item.id,
        nodeId: item.id,
        kind: "image",
        label,
        title: item.name || label,
        previewUrl: item.dataUrl || item.url || undefined,
        active: true,
    };
}

function toVideoReference(item: ReferenceVideo, label: string): CanvasResourceReference {
    return {
        id: item.id,
        nodeId: item.id,
        kind: "video",
        label,
        title: item.name || label,
        previewUrl: item.url || undefined,
        active: true,
    };
}

function toAudioReference(item: ReferenceAudio, label: string): CanvasResourceReference {
    return {
        id: item.id,
        nodeId: item.id,
        kind: "audio",
        label,
        title: item.name || label,
        text: item.name || label,
        active: true,
    };
}
