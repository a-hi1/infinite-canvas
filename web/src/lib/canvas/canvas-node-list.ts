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
