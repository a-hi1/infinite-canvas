import { useState } from "react";
import { Button, Tooltip } from "antd";
import { BookOpen } from "lucide-react";

import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasPromptLibrary({
    onSelect,
    optimizeMode = "image",
}: {
    onSelect: (prompt: string) => void;
    optimizeMode?: "image" | "video" | "text" | "audio";
}) {
    const [open, setOpen] = useState(false);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            <Tooltip title="从提示词库选择模板">
                <Button
                    type="default"
                    size="small"
                    className="!h-8 !rounded-full !px-2.5"
                    style={{ color: theme.node.text, borderColor: theme.node.stroke, background: "transparent" }}
                    icon={<BookOpen className="size-3.5" />}
                    onClick={() => setOpen(true)}
                    aria-label="提示词库"
                >
                    提示词库
                </Button>
            </Tooltip>
            <PromptSelectDialog open={open} onOpenChange={setOpen} onSelect={onSelect} optimizeMode={optimizeMode} />
        </>
    );
}
