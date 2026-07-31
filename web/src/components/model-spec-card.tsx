import type { ReactNode } from "react";

import type { CanvasTheme } from "@/lib/canvas-theme";
import type { ModelSpecCardData } from "@/lib/model-capability";

type ModelSpecCardProps = {
    data: ModelSpecCardData;
    theme: CanvasTheme;
    className?: string;
};

/** 截图风格：模型能力说明卡（工作模式 / 输入 / 输出 / 返回 / 不支持） */
export function ModelSpecCard({ data, theme, className = "" }: ModelSpecCardProps) {
    return (
        <div
            className={`rounded-2xl border p-3.5 ${className}`}
            style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0 truncate text-sm font-semibold">{data.title}</div>
                <span className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] leading-none opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                    模型说明
                </span>
            </div>
            <div className="space-y-2">
                {data.fields.map((field) => (
                    <SpecRow key={field.label} label={field.label} theme={theme}>
                        {field.value}
                    </SpecRow>
                ))}
            </div>
            {data.note ? (
                <div className="mt-2.5 text-[11px] leading-4 opacity-60" style={{ color: theme.node.muted }}>
                    {data.note}
                </div>
            ) : null}
        </div>
    );
}

function SpecRow({ label, theme, children }: { label: string; theme: CanvasTheme; children: ReactNode }) {
    return (
        <div className="grid grid-cols-[4.5rem_1fr] gap-2 text-xs leading-5 sm:grid-cols-[5rem_1fr]">
            <div className="shrink-0 font-medium opacity-70" style={{ color: theme.node.muted }}>
                {label}
            </div>
            <div className="min-w-0 break-words opacity-90">{children}</div>
        </div>
    );
}
