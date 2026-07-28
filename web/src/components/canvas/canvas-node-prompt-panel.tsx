import { useEffect, useRef, useState } from "react";
import { App, Button, Tooltip } from "antd";
import { ArrowUp, LoaderCircle, Square, WandSparkles } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { CreditSymbol, requestCreditCost } from "@/constant/credits";
import { canvasThemes } from "@/lib/canvas-theme";
import { mergeCanvasNodeAiConfig } from "@/lib/canvas/canvas-node-ai-config";
import { optimizeGenerationPrompt, type PromptOptimizeMode } from "@/lib/prompt-optimize";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    onImageSettingsOpenChange?: (open: boolean) => void;
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], onImageSettingsOpenChange }: CanvasNodePromptPanelProps) {
    const { message } = App.useApp();
    const globalConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = defaultMode(node.type);
    const config = mergeCanvasNodeAiConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(isEditingExistingContent ? "" : node.metadata?.prompt || "");
    const [optimizingPrompt, setOptimizingPrompt] = useState(false);
    const optimizeAbortRef = useRef<AbortController | null>(null);
    const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const credits = requestCreditCost({ channelMode: config.channelMode, model: config.model, count: mode === "image" ? config.count : 1 });
    const textModel = (globalConfig.textModel || globalConfig.model || "").trim();
    const optimizeMode = promptOptimizeMode(mode);
    const canOptimize = Boolean(prompt.trim()) && !optimizingPrompt && !isRunning;

    // 仅切换节点时重置输入框；同一节点生成完成后 content 写回会让 isEditingExistingContent 变 true，此时保留用户刚才提交的提示词，便于微调再生成。
    useEffect(() => {
        setPrompt(isEditingExistingContent ? "" : node.metadata?.prompt || "");
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only reset on node switch
    }, [node.id]);

    const focusPrompt = (options?: { placeAtEnd?: boolean }) => {
        const textarea = promptTextareaRef.current;
        if (!textarea || textarea.disabled) return false;
        // 已生成视频/音频节点的 media 控件容易抢走焦点，先 blur
        const media = document.querySelectorAll<HTMLElement>(`[data-node-id="${node.id}"] video, [data-node-id="${node.id}"] audio`);
        media.forEach((element) => {
            try {
                element.blur();
            } catch {
                // ignore
            }
        });
        if (document.activeElement instanceof HTMLElement && document.activeElement !== textarea) {
            const tag = document.activeElement.tagName;
            if (tag === "VIDEO" || tag === "AUDIO" || tag === "BUTTON") document.activeElement.blur();
        }
        const selectionStart = textarea.selectionStart;
        const selectionEnd = textarea.selectionEnd;
        textarea.focus({ preventScroll: true });
        // 仅首次自动聚焦时跳到末尾；鼠标点击后要保留浏览器算出的光标位置
        try {
            if (options?.placeAtEnd) {
                const end = textarea.value.length;
                textarea.setSelectionRange(end, end);
            } else if (typeof selectionStart === "number" && typeof selectionEnd === "number") {
                textarea.setSelectionRange(selectionStart, selectionEnd);
            }
        } catch {
            // ignore unsupported selection on some browsers
        }
        return document.activeElement === textarea;
    };

    useEffect(() => {
        // 等节点点击/拖拽 mouseup 结束后再聚焦；已生成媒体节点多试几次，防止 video 控件抢焦点
        if (optimizingPrompt) return;
        let cancelled = false;
        const timers = [0, 40, 100, 200, 360, 520].map((delay) =>
            window.setTimeout(() => {
                if (cancelled) return;
                // 用户已在输入框内点击/选中时，不要再把光标强行拽到末尾
                const textarea = promptTextareaRef.current;
                if (textarea && document.activeElement === textarea && typeof textarea.selectionStart === "number" && textarea.selectionStart !== textarea.value.length) {
                    return;
                }
                focusPrompt({ placeAtEnd: true });
            }, delay),
        );
        return () => {
            cancelled = true;
            timers.forEach((timer) => window.clearTimeout(timer));
        };
    }, [node.id, optimizingPrompt, node.metadata?.content]);

    useEffect(() => {
        return () => {
            optimizeAbortRef.current?.abort();
            optimizeAbortRef.current = null;
        };
    }, []);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (!isEditingExistingContent) onPromptChange(node.id, value);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || isRunning || optimizingPrompt) return;
        onGenerate(node.id, mode, text);
        // 不在这里清空：生成完成后仍显示原提示词，方便改词重跑（对齐上游 v0.10 体验）
    };

    const optimizePrompt = async () => {
        const text = prompt.trim();
        if (!text || optimizingPrompt || isRunning) return;
        if (!isAiConfigReady(globalConfig, textModel)) {
            message.warning("请先配置可用的文本模型，用于优化提示词");
            openConfigDialog(true);
            return;
        }

        optimizeAbortRef.current?.abort();
        const controller = new AbortController();
        optimizeAbortRef.current = controller;
        setOptimizingPrompt(true);
        try {
            const optimized = await optimizeGenerationPrompt(globalConfig, text, optimizeMode, {
                signal: controller.signal,
                onDelta: (value) => updatePrompt(value),
            });
            updatePrompt(optimized);
            message.success("提示词已优化");
        } catch (error) {
            if (controller.signal.aborted) return;
            message.error(error instanceof Error ? error.message : "提示词优化失败");
        } finally {
            if (optimizeAbortRef.current === controller) optimizeAbortRef.current = null;
            setOptimizingPrompt(false);
        }
    };

    return (
        <div
            className="w-[min(560px,calc(100vw-32px))] rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium opacity-70">{modeLabel(mode)}提示词</div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <CanvasPromptLibrary onSelect={updatePrompt} optimizeMode={optimizeMode} />
                    <Tooltip title={optimizeTooltip(optimizeMode)}>
                        <Button
                            type="default"
                            size="small"
                            className="!h-8 !rounded-full !px-2.5"
                            icon={<WandSparkles className="size-3.5" />}
                            loading={optimizingPrompt}
                            disabled={!canOptimize}
                            onClick={() => void optimizePrompt()}
                        >
                            AI 优化
                        </Button>
                    </Tooltip>
                </div>
            </div>

            <div
                className="rounded-xl"
                onPointerDown={(event) => {
                    // 只拦冒泡，不在这里强设 selection，否则会覆盖鼠标点击定位
                    event.stopPropagation();
                    const target = event.target;
                    if (target instanceof HTMLTextAreaElement) return;
                    // 点到边框空白处时才 focus，保留现有光标或放到末尾
                    focusPrompt({ placeAtEnd: true });
                }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                }}
            >
                <CanvasResourceMentionTextarea
                    ref={promptTextareaRef}
                    value={prompt}
                    references={mentionReferences}
                    // 节点生成面板优先保证光标可见；@ 插入仍可用，但不做透明文字高亮层
                    highlightLabels={false}
                    onChange={updatePrompt}
                    onSubmit={submit}
                    disabled={optimizingPrompt}
                    autoFocus
                    // 默认更高 + 可纵向拖右下角拉高；框内滚轮滚动文本，不拖动画布缩放
                    containerClassName="min-h-40"
                    className="canvas-prompt-scrollbar canvas-prompt-caret min-h-40 max-h-[min(50vh,28rem)] h-40 w-full resize-y overflow-y-auto rounded-xl border px-3 py-2 text-sm leading-6 outline-none select-text"
                    style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text || "#111827", caretColor: "#2563eb" }}
                    placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent)}
                    onPointerDown={(event) => {
                        // 让浏览器先处理点击定位光标，再只 focus 不改 selection
                        event.stopPropagation();
                    }}
                    onMouseDown={(event) => {
                        event.stopPropagation();
                    }}
                    onWheel={(event) => {
                        // 阻止画布缩放；可滚动时让浏览器滚文本框本身
                        event.stopPropagation();
                    }}
                />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    {mode === "image" ? (
                        <>
                            <ModelPicker
                                className="!h-10 !min-w-[10.5rem] !max-w-[220px]"
                                config={config}
                                value={config.model}
                                onChange={(model) => onConfigChange(node.id, { model })}
                                capability="image"
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[190px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker
                                className="!h-10 !min-w-[10.5rem] !max-w-[220px]"
                                config={config}
                                value={config.model}
                                onChange={(model) => onConfigChange(node.id, { model })}
                                capability="video"
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                            <CanvasVideoSettingsPopover config={config} buttonClassName="!h-10 !max-w-[190px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker
                                className="!h-10 !min-w-[10.5rem] !max-w-[220px]"
                                config={config}
                                value={config.model}
                                onChange={(model) => onConfigChange(node.id, { model })}
                                capability="audio"
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[190px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <ModelPicker
                            className="!h-10 !min-w-[10.5rem] !max-w-[220px]"
                            config={config}
                            value={config.model}
                            onChange={(model) => onConfigChange(node.id, { model })}
                            capability="text"
                            onMissingConfig={() => openConfigDialog(true)}
                        />
                    )}
                </div>
                <Button
                    type="primary"
                    className="!h-10 !min-w-[4.5rem] shrink-0 !rounded-full !px-3.5"
                    danger={isRunning}
                    disabled={(!isRunning && !prompt.trim()) || optimizingPrompt}
                    onClick={() => (isRunning ? onStop(node.id) : submit())}
                    aria-label={isRunning ? "停止生成" : "生成"}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span className="text-xs font-medium">停止</span>
                            </>
                        ) : (
                            <>
                                <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums">
                                    <CreditSymbol />
                                    {credits.toLocaleString()}
                                </span>
                                <ArrowUp className="size-4" />
                            </>
                        )}
                    </span>
                </Button>
            </div>
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function promptOptimizeMode(mode: CanvasNodeGenerationMode): PromptOptimizeMode {
    if (mode === "video") return "video";
    if (mode === "audio") return "audio";
    if (mode === "text") return "text";
    return "image";
}

function modeLabel(mode: CanvasNodeGenerationMode) {
    if (mode === "video") return "视频";
    if (mode === "audio") return "音频";
    if (mode === "text") return "文本";
    return "图片";
}

function optimizeTooltip(mode: PromptOptimizeMode) {
    if (mode === "video") return "使用文本模型优化视频提示词（动作、运镜、节奏）";
    if (mode === "audio") return "使用文本模型优化音频提示词（语气、节奏、旁白）";
    if (mode === "text") return "使用文本模型优化文本提示词（目标、结构、语气）";
    return "使用文本模型优化图片提示词（主体、构图、风格）";
}

function promptPlaceholder(mode: CanvasNodeGenerationMode, hasImageContent: boolean, hasTextContent: boolean) {
    if (mode === "video") return "描述要生成的视频内容";
    if (mode === "audio") return "描述要生成的音频内容";
    if (mode === "image") return hasImageContent ? "请输入你想要把这张图修改成什么" : "描述要生成的图片内容";
    return hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容";
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}
