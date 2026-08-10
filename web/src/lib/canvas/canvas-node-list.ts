import { displayNodeTitle } from "@/lib/canvas/node-title";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

export type CanvasNodeListType = "all" | CanvasNodeType;

export function listCanvasNavigationNodes(nodes: CanvasNodeData[]) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return nodes.filter((node) => {
        const rootId = node.metadata?.batchRootId;
        if (!rootId) return true;
        const root = nodeById.get(rootId);
        return !root || Boolean(root.metadata?.imageBatchExpanded);
    });
}

export function filterCanvasNavigationNodes(nodes: CanvasNodeData[], query: string, type: CanvasNodeListType = "all") {
    const normalizedQuery = normalizeSearchText(query);
    return listCanvasNavigationNodes(nodes).filter((node) => {
        if (type !== "all" && node.type !== type) return false;
        if (!normalizedQuery) return true;
        const metadata = node.metadata;
        return normalizeSearchText([
            displayNodeTitle(node.title, node.type, metadata?.prompt),
            node.title,
            metadata?.prompt,
            metadata?.composerContent,
            node.type === CanvasNodeType.Text ? metadata?.content : undefined,
        ].filter(Boolean).join(" ")).includes(normalizedQuery);
    });
}

/** Default max zoom when locating a node from the list (100%). Manual wheel zoom stays uncapped here. */
export const CANVAS_LOCATE_MAX_ZOOM = 1;

/**
 * Fit scale so the node occupies ~60% of the visible viewport, clamped to [minZoom, maxZoom].
 * Used by side-panel locate; does not change pan/zoom limits for free navigation.
 */
export function fitViewportScaleForNode(
    node: CanvasNodeData,
    size: { width: number; height: number },
    options?: { leftInset?: number; minZoom?: number; maxZoom?: number; coverage?: number },
) {
    const width = Math.max(0, finiteNumber(size.width));
    const height = Math.max(0, finiteNumber(size.height));
    const leftInset = Math.max(0, finiteNumber(options?.leftInset));
    const viewWidth = Math.max(width - leftInset, 1);
    const minZoom = options?.minZoom ?? 0.05;
    const maxZoom = options?.maxZoom ?? CANVAS_LOCATE_MAX_ZOOM;
    const coverage = options?.coverage ?? 0.6;
    const fitted = Math.min(
        (viewWidth * coverage) / Math.max(node.width, 1),
        (height * coverage) / Math.max(node.height, 1),
    );
    return Math.min(Math.max(fitted, minZoom), maxZoom);
}

export function centerViewportOnNode(
    node: CanvasNodeData,
    viewport: ViewportTransform,
    size: { width: number; height: number },
    visibleArea?: { left?: number },
): ViewportTransform {
    const width = Math.max(0, finiteNumber(size.width));
    const height = Math.max(0, finiteNumber(size.height));
    const requestedLeft = Math.max(0, finiteNumber(visibleArea?.left));
    const left = width > 0 ? Math.min(requestedLeft, Math.max(0, width - 1)) : 0;
    const visibleCenterX = left + (width - left) / 2;

    return {
        x: visibleCenterX - (node.position.x + node.width / 2) * viewport.k,
        y: height / 2 - (node.position.y + node.height / 2) * viewport.k,
        k: viewport.k,
    };
}

function finiteNumber(value: number | undefined) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeSearchText(value: string) {
    return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}
