import { useEffect } from "react";
import type { ReactNode } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ContextMenuState } from "@/types/canvas";

export function CanvasNodeContextMenu({
    menu,
    onClose,
    onDuplicate,
    onDelete,
    onCopy,
    selectedCount = 1,
}: {
    menu: ContextMenuState;
    onClose: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onCopy?: () => void;
    /** When right-click target is part of multi-selection, delete/copy applies to all. */
    selectedCount?: number;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const multi = menu.type === "node" && selectedCount > 1;

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            className="fixed z-[80] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {menu.type === "node" && multi ? (
                <div className="px-3 py-1.5 text-[11px] opacity-55">已选 {selectedCount} 个节点</div>
            ) : null}
            {menu.type === "node" && !multi ? <MenuButton icon={<Plus className="size-4" />} label="复制节点" onClick={onDuplicate} /> : null}
            {menu.type === "node" && multi && onCopy ? <MenuButton icon={<Copy className="size-4" />} label={`复制 ${selectedCount} 个`} onClick={onCopy} /> : null}
            <MenuButton
                icon={<Trash2 className="size-4" />}
                label={menu.type === "connection" ? "删除连线" : multi ? `删除 ${selectedCount} 个节点` : "删除节点"}
                onClick={onDelete}
                danger
            />
        </div>
    );
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: danger ? "#f87171" : theme.node.text }} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}
