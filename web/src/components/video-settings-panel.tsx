import { type ReactNode } from "react";
import { Switch } from "antd";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { ModelSpecCard } from "@/components/model-spec-card";
import { AGNES_VIDEO_SIZE } from "@/lib/agnes-video";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { isGrokVideoConfig, normalizeGrokAspectRatio, normalizeGrokDuration, normalizeGrokResolution } from "@/lib/grok-video";
import { isAgnesVideoConfig } from "@/lib/agnes-video";
import {
    isSoraVideoConfig,
    isVeoVideoConfig,
    normalizeSoraSeconds,
    normalizeSoraSize,
    normalizeVeoSeconds,
    normalizeVeoSize,
} from "@/lib/openai-compatible-video";
import { boolConfig, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedancePixelLabel, seedanceRatioOptions } from "@/lib/seedance-video";
import { resolveVideoCapability, type PillOption } from "@/lib/model-capability";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";

type VideoSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: VideoSettingsPanelProps) {
    const cap = resolveVideoCapability(config);
    const size = cap.normalize.size(config.size || "");
    const seconds = cap.normalize.seconds(config.videoSeconds || "");
    const resolution = cap.normalize.resolution(config.vquality || "");
    const generateAudio = boolConfig(config.videoGenerateAudio, true);
    const watermark = boolConfig(config.videoWatermark, false);
    const dimensions = readSizeDimensions(size);

    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
        onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}

                <ModelSpecCard data={cap.card} theme={theme} />

                {cap.resolutions.length ? (
                    <SettingGroup title="清晰度" color={theme.node.muted}>
                        <div className="flex flex-wrap gap-2">
                            {cap.resolutions.map((item) => (
                                <OptionPill
                                    key={item.value}
                                    selected={resolution === item.value || resolution === item.value.replace(/p$/i, "") || `${resolution}p` === item.value}
                                    disabled={item.disabled}
                                    theme={theme}
                                    onClick={() => !item.disabled && onConfigChange("vquality", item.value)}
                                >
                                    {item.label}
                                </OptionPill>
                            ))}
                            {cap.customResolution ? <ResolutionInput value={resolution} theme={theme} onChange={(value) => onConfigChange("vquality", value)} /> : null}
                        </div>
                        {cap.resolutions.some((item) => item.disabled && item.disabledReason) ? (
                            <div className="text-[11px] leading-4 opacity-55">{cap.resolutions.find((item) => item.disabled)?.disabledReason}</div>
                        ) : null}
                        {cap.provider === "grok" ? (
                            <div className="text-[11px] leading-4 opacity-55">规格原样请求；失败才降档。结果偏低会提示，不虚标。</div>
                        ) : null}
                    </SettingGroup>
                ) : null}

                <SettingGroup title={cap.provider === "sora" || cap.provider === "veo" || cap.provider === "agnes" || cap.provider === "generic" ? "尺寸" : "比例"} color={theme.node.muted}>
                    {cap.customSize ? (
                        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                            <DimensionInput prefix="W" value={dimensions.width} disabled={size === "auto"} theme={theme} onChange={(value) => updateDimension("width", value)} />
                            <span className="text-lg opacity-45">↔</span>
                            <DimensionInput prefix="H" value={dimensions.height} disabled={size === "auto"} theme={theme} onChange={(value) => updateDimension("height", value)} />
                        </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                        {cap.ratios.map((item) => {
                            const selected = size === item.value || (cap.provider === "seedance" && normalizeSeedanceRatio(size) === item.value);
                            // Seedance / Sora 等保留比例预览块；其余用 pill
                            if (cap.provider === "seedance" || cap.provider === "sora" || cap.provider === "veo" || cap.provider === "agnes" || cap.provider === "generic") {
                                const preview = ratioPreview(item.value);
                                const pixelHint =
                                    cap.provider === "seedance" && item.value !== "adaptive"
                                        ? seedancePixelLabel(resolution.endsWith("p") ? resolution : `${resolution}p`, item.value)
                                        : item.hint;
                                return (
                                    <button
                                        key={item.value}
                                        type="button"
                                        className="flex min-h-16 min-w-18 flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-2 py-1.5 text-sm transition hover:opacity-80"
                                        style={{ borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onClick={() => onConfigChange("size", item.value)}
                                    >
                                        <SizePreview width={preview.width} height={preview.height} color={theme.node.text} />
                                        <span>{item.label}</span>
                                        {pixelHint ? <span className="text-[10px] leading-none opacity-55">{pixelHint}</span> : null}
                                    </button>
                                );
                            }
                            return (
                                <OptionPill key={item.value} selected={selected} theme={theme} onClick={() => onConfigChange("size", item.value)}>
                                    {item.label}
                                </OptionPill>
                            );
                        })}
                    </div>
                </SettingGroup>

                <SettingGroup title="秒数" color={theme.node.muted}>
                    <div className="flex flex-wrap gap-2">
                        {cap.seconds.map((item) => (
                            <OptionPill key={item.value} selected={seconds === item.value} theme={theme} onClick={() => onConfigChange("videoSeconds", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                        {cap.customSeconds ? (
                            <NumberInput
                                value={seconds}
                                min={cap.customSeconds.min}
                                max={cap.customSeconds.max}
                                theme={theme}
                                onChange={(value) => onConfigChange("videoSeconds", value)}
                            />
                        ) : null}
                    </div>
                    {cap.provider === "grok" ? (
                        <div className="text-[11px] leading-4 opacity-55">官方范围约 1–15 秒；部分中转 5–10 秒更稳，15 秒失败时可降到 10 秒重试</div>
                    ) : null}
                </SettingGroup>

                {cap.audio || cap.watermark ? (
                    <SettingGroup title="输出" color={theme.node.muted}>
                        <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                            {cap.audio ? <SwitchRow label="生成声音" checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} /> : null}
                            {cap.watermark ? <SwitchRow label="添加水印" checked={watermark} theme={theme} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} /> : null}
                        </div>
                    </SettingGroup>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoSettingsSummary(config: Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "baseUrl">) {
    if (isAgnesVideoConfig(config)) return `Agnes · ${AGNES_VIDEO_SIZE} · ${config.videoSeconds === "5" ? 5 : 2}s`;
    if (isGrokVideoConfig(config)) return `Grok · ${normalizeGrokResolution(config.vquality)} · ${normalizeGrokAspectRatio(config.size)} · ${normalizeGrokDuration(config.videoSeconds)}s`;
    if (isSoraVideoConfig(config)) {
        const modelName = modelOptionName(config.model || config.videoModel || "");
        return `Sora · ${normalizeSoraSize(config.size, modelName)} · ${normalizeSoraSeconds(config.videoSeconds)}s`;
    }
    if (isVeoVideoConfig(config)) return `Veo · ${normalizeVeoSize(config.size)} · ${normalizeVeoSeconds(config.videoSeconds)}s`;
    if (isSeedanceVideoConfig(config)) {
        const model = modelOptionName(config.model || config.videoModel || "");
        return `${normalizeSeedanceResolution(config.vquality, model)} · ${normalizeSeedanceRatio(config.size)} · ${videoSecondsLabel(String(normalizeSeedanceDuration(config.videoSeconds)))}`;
    }
    return `${videoResolutionLabel(config.vquality)} · ${videoSizeLabel(config.size)} · ${videoSecondsLabel(config.videoSeconds)}`;
}

export function videoResolutionLabel(value: string) {
    return `${normalizeVideoResolutionValue(value)}p`;
}

export function videoSizeLabel(value: string) {
    const ratio = normalizeSeedanceRatio(value);
    if (value === "adaptive" || value === "auto") return "自适应";
    if (ratio === value) return seedanceRatioOptions.find((item) => item.value === ratio)?.label || ratio;
    const size = normalizeVideoSizeValue(value);
    return size || value;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return "智能";
    return `${value || "6"}s`;
}

export function normalizeVideoSizeValue(value: string) {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

export function normalizeVideoResolutionValue(value: string) {
    if (value === "480p" || value === "low") return "480";
    if (value === "720p" || value === "auto" || value === "high" || value === "medium") return "720";
    return value.replace(/p$/i, "") || "720";
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            disabled={disabled}
            className="h-9 min-w-13 cursor-pointer rounded-full border px-3 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35"
            style={{ background: selected ? theme.node.text : "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: selected ? theme.node.panel : theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input type="number" min={1} className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                p
            </span>
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function NumberInput({ value, min, max, theme, onChange }: { value: string; min: number; max: number; theme: CanvasTheme; onChange: (value: string) => void }) {
    return <input type="number" min={min} max={max} className="h-9 w-16 rounded-full border bg-transparent px-2 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }} value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />;
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}

function ratioPreview(ratio: string) {
    if (/^\d+x\d+$/.test(ratio)) {
        const [w, h] = ratio.split("x").map(Number);
        return { width: w || 16, height: h || 9 };
    }
    if (ratio === "9:16") return { width: 9, height: 16 };
    if (ratio === "1:1") return { width: 1, height: 1 };
    if (ratio === "4:3") return { width: 4, height: 3 };
    if (ratio === "3:4") return { width: 3, height: 4 };
    if (ratio === "21:9") return { width: 21, height: 9 };
    if (ratio === "adaptive" || ratio === "auto") return { width: 0, height: 0 };
    return { width: 16, height: 9 };
}

function SwitchRow({ label, checked, theme, onChange }: { label: string; checked: boolean; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex h-8 items-center justify-between gap-3">
            <span className="text-sm" style={{ color: theme.node.text }}>
                {label}
            </span>
            <span onMouseDown={(event) => event.stopPropagation()}>
                <Switch size="small" checked={checked} onChange={onChange} />
            </span>
        </div>
    );
}

function readSizeDimensions(size: string) {
    if (size === "auto") return { width: 0, height: 0 };
    const match = size.match(/^(\d+)x(\d+)$/);
    return { width: Number(match?.[1]) || 1280, height: Number(match?.[2]) || 720 };
}

// re-export for tests / callers that may import PillOption type indirectly
export type { PillOption };
