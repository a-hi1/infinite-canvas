import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
import { ChevronLeft, ChevronRight, FileText, ImageIcon, List, Music2, Search, Settings2, Shapes, Video, X } from "lucide-react";

import { filterCanvasNavigationNodes, type CanvasNodeListType } from "@/lib/canvas/canvas-node-list";
import { displayNodeTitle } from "@/lib/canvas/node-title";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeStatus } from "@/types/canvas";

const PANEL_ID = "canvas-node-list-panel";

const TYPE_OPTIONS: Array<{ value: CanvasNodeListType; label: string }> = [
    { value: "all", label: "全部" },
    { value: CanvasNodeType.Image, label: "图片" },
    { value: CanvasNodeType.Video, label: "视频" },
    { value: CanvasNodeType.Text, label: "文本" },
    { value: CanvasNodeType.Audio, label: "音频" },
    { value: CanvasNodeType.Config, label: "配置" },
    { value: CanvasNodeType.Group, label: "组" },
];

const TYPE_LABELS: Record<CanvasNodeType, string> = {
    [CanvasNodeType.Image]: "图片",
    [CanvasNodeType.Video]: "视频",
    [CanvasNodeType.Text]: "文本",
    [CanvasNodeType.Audio]: "音频",
    [CanvasNodeType.Config]: "配置",
    [CanvasNodeType.Group]: "组",
};

const STATUS_LABELS: Record<CanvasNodeStatus, string> = {
    idle: "待处理",
    loading: "生成中",
    success: "已完成",
    error: "失败",
};

const STATUS_COLORS: Record<CanvasNodeStatus, string> = {
    idle: "#a8a29e",
    loading: "#3b82f6",
    success: "#22a06b",
    error: "#ef4444",
};

export function CanvasNodeListPanel({
    nodes,
    selectedNodeIds,
    onFocusNode,
}: {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    onFocusNode: (node: CanvasNodeData, panelRight?: number) => void;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [type, setType] = useState<CanvasNodeListType>("all");
    const panelRef = useRef<HTMLDivElement>(null);
    const launcherRef = useRef<HTMLButtonElement>(null);
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const filteredNodes = useMemo(() => filterCanvasNavigationNodes(nodes, query, type), [nodes, query, type]);
    const panelStyle = {
        background: theme.toolbar.panel,
        borderColor: theme.toolbar.border,
        color: theme.node.text,
        boxShadow: colorTheme === "dark" ? "0 24px 60px rgba(0,0,0,.38)" : "0 22px 55px rgba(28,25,23,.14)",
        "--node-panel-hover": theme.toolbar.itemHover,
        "--node-panel-active": theme.toolbar.activeBg,
        "--node-panel-border": theme.toolbar.border,
        "--node-panel-focus": theme.node.activeStroke,
    } as CSSProperties;

    const stopPointer = (event: PointerEvent<HTMLDivElement>) => event.stopPropagation();
    const stopMouse = (event: MouseEvent<HTMLDivElement>) => event.stopPropagation();
    const stopWheel = (event: WheelEvent<HTMLDivElement>) => event.stopPropagation();
    const closePanel = (restoreFocus = false) => {
        setOpen(false);
        if (restoreFocus) requestAnimationFrame(() => launcherRef.current?.focus());
    };
    const focusNode = (node: CanvasNodeData) => {
        onFocusNode(node, panelRef.current?.getBoundingClientRect().right);
    };
    const handlePanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        closePanel(true);
    };

    return (
        <div
            data-canvas-no-zoom
            className="pointer-events-auto absolute left-4 top-20 z-[80] max-h-[calc(100%-10.5rem)]"
            onPointerDown={stopPointer}
            onMouseDown={stopMouse}
            onDoubleClick={(event) => event.stopPropagation()}
            onWheel={stopWheel}
        >
            {open ? (
                <div
                    ref={panelRef}
                    id={PANEL_ID}
                    role="region"
                    aria-label="画布节点导航"
                    className="flex max-h-[calc(100vh-10.5rem)] w-[min(320px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border shadow-xl backdrop-blur-xl"
                    style={panelStyle}
                    onKeyDown={handlePanelKeyDown}
                >
                    <div className="flex min-h-15 items-center gap-3 border-b px-4 py-3" style={{ borderColor: theme.toolbar.border }}>
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl" style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}>
                            <List size={18} aria-hidden />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold tracking-tight">画布节点</div>
                            <div className="mt-0.5 text-[11px] tabular-nums" style={{ color: theme.node.faint }} aria-live="polite">
                                {filteredNodes.length === nodes.length ? `${nodes.length} 个节点` : `${filteredNodes.length} / ${nodes.length} 个节点`}
                            </div>
                        </div>
                        <button
                            type="button"
                            aria-label="收起节点列表"
                            className="flex size-8 items-center justify-center rounded-lg transition hover:bg-[var(--node-panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--node-panel-focus)]"
                            style={{ color: theme.toolbar.item }}
                            onClick={() => closePanel(true)}
                        >
                            <ChevronLeft size={18} aria-hidden />
                        </button>
                    </div>

                    <div className="space-y-2.5 border-b px-3 py-3" style={{ borderColor: theme.toolbar.border }}>
                        <label
                            className="flex h-9 items-center gap-2 rounded-xl border px-3 transition focus-within:ring-2 focus-within:ring-[var(--node-panel-focus)]"
                            style={{ borderColor: theme.toolbar.border, background: theme.node.panel }}
                        >
                            <span className="sr-only">搜索画布节点</span>
                            <Search size={15} className="shrink-0" style={{ color: theme.node.faint }} aria-hidden />
                            <input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="搜索名称、提示词或文本"
                                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:opacity-60"
                                style={{ color: theme.node.text }}
                            />
                            {query ? (
                                <button type="button" aria-label="清空搜索" className="-mr-1 flex size-6 items-center justify-center rounded-md hover:bg-[var(--node-panel-hover)]" onClick={() => setQuery("")}>
                                    <X size={14} aria-hidden />
                                </button>
                            ) : null}
                        </label>
                        <div className="thin-scrollbar flex gap-1 overflow-x-auto pb-0.5" role="group" aria-label="按节点类型筛选">
                            {TYPE_OPTIONS.map((option) => {
                                const active = type === option.value;
                                return (
                                    <button
                                        key={option.value}
                                        type="button"
                                        aria-pressed={active}
                                        className="shrink-0 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition hover:bg-[var(--node-panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--node-panel-focus)]"
                                        style={{
                                            borderColor: active ? theme.node.activeStroke : "transparent",
                                            background: active ? theme.toolbar.activeBg : "transparent",
                                            color: active ? theme.toolbar.activeText : theme.node.muted,
                                        }}
                                        onClick={() => setType(option.value)}
                                    >
                                        {option.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="thin-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto p-2.5">
                        {filteredNodes.map((node) => (
                            <NodeRow key={node.id} node={node} selected={selectedNodeIds.has(node.id)} theme={theme} onClick={() => focusNode(node)} />
                        ))}
                        {!filteredNodes.length ? (
                            <div className="flex flex-col items-center px-5 py-12 text-center">
                                <div className="mb-3 flex size-10 items-center justify-center rounded-xl" style={{ background: theme.toolbar.activeBg, color: theme.node.faint }}>
                                    {nodes.length ? <Search size={18} aria-hidden /> : <List size={18} aria-hidden />}
                                </div>
                                <div className="text-xs font-medium">{nodes.length ? "没有匹配的节点" : "画布还没有节点"}</div>
                                <div className="mt-1 text-[11px]" style={{ color: theme.node.faint }}>{nodes.length ? "换个关键词或节点类型试试" : "添加节点后会显示在这里"}</div>
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : (
                <button
                    ref={launcherRef}
                    type="button"
                    aria-label="打开画布节点列表"
                    aria-expanded={false}
                    aria-controls={PANEL_ID}
                    className="flex h-10 items-center gap-2 rounded-xl border px-3 text-xs font-semibold shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:bg-[var(--node-panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--node-panel-focus)]"
                    style={panelStyle}
                    onClick={() => setOpen(true)}
                >
                    <List size={16} aria-hidden />
                    <span>节点</span>
                    <span className="rounded-md px-1.5 py-0.5 text-[10px] tabular-nums" style={{ background: theme.toolbar.activeBg }}>{nodes.length}</span>
                    <ChevronRight size={14} aria-hidden />
                </button>
            )}
        </div>
    );
}

function NodeRow({ node, selected, theme, onClick }: { node: CanvasNodeData; selected: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onClick: () => void }) {
    const prompt = node.metadata?.prompt ?? node.metadata?.composerContent ?? "";
    const textContent = node.type === CanvasNodeType.Text ? node.metadata?.content ?? "" : "";
    const summary = (prompt || textContent).replace(/\s+/g, " ").trim();
    const status = node.metadata?.status ?? "idle";
    const thumbnail = node.type === CanvasNodeType.Image && node.metadata?.content ? node.metadata.content : null;
    const title = displayNodeTitle(node.title, node.type, node.metadata?.prompt);

    return (
        <button
            type="button"
            aria-current={selected ? "true" : undefined}
            aria-label={`${title}，${TYPE_LABELS[node.type]}，${STATUS_LABELS[status]}`}
            onClick={onClick}
            className="group relative flex min-h-15 w-full items-center gap-3 overflow-hidden rounded-xl border px-2.5 py-2 text-left transition hover:bg-[var(--node-panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--node-panel-focus)]"
            style={{
                borderColor: selected ? theme.node.activeStroke : "transparent",
                background: selected ? theme.toolbar.activeBg : "transparent",
            }}
        >
            {selected ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-full" style={{ background: theme.node.activeStroke }} /> : null}
            <div className="relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>
                <NodeTypeIcon type={node.type} />
                {thumbnail ? <img src={thumbnail} alt="" className="absolute inset-0 size-full object-cover" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
            </div>
            <div className="min-w-0 flex-1 py-0.5">
                <div title={title} className="line-clamp-2 text-[13px] font-semibold leading-[18px]" style={{ color: theme.node.text }}>{title}</div>
                <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px]">
                    <span className="rounded-md px-1.5 py-0.5 font-medium" style={{ background: theme.node.fill, color: theme.node.muted }}>{TYPE_LABELS[node.type]}</span>
                    <span className="inline-flex items-center gap-1 whitespace-nowrap" style={{ color: status === "error" ? STATUS_COLORS.error : theme.node.muted }}>
                        <span className={`size-1.5 rounded-full ${status === "loading" ? "animate-pulse" : ""}`} style={{ background: STATUS_COLORS[status] }} />
                        {STATUS_LABELS[status]}
                    </span>
                </div>
                {summary ? <div title={summary} className="mt-1 truncate text-[10px] leading-4" style={{ color: theme.node.faint }}>{summary}</div> : null}
            </div>
        </button>
    );
}

function NodeTypeIcon({ type }: { type: CanvasNodeType }) {
    if (type === CanvasNodeType.Image) return <ImageIcon size={19} aria-hidden />;
    if (type === CanvasNodeType.Video) return <Video size={19} aria-hidden />;
    if (type === CanvasNodeType.Audio) return <Music2 size={19} aria-hidden />;
    if (type === CanvasNodeType.Text) return <FileText size={19} aria-hidden />;
    if (type === CanvasNodeType.Config) return <Settings2 size={19} aria-hidden />;
    return <Shapes size={19} aria-hidden />;
}
