import { useEffect, useRef, useState } from "react";
import { App, Button, Tooltip } from "antd";
import { ArrowUp, LoaderCircle, Square, WandSparkles } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { requestCreditCost } from "@/constant/credits";
import { canvasThemes } from "@/lib/canvas-theme";
import { mergeCanvasNodeAiConfig } from "@/lib/canvas/canvas-node-ai-config";
import { optimizeGenerationPrompt, type PromptOptimizeMode } from "@/lib/prompt-optimize";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
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
    // 点击已生成节点时始终回填 metadata.prompt，与上游一致；不要因已有 content 清空。
    const [prompt, setPrompt] = useState(node.metadata?.prompt || "");
    const [optimizingPrompt, setOptimizingPrompt] = useState(false);
    const optimizeAbortRef = useRef<AbortController | null>(null);
    const promptEditorHostRef = useRef<HTMLDivElement | null>(null);
    const credits = requestCreditCost({ channelMode: config.channelMode, model: config.model, count: mode === "image" ? config.count : 1 });
    const textModel = (globalConfig.textModel || globalConfig.model || "").trim();
    const optimizeMode = promptOptimizeMode(mode);
    const canOptimize = Boolean(prompt.trim()) && !optimizingPrompt && !isRunning;

    // 仅切换到其它节点时恢复对应提示词；同一节点生成完成后继续保留当前输入。
    useEffect(() => {
        setPrompt(node.metadata?.prompt || "");
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only reset on node switch
    }, [node.id]);

    const getPromptEditor = () => promptEditorHostRef.current?.querySelector<HTMLElement>("[contenteditable='true']") || null;

    const focusPrompt = (options?: { placeAtEnd?: boolean }) => {
        const editor = getPromptEditor();
        if (!editor || optimizingPrompt) return false;
        // 已生成视频/音频节点的 media 控件容易抢走焦点，先 blur
        const media = document.querySelectorAll<HTMLElement>(`[data-node-id="${node.id}"] video, [data-node-id="${node.id}"] audio`);
        media.forEach((element) => {
            try {
                element.blur();
            } catch {
                // ignore
            }
        });
        if (document.activeElement instanceof HTMLElement && document.activeElement !== editor) {
            const tag = document.activeElement.tagName;
            if (tag === "VIDEO" || tag === "AUDIO" || tag === "BUTTON") document.activeElement.blur();
        }
        editor.focus({ preventScroll: true });
        if (options?.placeAtEnd) {
            try {
                const range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(false);
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
            } catch {
                // ignore unsupported selection on some browsers
            }
        }
        return document.activeElement === editor;
    };

    useEffect(() => {
        // 等节点点击/拖拽 mouseup 结束后再聚焦；已生成媒体节点多试几次，防止 video 控件抢焦点
        if (optimizingPrompt) return;
        let cancelled = false;
        const timers = [0, 40, 100, 200, 360, 520].map((delay) =>
            window.setTimeout(() => {
                if (cancelled) return;
                // 用户已在输入框内点击/选中时，不要再把光标强行拽到末尾
                const editor = getPromptEditor();
                if (editor && document.activeElement === editor) {
                    const selection = window.getSelection();
                    if (selection?.rangeCount && !selection.isCollapsed) return;
                    if (selection?.rangeCount) {
                        const range = selection.getRangeAt(0);
                        const endRange = document.createRange();
                        endRange.selectNodeContents(editor);
                        endRange.collapse(false);
                        if (range.compareBoundaryPoints(Range.START_TO_START, endRange) < 0) return;
                    }
                }
                focusPrompt({ placeAtEnd: true });
            }, delay),
        );
        return () => {
            cancelled = true;
            timers.forEach((timer) => window.clearTimeout(timer));
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- focus only on node/content/optimize changes
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
                // 把已连接/可 @ 的素材摘要塞进润色约束，不改变生成请求本身
                contextNotes: buildOptimizeContextNotes(mentionReferences, mode, hasImageContent),
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
            data-canvas-no-zoom
            className="w-[min(560px,calc(100vw-32px))] rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {/* 与上游一致：无顶栏标题，输入区 + 底栏（库/优化/模型/参数/发送）；@ 引用为真实缩略图 chip */}
            <div
                ref={promptEditorHostRef}
                className="rounded-xl"
                onPointerDown={(event) => {
                    // 只拦冒泡；点到 contentEditable 本身时保留浏览器光标定位
                    event.stopPropagation();
                    const target = event.target;
                    if (target instanceof HTMLElement && target.closest("[contenteditable='true']")) return;
                    // 点到边框空白处时才 focus，保留现有光标或放到末尾
                    focusPrompt({ placeAtEnd: true });
                }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                }}
            >
                <CanvasPromptChipInput
                    value={prompt}
                    references={mentionReferences}
                    onChange={updatePrompt}
                    onSubmit={submit}
                    className="canvas-prompt-scrollbar canvas-prompt-caret thin-scrollbar min-h-40 max-h-[min(50vh,28rem)] h-40 w-full cursor-text rounded-xl px-3 py-2 text-sm leading-5 outline-none select-text"
                    style={{ background: "transparent", color: theme.node.text || "#111827", caretColor: "#2563eb" }}
                    placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent)}
                />
            </div>

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <CanvasPromptLibrary onSelect={updatePrompt} optimizeMode={optimizeMode} />
                    <Tooltip title={optimizeTooltip(optimizeMode)}>
                        <Button
                            type="text"
                            size="small"
                            className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0"
                            style={{ color: theme.node.text }}
                            icon={<WandSparkles className="size-3.5" />}
                            loading={optimizingPrompt}
                            disabled={!canOptimize}
                            onClick={() => void optimizePrompt()}
                            aria-label="AI 优化"
                        />
                    </Tooltip>
                    {mode === "image" ? (
                        <>
                            <ModelPicker
                                className="!h-8 max-w-[190px]"
                                config={config}
                                value={config.model}
                                onChange={(model) => onConfigChange(node.id, { model })}
                                capability="image"
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-8 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker
                                className="!h-8 max-w-[190px]"
                                config={config}
                                value={config.model}
                                onChange={(model) => onConfigChange(node.id, { model })}
                                capability="video"
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                            <CanvasVideoSettingsPopover config={config} buttonClassName="!h-8 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker
                                className="!h-8 max-w-[190px]"
                                config={config}
                                value={config.model}
                                onChange={(model) => onConfigChange(node.id, { model })}
                                capability="audio"
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-8 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <>
                            <ModelPicker
                                className="!h-8 max-w-[190px]"
                                config={config}
                                value={config.model}
                                onChange={(model) => onConfigChange(node.id, { model })}
                                capability="text"
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                            <CanvasTextSettingsPopover config={config} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} />
                        </>
                    )}
                </div>
                <Button
                    type="primary"
                    className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                    danger={isRunning}
                    disabled={(!isRunning && !prompt.trim()) || optimizingPrompt}
                    onClick={() => (isRunning ? onStop(node.id) : submit())}
                    aria-label={isRunning ? "停止生成" : "生成"}
                    title={isRunning ? "停止生成" : credits > 0 ? `生成（约 ${credits}）` : "生成"}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span className="text-xs font-medium">停止</span>
                            </>
                        ) : (
                            <ArrowUp className="size-4" />
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

function optimizeTooltip(mode: PromptOptimizeMode) {
    if (mode === "video") return "AI 优化：动作/运镜/节奏，并按人物·场景·道具·分镜手册增强（保留原意与已连接参考）";
    if (mode === "audio") return "AI 优化：语气/节奏/旁白，适合 TTS 朗读";
    if (mode === "text") return "AI 优化：目标/结构/语气，不改成画面镜头词";
    return "AI 优化：自动识别人物/场景/道具，补全可执行画面维度（保留原意与已连接参考）";
}

/** 润色附加上下文：仅文本摘要，不改生成链路、不上传额外媒体 */
function buildOptimizeContextNotes(references: CanvasResourceReference[], mode: CanvasNodeGenerationMode, hasImageContent: boolean) {
    const notes: string[] = [];
    if (hasImageContent && mode === "image") notes.push("当前节点已有图片内容，按图生图/编辑意图优化，保持原图主体可辨认。");
    if (hasImageContent && mode === "video") notes.push("当前节点或上游可能带参考图，优化时强调主体与服装一致，只补运动与镜头。");

    const active = references.filter((item) => item.active).slice(0, 8);
    const pool = active.length ? active : references.filter((item) => item.kind === "image" || item.kind === "text").slice(0, 6);
    for (const ref of pool) {
        if (ref.kind === "image") {
            notes.push(`已连接图片参考「${ref.label || ref.title}」：提示词需与该参考主体一致，不要换成另一个人/物。`);
            continue;
        }
        if (ref.kind === "video") {
            notes.push(`已连接视频参考「${ref.label || ref.title}」：可借鉴运动与镜头，勿丢掉用户原文主体。`);
            continue;
        }
        if (ref.kind === "text" && ref.text?.trim()) {
            const snippet = ref.text.trim().replace(/\s+/g, " ").slice(0, 80);
            notes.push(`已连接文本「${ref.label || ref.title}」：${snippet}`);
        }
    }
    return notes;
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
