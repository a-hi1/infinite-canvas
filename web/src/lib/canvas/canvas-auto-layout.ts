import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";

export type CanvasAutoLayoutOptions = {
    /** When non-empty, only these node ids (plus co-moved group/batch members) are rearranged. */
    selectedIds?: Iterable<string>;
    columnGap?: number;
    rowGap?: number;
    origin?: Position;
    /** Barycenter ordering passes (L→R then R→L each count as half-round). Default 2 full rounds. */
    orderPasses?: number;
};

/**
 * Hierarchical left-to-right layout for canvas nodes.
 * Groups move as units; batch children keep relative offsets to their root.
 * Layer order uses barycenter (median neighbor) so edges stay straighter;
 * within a layer, preferred Y from predecessors is packed without overlap,
 * then the column is vertically centered for even curves.
 * Pure function — caller writes positions via setNodes and undo history.
 */
export function layoutCanvasNodes(
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    options: CanvasAutoLayoutOptions = {},
): Map<string, Position> {
    const columnGap = options.columnGap ?? 180;
    const rowGap = options.rowGap ?? 56;
    const orderPasses = Math.max(1, options.orderPasses ?? 2);
    const selected = options.selectedIds ? new Set(options.selectedIds) : null;
    const scopeAll = !selected || selected.size === 0;

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const scopedIds = new Set<string>();
    for (const node of nodes) {
        if (scopeAll || selected!.has(node.id)) scopedIds.add(node.id);
    }
    if (!scopedIds.size) return new Map();

    // Expand selection: group children + batch children of selected roots.
    for (const id of Array.from(scopedIds)) {
        const node = nodeById.get(id);
        if (!node) continue;
        if (node.type === CanvasNodeType.Group) {
            for (const child of nodes) {
                if (child.metadata?.groupId === id) scopedIds.add(child.id);
            }
        }
        node.metadata?.batchChildIds?.forEach((childId) => scopedIds.add(childId));
    }

    // Units: group super-nodes, batch roots (with children as followers), standalone nodes.
    // Followers are never placed as independent layout units.
    const followerOf = new Map<string, string>();
    const unitIds: string[] = [];

    const isFollower = (node: CanvasNodeData) => {
        if (node.metadata?.batchRootId && nodeById.has(node.metadata.batchRootId) && scopedIds.has(node.metadata.batchRootId)) {
            return true;
        }
        if (node.metadata?.groupId && nodeById.has(node.metadata.groupId) && scopedIds.has(node.metadata.groupId) && node.type !== CanvasNodeType.Group) {
            return true;
        }
        return false;
    };

    for (const id of scopedIds) {
        const node = nodeById.get(id);
        if (!node) continue;
        if (isFollower(node)) {
            if (node.metadata?.batchRootId && scopedIds.has(node.metadata.batchRootId)) {
                followerOf.set(id, node.metadata.batchRootId);
            } else if (node.metadata?.groupId && scopedIds.has(node.metadata.groupId)) {
                followerOf.set(id, node.metadata.groupId);
            }
            continue;
        }
        unitIds.push(id);
    }

    if (!unitIds.length) return new Map();

    const unitSet = new Set(unitIds);
    const resolveUnit = (id: string): string | null => {
        if (unitSet.has(id)) return id;
        const follow = followerOf.get(id);
        if (follow && unitSet.has(follow)) return follow;
        return null;
    };

    // Unit bounding boxes (include followers for size).
    const unitSize = new Map<string, { width: number; height: number }>();
    for (const unitId of unitIds) {
        const members = [unitId, ...Array.from(followerOf.entries()).filter(([, root]) => root === unitId).map(([id]) => id)];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const memberId of members) {
            const n = nodeById.get(memberId);
            if (!n) continue;
            minX = Math.min(minX, n.position.x);
            minY = Math.min(minY, n.position.y);
            maxX = Math.max(maxX, n.position.x + n.width);
            maxY = Math.max(maxY, n.position.y + n.height);
        }
        if (!Number.isFinite(minX)) {
            const n = nodeById.get(unitId)!;
            unitSize.set(unitId, { width: n.width, height: n.height });
        } else {
            unitSize.set(unitId, { width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) });
        }
    }

    // Unit DAG from connections (ignore self/back edges for layering).
    const outgoing = new Map<string, Set<string>>();
    const incoming = new Map<string, Set<string>>();
    const indegree = new Map<string, number>();
    for (const unitId of unitIds) {
        outgoing.set(unitId, new Set());
        incoming.set(unitId, new Set());
        indegree.set(unitId, 0);
    }
    for (const conn of connections) {
        const from = resolveUnit(conn.fromNodeId);
        const to = resolveUnit(conn.toNodeId);
        if (!from || !to || from === to) continue;
        const edges = outgoing.get(from)!;
        if (edges.has(to)) continue;
        edges.add(to);
        incoming.get(to)!.add(from);
        indegree.set(to, (indegree.get(to) || 0) + 1);
    }

    // Kahn layers; leftover cycles get appended as isolated.
    const layers: string[][] = [];
    const remaining = new Set(unitIds);
    let frontier = unitIds.filter((id) => (indegree.get(id) || 0) === 0);
    const yOf = (id: string) => nodeById.get(id)?.position.y ?? 0;
    frontier.sort((a, b) => yOf(a) - yOf(b) || a.localeCompare(b));

    while (frontier.length) {
        layers.push(frontier);
        const next: string[] = [];
        for (const id of frontier) {
            remaining.delete(id);
            for (const to of outgoing.get(id) || []) {
                if (!remaining.has(to)) continue;
                const deg = (indegree.get(to) || 0) - 1;
                indegree.set(to, deg);
                if (deg === 0) next.push(to);
            }
        }
        next.sort((a, b) => yOf(a) - yOf(b) || a.localeCompare(b));
        frontier = next;
    }
    if (remaining.size) {
        const leftover = Array.from(remaining).sort((a, b) => yOf(a) - yOf(b) || a.localeCompare(b));
        layers.push(leftover);
    }

    // Barycenter ordering: keep edges short / less crossed.
    const layerIndex = new Map<string, number>();
    layers.forEach((layer, index) => layer.forEach((id) => layerIndex.set(id, index)));
    const orderRank = new Map<string, number>();
    layers.forEach((layer) => layer.forEach((id, index) => orderRank.set(id, index)));

    const medianNeighborRank = (id: string, neighbors: Iterable<string>) => {
        const ranks: number[] = [];
        for (const n of neighbors) {
            if (!orderRank.has(n)) continue;
            ranks.push(orderRank.get(n)!);
        }
        if (!ranks.length) return orderRank.get(id) ?? 0;
        ranks.sort((a, b) => a - b);
        const mid = Math.floor(ranks.length / 2);
        if (ranks.length % 2 === 1) return ranks[mid];
        return (ranks[mid - 1] + ranks[mid]) / 2;
    };

    for (let pass = 0; pass < orderPasses; pass++) {
        // L → R: order by predecessors.
        for (let li = 1; li < layers.length; li++) {
            layers[li].sort((a, b) => {
                const ba = medianNeighborRank(a, incoming.get(a) || []);
                const bb = medianNeighborRank(b, incoming.get(b) || []);
                return ba - bb || yOf(a) - yOf(b) || a.localeCompare(b);
            });
            layers[li].forEach((id, index) => orderRank.set(id, index));
        }
        // R → L: order by successors.
        for (let li = layers.length - 2; li >= 0; li--) {
            layers[li].sort((a, b) => {
                const ba = medianNeighborRank(a, outgoing.get(a) || []);
                const bb = medianNeighborRank(b, outgoing.get(b) || []);
                return ba - bb || yOf(a) - yOf(b) || a.localeCompare(b);
            });
            layers[li].forEach((id, index) => orderRank.set(id, index));
        }
    }

    // Place columns LTR with preferred Y from previous-layer neighbors, then pack + center.
    const unitOrigin = new Map<string, Position>();
    let originX = options.origin?.x;
    let originY = options.origin?.y;
    if (originX == null || originY == null) {
        let minX = Infinity;
        let minY = Infinity;
        for (const unitId of unitIds) {
            const n = nodeById.get(unitId)!;
            minX = Math.min(minX, n.position.x);
            minY = Math.min(minY, n.position.y);
        }
        originX = Number.isFinite(minX) ? minX : 0;
        originY = Number.isFinite(minY) ? minY : 0;
    }

    // Global vertical center: median of original unit centers (stable anchor).
    const originalCenters = unitIds
        .map((id) => {
            const n = nodeById.get(id)!;
            const size = unitSize.get(id)!;
            return n.position.y + size.height / 2;
        })
        .sort((a, b) => a - b);
    const globalCenterY =
        originalCenters.length % 2 === 1
            ? originalCenters[Math.floor(originalCenters.length / 2)]
            : originalCenters.length
              ? (originalCenters[originalCenters.length / 2 - 1] + originalCenters[originalCenters.length / 2]) / 2
              : originY;

    let cursorX = originX;
    for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];
        let layerWidth = 0;

        type Slot = { id: string; height: number; preferredY: number };
        const slots: Slot[] = layer.map((unitId) => {
            const size = unitSize.get(unitId) || { width: 200, height: 160 };
            layerWidth = Math.max(layerWidth, size.width);

            // Prefer vertical center aligned with connected units already placed.
            const neighborCenters: number[] = [];
            for (const pred of incoming.get(unitId) || []) {
                const pos = unitOrigin.get(pred);
                const pSize = unitSize.get(pred);
                if (!pos || !pSize) continue;
                neighborCenters.push(pos.y + pSize.height / 2);
            }
            // First layer / no preds: keep relative original order via current y.
            let preferredCenter: number;
            if (neighborCenters.length) {
                neighborCenters.sort((a, b) => a - b);
                const mid = Math.floor(neighborCenters.length / 2);
                preferredCenter =
                    neighborCenters.length % 2 === 1
                        ? neighborCenters[mid]
                        : (neighborCenters[mid - 1] + neighborCenters[mid]) / 2;
            } else {
                const n = nodeById.get(unitId)!;
                preferredCenter = n.position.y + size.height / 2;
            }
            return { id: unitId, height: size.height, preferredY: preferredCenter - size.height / 2 };
        });

        // Pack top→bottom by preferredY without overlap.
        slots.sort((a, b) => a.preferredY - b.preferredY || a.id.localeCompare(b.id));
        const packedY: number[] = [];
        let cursorY = slots[0]?.preferredY ?? originY;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            const y = i === 0 ? slot.preferredY : Math.max(slot.preferredY, cursorY);
            packedY.push(y);
            cursorY = y + slot.height + rowGap;
        }

        // Center the packed column around globalCenterY (or originY if single unit).
        const firstTop = packedY[0] ?? originY;
        const last = slots[slots.length - 1];
        const lastBottom = last ? packedY[packedY.length - 1] + last.height : firstTop;
        const blockCenter = (firstTop + lastBottom) / 2;
        const shift = globalCenterY - blockCenter;

        for (let i = 0; i < slots.length; i++) {
            unitOrigin.set(slots[i].id, {
                x: Math.round(cursorX),
                y: Math.round(packedY[i] + shift),
            });
        }

        cursorX += layerWidth + columnGap;
    }

    // Apply unit origins; followers keep relative offset to unit root's original position.
    const result = new Map<string, Position>();
    for (const unitId of unitIds) {
        const node = nodeById.get(unitId)!;
        const next = unitOrigin.get(unitId)!;
        const dx = next.x - node.position.x;
        const dy = next.y - node.position.y;
        result.set(unitId, { x: next.x, y: next.y });
        for (const [followerId, rootId] of followerOf) {
            if (rootId !== unitId) continue;
            const follower = nodeById.get(followerId);
            if (!follower) continue;
            result.set(followerId, {
                x: Math.round(follower.position.x + dx),
                y: Math.round(follower.position.y + dy),
            });
        }
    }

    return result;
}

export function applyLayoutPositions(nodes: CanvasNodeData[], positions: Map<string, Position>): CanvasNodeData[] {
    if (!positions.size) return nodes;
    return nodes.map((node) => {
        const next = positions.get(node.id);
        if (!next) return node;
        if (next.x === node.position.x && next.y === node.position.y) return node;
        return { ...node, position: next };
    });
}
