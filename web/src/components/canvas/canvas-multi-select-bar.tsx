import { Copy, Trash2, X } from "lucide-react";
import { Button } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

/** Floating actions when 2+ canvas nodes are selected. */
export function CanvasMultiSelectBar({
    count,
    onDelete,
    onDeselect,
    onCopy,
}: {
    count: number;
    onDelete: () => void;
    onDeselect: () => void;
    onCopy: () => void;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    if (count < 2) return null;

    return (
        <div className="pointer-events-none absolute bottom-[5.5rem] left-0 right-0 z-50 flex justify-center px-4" style={{ left: 280 }}>
            <div
                className="pointer-events-auto flex max-w-full items-center gap-2 rounded-xl border px-3 py-2 shadow-lg backdrop-blur"
                style={{
                    background: theme.toolbar.panel,
                    borderColor: theme.toolbar.border,
                    color: theme.node.text,
                    boxShadow: colorTheme === "dark" ? "0 18px 45px rgba(0,0,0,.32)" : "0 16px 40px rgba(28,25,23,.12)",
                }}
            >
                <span className="shrink-0 text-xs font-medium opacity-80">已选 {count} 个节点</span>
                <div className="mx-0.5 h-5 w-px shrink-0" style={{ background: theme.toolbar.border }} />
                <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={onCopy} className="!px-2">
                    复制
                </Button>
                <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete} className="!px-2">
                    删除
                </Button>
                <Button size="small" type="text" icon={<X className="size-3.5" />} onClick={onDeselect} className="!px-2">
                    取消选择
                </Button>
            </div>
        </div>
    );
}
