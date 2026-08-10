import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

export type CreateGroupFromSelectionOptions = {
    /** Extra padding around the union bounds of members. Default 48. */
    padding?: number;
    /** Extra top inset for the group chrome / title strip. Default 36. */
    topChrome?: number;
    /** Optional group id factory (tests). */
    createId?: () => string;
    /** Optional title. Default "组". */
    title?: string;
};

export type CreateGroupFromSelectionResult = {
    nodes: CanvasNodeData[];
    groupId: string;
    memberIds: string[];
};

/**
 * Eligible members: selected non-group nodes, plus batch children of selected batch roots.
 * Existing group containers in the selection are ignored (not nested).
 */
export function collectGroupableMemberIds(nodes: CanvasNodeData[], selectedIds: Iterable<string>): string[] {
    const selected = new Set(selectedIds);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const members = new Set<string>();

    for (const id of selected) {
        const node = nodeById.get(id);
        if (!node) continue;
        if (node.type === CanvasNodeType.Group) continue;
        members.add(id);
        node.metadata?.batchChildIds?.forEach((childId) => {
            if (nodeById.has(childId)) members.add(childId);
        });
    }

    // If a batch child is selected without its root, still include it.
    return Array.from(members);
}

/**
 * Create a group frame around currently selected nodes and assign metadata.groupId.
 * Does not move members relative to each other — only sizes the frame to fit them.
 * Returns null when fewer than 2 groupable members.
 */
export function createGroupFromSelection(
    nodes: CanvasNodeData[],
    selectedIds: Iterable<string>,
    options: CreateGroupFromSelectionOptions = {},
): CreateGroupFromSelectionResult | null {
    const padding = options.padding ?? 48;
    const topChrome = options.topChrome ?? 36;
    const memberIds = collectGroupableMemberIds(nodes, selectedIds);
    if (memberIds.length < 2) return null;

    const memberSet = new Set(memberIds);
    const members = nodes.filter((node) => memberSet.has(node.id));
    if (members.length < 2) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of members) {
        minX = Math.min(minX, node.position.x);
        minY = Math.min(minY, node.position.y);
        maxX = Math.max(maxX, node.position.x + node.width);
        maxY = Math.max(maxY, node.position.y + node.height);
    }

    const groupId =
        options.createId?.() ||
        `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const position: Position = {
        x: Math.round(minX - padding),
        y: Math.round(minY - padding - topChrome),
    };
    const width = Math.max(200, Math.round(maxX - minX + padding * 2));
    const height = Math.max(160, Math.round(maxY - minY + padding * 2 + topChrome));

    const groupNode: CanvasNodeData = {
        id: groupId,
        type: CanvasNodeType.Group,
        title: options.title || "组",
        position,
        width,
        height,
        metadata: { status: "idle" },
    };

    const nextNodes = nodes.map((node) => {
        if (!memberSet.has(node.id)) return node;
        if (node.metadata?.groupId === groupId) return node;
        return {
            ...node,
            metadata: {
                ...node.metadata,
                groupId,
            },
        };
    });

    // Insert group before its members so it paints under them (z-order uses type, but list order helps).
    const firstMemberIndex = nextNodes.findIndex((node) => memberSet.has(node.id));
    const insertAt = firstMemberIndex >= 0 ? firstMemberIndex : nextNodes.length;
    const withGroup = [...nextNodes.slice(0, insertAt), groupNode, ...nextNodes.slice(insertAt)];

    return { nodes: withGroup, groupId, memberIds };
}

/**
 * Detach members from the given group ids and remove empty group frames.
 * Members keep their positions.
 */
export function ungroupSelection(nodes: CanvasNodeData[], targetGroupIds: Iterable<string>): CanvasNodeData[] {
    const groups = new Set(targetGroupIds);
    if (!groups.size) return nodes;

    const cleared = nodes.map((node) => {
        const groupId = node.metadata?.groupId;
        if (!groupId || !groups.has(groupId)) return node;
        return {
            ...node,
            metadata: {
                ...node.metadata,
                groupId: undefined,
            },
        };
    });

    return cleared.filter((node) => !(node.type === CanvasNodeType.Group && groups.has(node.id)));
}

/**
 * Resolve which group ids to ungroup from a selection:
 * - selected group containers themselves
 * - if all selected non-group nodes share one groupId, that group
 */
export function resolveUngroupTargetIds(nodes: CanvasNodeData[], selectedIds: Iterable<string>): string[] {
    const selected = new Set(selectedIds);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const targets = new Set<string>();

    for (const id of selected) {
        const node = nodeById.get(id);
        if (!node) continue;
        if (node.type === CanvasNodeType.Group) targets.add(node.id);
    }

    const memberGroupIds = new Set<string>();
    for (const id of selected) {
        const node = nodeById.get(id);
        if (!node || node.type === CanvasNodeType.Group) continue;
        if (node.metadata?.groupId) memberGroupIds.add(node.metadata.groupId);
    }
    if (memberGroupIds.size === 1 && !targets.size) {
        targets.add(Array.from(memberGroupIds)[0]);
    }

    return Array.from(targets);
}
