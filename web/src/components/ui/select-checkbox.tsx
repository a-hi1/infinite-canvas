import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Check, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

export type SelectCheckboxVariant = "overlay" | "inline" | "toolbar";

export type SelectCheckboxProps = {
    checked: boolean;
    indeterminate?: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
    /** Stop parent card/row click handlers */
    stopPropagation?: boolean;
    variant?: SelectCheckboxVariant;
    label?: ReactNode;
    className?: string;
    boxClassName?: string;
    "aria-label"?: string;
};

function resolveNextChecked(checked: boolean, indeterminate?: boolean) {
    if (indeterminate) return true;
    return !checked;
}

/**
 * Shared selection control for media cards, history rows, and batch toolbars.
 * Replaces bare Ant Design checkboxes on photo covers (white blob look).
 */
export function SelectCheckbox({
    checked,
    indeterminate = false,
    disabled = false,
    onChange,
    stopPropagation = true,
    variant = "inline",
    label,
    className,
    boxClassName,
    "aria-label": ariaLabel,
}: SelectCheckboxProps) {
    const isOn = checked && !indeterminate;
    const mixed = Boolean(indeterminate) && !checked;

    const handleActivate = (event: MouseEvent | KeyboardEvent) => {
        if (disabled) return;
        if (stopPropagation) {
            event.stopPropagation();
        }
        event.preventDefault();
        onChange(resolveNextChecked(checked, indeterminate));
    };

    const box = (
        <span
            aria-hidden
            className={cn(
                "inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition",
                variant === "overlay" &&
                    cn(
                        "size-5 rounded-md shadow-sm backdrop-blur-[2px]",
                        isOn || mixed
                            ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
                            : "border-white/85 bg-black/35 text-transparent hover:border-white hover:bg-black/50",
                    ),
                variant === "inline" &&
                    cn(
                        isOn || mixed
                            ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
                            : "border-stone-300 bg-white text-transparent hover:border-stone-400 dark:border-stone-600 dark:bg-stone-950 dark:hover:border-stone-400",
                    ),
                variant === "toolbar" &&
                    cn(
                        isOn || mixed
                            ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
                            : "border-stone-300 bg-background text-transparent hover:border-stone-400 dark:border-stone-600",
                    ),
                boxClassName,
            )}
        >
            {mixed ? <Minus className="size-3 stroke-[3]" /> : <Check className={cn("size-3 stroke-[3]", !isOn && "opacity-0")} />}
        </span>
    );

    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={mixed ? "mixed" : isOn}
            aria-label={ariaLabel || (typeof label === "string" ? label : "选择")}
            disabled={disabled}
            className={cn(
                "inline-flex max-w-full items-center gap-2 border-0 bg-transparent p-0 align-middle outline-none",
                "focus-visible:ring-2 focus-visible:ring-stone-400/70 focus-visible:ring-offset-1 dark:focus-visible:ring-stone-500/70",
                disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer",
                label ? "text-sm text-stone-700 dark:text-stone-200" : null,
                className,
            )}
            onClick={handleActivate}
            onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") {
                    handleActivate(event);
                }
            }}
        >
            {box}
            {label ? <span className="min-w-0 select-none leading-none">{label}</span> : null}
        </button>
    );
}

export type SelectionToolbarProps = {
    children: ReactNode;
    className?: string;
    /** Soft highlight when something is selected */
    active?: boolean;
};

/** Outer shell for batch select bars — keeps pages visually consistent. */
export function SelectionToolbar({ children, className, active = false }: SelectionToolbarProps) {
    return (
        <div
            className={cn(
                "flex flex-col gap-2.5 rounded-xl border p-3 shadow-sm transition sm:flex-row sm:items-center sm:justify-between",
                active
                    ? "border-stone-300 bg-stone-50/90 dark:border-stone-600 dark:bg-stone-900/70"
                    : "border-stone-200 bg-card/80 dark:border-stone-800",
                className,
            )}
        >
            {children}
        </div>
    );
}

export function SelectionCount({ count, idleHint, activeHint }: { count: number; idleHint: string; activeHint?: string }) {
    if (count > 0) {
        return (
            <span className="inline-flex items-center gap-1.5 text-xs text-stone-600 dark:text-stone-300">
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-stone-900 px-1.5 text-[11px] font-medium tabular-nums text-white dark:bg-stone-100 dark:text-stone-900">
                    {count}
                </span>
                <span>{activeHint || "已选 · 单卡操作仍可用"}</span>
            </span>
        );
    }
    return <span className="text-xs text-stone-500 dark:text-stone-400">{idleHint}</span>;
}
