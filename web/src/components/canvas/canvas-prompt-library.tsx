import { useState } from "react";
import { Button, Tooltip } from "antd";
import { BookOpen } from "lucide-react";

import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasPromptLibrary({
    onSelect,
    optimizeMode = "image",
    /** 默认图标按钮，与上游画布底栏一致；需要文案时可开 labeled */
    labeled = false,
}: {
    onSelect: (prompt: string) => void;
    optimizeMode?: "image" | "video" | "text" | "audio";
    labeled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            <Tooltip title="从提示词库选择模板">
                <Button
                    type={labeled ? "default" : "text"}
                    size="small"
                    className={labeled ? "!h-8 !rounded-full !px-2.5" : "!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0"}
                    style={labeled ? { color: theme.node.text, borderColor: theme.node.stroke, background: "transparent" } : { color: theme.node.text }}
                    icon={<BookOpen className="size-3.5" />}
                    onClick={() => setOpen(true)}
                    aria-label="提示词库"
                >
                    {labeled ? "提示词库" : null}
                </Button>
            </Tooltip>
            <PromptSelectDialog open={open} onOpenChange={setOpen} onSelect={onSelect} optimizeMode={optimizeMode} />
        </>
    );
}
