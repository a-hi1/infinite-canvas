import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { App, Button, Image, Tooltip } from "antd";
import { FileText, Image as ImageIcon, Music2, Video, WandSparkles, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { optimizeGenerationPrompt, type PromptOptimizeMode } from "@/lib/prompt-optimize";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasGenerationMode } from "@/types/canvas";
import type { NodeGenerationInput } from "./canvas-node-generation";

type CanvasConfigComposerProps = {
    value: string;
    inputs: NodeGenerationInput[];
    mode?: CanvasGenerationMode;
    onChange: (value: string) => void;
    onClose: () => void;
};

type Token =
    | { type: "text"; value: string }
    | { type: "reference"; nodeId: string };

type MentionState = {
    query: string;
};

export const CONFIG_REFERENCE_PATTERN = /@\[node:([^\]]+)\]/g;

export function CanvasConfigComposer({ value, inputs, mode = "image", onChange, onClose }: CanvasConfigComposerProps) {
    const { message } = App.useApp();
    const globalConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const editorRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const optimizeAbortRef = useRef<AbortController | null>(null);
    const [mention, setMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const [optimizingPrompt, setOptimizingPrompt] = useState(false);
    const tokens = useMemo(() => parseComposerTokens(value), [value]);
    const referenceById = useMemo(() => new Map(inputs.map((input) => [input.nodeId, input])), [inputs]);
    const candidates = useMemo(() => {
        if (!mention) return [];
        const query = (mention.query || "").trim().toLowerCase();
        if (!query) return inputs;
        return inputs.filter((input) => `${resourceLabel(input, inputs)} ${input.title} ${input.text || ""}`.toLowerCase().includes(query));
    }, [inputs, mention]);
    const textModel = (globalConfig.textModel || globalConfig.model || "").trim();
    const optimizeMode = composerOptimizeMode(mode);
    const canOptimize = Boolean(value.trim()) && !optimizingPrompt;

    useEffect(() => {
        // 优化流式回填时即使仍有焦点也要刷新编辑器；正常输入中则跳过，避免打断光标。
        if (!optimizingPrompt && document.activeElement === editorRef.current) return;
        const editor = editorRef.current;
        if (!editor) return;
        editor.textContent = "";
        tokens.forEach((token) => {
            if (token.type === "text") {
                editor.append(document.createTextNode(token.value));
                return;
            }
            const input = referenceById.get(token.nodeId);
            if (input) editor.append(createReferenceChip(input, inputs, theme, setImagePreview));
        });
    }, [inputs, optimizingPrompt, referenceById, theme, tokens]);

    const syncFromEditor = () => {
        const editor = editorRef.current;
        if (!editor) return;
        const next = serializeEditor(editor);
        onChange(next);
        syncMention();
    };

    const syncMention = () => {
        const text = textBeforeCaret();
        const match = /@([^\s@]*)$/.exec(text);
        if (!match || !inputs.length) {
            closeMention();
            return;
        }
        setMention({ query: match[1] || "" });
        setActiveIndex(0);
    };

    const closeMention = () => {
        setMention(null);
        setActiveIndex(0);
    };

    const insertReference = (input: NodeGenerationInput) => {
        const editor = editorRef.current;
        if (!editor) return;
        removeActiveMention();
        const chip = createReferenceChip(input, inputs, theme, setImagePreview);
        const space = document.createTextNode(" ");
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range) {
            range.insertNode(space);
            range.insertNode(chip);
            range.setStartAfter(space);
            range.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(range);
        } else {
            editor.append(chip, space);
            placeCaretAtEnd(editor);
        }
        closeMention();
        onChange(serializeEditor(editor));
    };

    const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => event.stopPropagation();

    useEffect(() => {
        return () => {
            optimizeAbortRef.current?.abort();
            optimizeAbortRef.current = null;
        };
    }, []);

    const optimizePrompt = async () => {
        const source = value.trim();
        if (!source || optimizingPrompt) return;
        if (!isAiConfigReady(globalConfig, textModel)) {
            message.warning("请先配置可用的文本模型，用于优化提示词");
            openConfigDialog(true);
            return;
        }

        const { prompt: optimizeSource, restore } = prepareComposerPromptForOptimize(source);
        if (!optimizeSource.trim()) {
            message.warning("请先输入可优化的提示词文本");
            return;
        }

        optimizeAbortRef.current?.abort();
        const controller = new AbortController();
        optimizeAbortRef.current = controller;
        setOptimizingPrompt(true);
        try {
            const optimized = await optimizeGenerationPrompt(globalConfig, optimizeSource, optimizeMode, {
                signal: controller.signal,
                onDelta: (text) => onChange(restore(text)),
                // 组装面板：把已连接素材类型与标题作为约束，引用 token 仍由 restore 回填
                contextNotes: buildComposerOptimizeContextNotes(inputs),
            });
            onChange(restore(optimized));
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
            onMouseDown={stopCanvasInteraction}
            onPointerDown={stopCanvasInteraction}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-baseline gap-2">
                    <div className="shrink-0 text-xs font-semibold">组装提示词</div>
                    <div className="truncate text-[11px] opacity-55">@ 引用已连接素材，发送前按当前连接重新编号</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    <Tooltip title="AI 优化组装提示词：自动按人物/场景/道具/分镜增强，并尽量保留 @ 引用素材">
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
                    <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !p-0" icon={<X className="size-3.5" />} onClick={onClose} />
                </div>
            </div>
            <div className="relative rounded-xl border" style={{ background: theme.node.fill, borderColor: theme.node.stroke, opacity: optimizingPrompt ? 0.72 : 1 }}>
                {!value.trim() ? <div className="pointer-events-none absolute left-3 top-2 text-sm leading-7" style={{ color: theme.node.placeholder }}>输入提示词，按 @ 引用连接的图片或文本</div> : null}
                <div
                    ref={editorRef}
                    contentEditable={!optimizingPrompt}
                    suppressContentEditableWarning
                    className="canvas-prompt-scrollbar min-h-28 max-h-72 w-full overflow-y-auto overscroll-contain whitespace-pre-wrap break-words px-3 py-2 text-sm leading-7 outline-none"
                    style={{ color: theme.node.text }}
                    onInput={() => {
                        if (!composingRef.current) syncFromEditor();
                    }}
                    onCompositionStart={() => {
                        composingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                        composingRef.current = false;
                        syncFromEditor();
                    }}
                    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                        event.stopPropagation();
                        if (optimizingPrompt) {
                            event.preventDefault();
                            return;
                        }
                        if (mention && candidates.length) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setActiveIndex((index) => (index + 1) % candidates.length);
                                return;
                            }
                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
                                return;
                            }
                            if (event.key === "Enter") {
                                event.preventDefault();
                                insertReference(candidates[Math.min(activeIndex, candidates.length - 1)]);
                                return;
                            }
                            if (event.key === "Escape") {
                                event.preventDefault();
                                closeMention();
                                return;
                            }
                        }
                        if ((event.key === "Backspace" || event.key === "Delete") && deleteAdjacentReference(event.key)) {
                            event.preventDefault();
                            requestAnimationFrame(syncFromEditor);
                            return;
                        }
                        requestAnimationFrame(syncMention);
                    }}
                    onBlur={() => window.setTimeout(closeMention, 120)}
                />
                {mention && candidates.length ? <MentionMenu inputs={candidates} allInputs={inputs} activeIndex={Math.min(activeIndex, candidates.length - 1)} theme={theme} onSelect={insertReference} /> : null}
            </div>
            {imagePreview ? <Image src={imagePreview} alt="引用图片预览" style={{ display: "none" }} preview={{ visible: true, src: imagePreview, onVisibleChange: (visible) => !visible && setImagePreview(null) }} /> : null}
        </div>
    );

}

function composerOptimizeMode(mode: CanvasGenerationMode): PromptOptimizeMode {
    if (mode === "video") return "video";
    if (mode === "audio") return "audio";
    if (mode === "text") return "text";
    return "image";
}

function buildComposerOptimizeContextNotes(inputs: NodeGenerationInput[]) {
    const notes: string[] = ["组装提示词中的 [[REFn]] 是素材引用占位符，必须原样保留，不要翻译或删除。"];
    inputs.slice(0, 10).forEach((input, index) => {
        const label = resourceLabel(input, inputs);
        if (input.type === "image") {
            notes.push(`连接素材 ${label}（图片${index + 1}「${input.title || "未命名"}」）：优化后仍应对齐该参考主体。`);
            return;
        }
        if (input.type === "video") {
            notes.push(`连接素材 ${label}（视频「${input.title || "未命名"}」）：可借鉴运动，保留原文主体。`);
            return;
        }
        if (input.type === "audio") {
            notes.push(`连接素材 ${label}（音频「${input.title || "未命名"}」）。`);
            return;
        }
        const snippet = (input.text || "").trim().replace(/\s+/g, " ").slice(0, 80);
        notes.push(snippet ? `连接素材 ${label}（文本）：${snippet}` : `连接素材 ${label}（文本「${input.title || "未命名"}」）。`);
    });
    return notes;
}

function prepareComposerPromptForOptimize(value: string) {
    const placeholders: string[] = [];
    const prompt = value.replace(CONFIG_REFERENCE_PATTERN, (token) => {
        const index = placeholders.length;
        placeholders.push(token);
        return `[[REF${index}]]`;
    });

    return {
        prompt,
        restore: (text: string) => {
            let restored = text;
            placeholders.forEach((token, index) => {
                restored = restored.replace(new RegExp(`\\[\\[REF${index}\\]\\]`, "g"), token);
            });
            const missing = placeholders.filter((token) => !restored.includes(token));
            if (missing.length) restored = `${restored.trim()}\n${missing.join(" ")}`.trim();
            return restored;
        },
    };
}

function MentionMenu({ inputs, allInputs, activeIndex, theme, onSelect }: { inputs: NodeGenerationInput[]; allInputs: NodeGenerationInput[]; activeIndex: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect: (input: NodeGenerationInput) => void }) {
    const selectedRef = useRef(false);
    const activeItemRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        activeItemRef.current?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, inputs]);

    const selectInput = (input: NodeGenerationInput) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(input);
    };

    return (
        <div className="absolute left-2 top-[calc(100%+6px)] z-[90] max-h-56 w-64 overflow-y-auto rounded-xl border p-1 shadow-2xl" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
            {inputs.map((input, index) => (
                <button
                    key={input.nodeId}
                    ref={index === activeIndex ? activeItemRef : undefined}
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                    style={{ background: index === activeIndex ? theme.toolbar.activeBg : "transparent", color: index === activeIndex ? theme.toolbar.activeText : theme.node.text }}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectInput(input);
                    }}
                >
                    <ResourcePreview input={input} />
                    <span className="min-w-0 flex-1">
                        <span className="block font-medium">{resourceLabel(input, allInputs)}</span>
                        <span className="block truncate opacity-65">{input.text || input.title}</span>
                    </span>
                </button>
            ))}
        </div>
    );
}

function ResourcePreview({ input }: { input: NodeGenerationInput }) {
    if (input.type === "image" && input.image) return <img src={input.image.dataUrl} alt="" className="size-9 rounded-md object-cover" />;
    if (input.type === "video" && input.video) return <video src={input.video.url} className="size-9 rounded-md bg-black object-cover" muted preload="metadata" />;
    const Icon = input.type === "audio" ? Music2 : input.type === "video" ? Video : input.type === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
            <Icon className="size-4" />
        </span>
    );
}

function createReferenceChip(input: NodeGenerationInput, inputs: NodeGenerationInput[], theme: (typeof canvasThemes)[keyof typeof canvasThemes], onImagePreview: (url: string) => void) {
    const wrapper = document.createElement("span");
    wrapper.contentEditable = "false";
    wrapper.dataset.referenceNodeId = input.nodeId;
    wrapper.className = "mx-px inline-flex h-7 max-w-40 items-center justify-center overflow-hidden rounded-md border px-1 text-xs leading-none align-middle";
    Object.assign(wrapper.style, chipStyle(theme));
    if (input.type === "image" && input.image) {
        const image = document.createElement("img");
        image.src = input.image.dataUrl;
        image.alt = input.title;
        image.className = "size-6 rounded object-cover";
        wrapper.className = "mx-px inline-flex size-6 items-center justify-center overflow-hidden rounded align-middle";
        wrapper.appendChild(image);
        wrapper.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onImagePreview(input.image?.dataUrl || "");
        });
    } else {
        wrapper.title = input.text || input.title;
        const text = document.createElement("span");
        text.className = "block truncate";
        text.textContent = input.type === "text" ? input.text || input.title : input.title;
        wrapper.appendChild(text);
    }
    return wrapper;
}

function serializeEditor(editor: HTMLElement) {
    return serializeNodes(editor.childNodes).replace(/\uFEFF/g, "");
}

function serializeNodes(nodes: NodeListOf<ChildNode>) {
    let result = "";
    nodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) result += node.textContent || "";
        if (!(node instanceof HTMLElement)) return;
        const nodeId = node.dataset.referenceNodeId;
        if (nodeId) result += `@[node:${nodeId}]`;
        else if (node.tagName === "BR") result += "\n";
        else result += serializeNodes(node.childNodes);
    });
    return result;
}

function removeActiveMention() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const text = textBeforeCaret();
    const match = /@([^\s@]*)$/.exec(text);
    if (!match) return;
    range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
    range.deleteContents();
}

function deleteAdjacentReference(key: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const target = adjacentReferenceNode(range, key);
    if (!target) return false;
    const nextCaretNode = document.createTextNode("");
    target.replaceWith(nextCaretNode);
    range.setStart(nextCaretNode, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function adjacentReferenceNode(range: Range, key: string) {
    const container = range.startContainer;
    const offset = range.startOffset;
    const previous = key === "Backspace";
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
        return findReferenceSibling(container, previous);
    }
    const children = Array.from(container.childNodes);
    return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, true);
}

function findReferenceSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
    let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
    while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) current = previous ? current.previousSibling : current.nextSibling;
    return current instanceof HTMLElement && current.dataset.referenceNodeId ? current : null;
}

function textBeforeCaret() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return "";
    const range = selection.getRangeAt(0).cloneRange();
    const editor = closestEditor(range.startContainer);
    if (!editor) return "";
    range.setStart(editor, 0);
    return range.toString();
}

function closestEditor(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest("[contenteditable='true']") || null;
}

function placeCaretAtEnd(element: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function parseComposerTokens(value: string): Token[] {
    const tokens: Token[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(CONFIG_REFERENCE_PATTERN)) {
        if (match.index === undefined) continue;
        if (match.index > lastIndex) tokens.push({ type: "text", value: value.slice(lastIndex, match.index) });
        tokens.push({ type: "reference", nodeId: match[1] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) tokens.push({ type: "text", value: value.slice(lastIndex) });
    return tokens;
}

function resourceLabel(input: NodeGenerationInput, inputs: NodeGenerationInput[]) {
    const sameTypeInputs = inputs.filter((item) => item.type === input.type);
    const index = Math.max(0, sameTypeInputs.findIndex((item) => item.nodeId === input.nodeId));
    if (input.type === "image") return `图片${index + 1}`;
    if (input.type === "video") return `视频${index + 1}`;
    if (input.type === "audio") return `音频${index + 1}`;
    return `文本${index + 1}`;
}

function chipStyle(theme: (typeof canvasThemes)[keyof typeof canvasThemes]): CSSProperties {
    return { background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text };
}
