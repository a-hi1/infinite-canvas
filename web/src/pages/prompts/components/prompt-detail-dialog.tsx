import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, FolderPlus, ImageIcon, ImagePlus, Sparkles, Star, VideoIcon, WandSparkles, X } from "lucide-react";
import { Button, Modal, Space, Tag } from "antd";

import { getCategoryLabel, getPromptQualityLabel, getPromptSummary, isUsablePromptCoverUrl, markPromptCoverBroken, type Prompt } from "@/services/api/prompts";

export function PromptDetailDialog({
    prompt,
    onClose,
    onCopy,
    onSaveAsset,
    onUseImage,
    onUseVideo,
    onOptimizeAndUseImage,
    onToggleFavorite,
    favorited = false,
    onSaveToMine,
    onOptimizeMine,
    onGenerateCover,
    generatingCover = false,
}: {
    prompt: Prompt | null;
    onClose: () => void;
    onCopy: (prompt: string) => void;
    onSaveAsset?: (prompt: Prompt) => void;
    onUseImage?: (prompt: Prompt) => void;
    onUseVideo?: (prompt: Prompt) => void;
    onOptimizeAndUseImage?: (prompt: Prompt) => void;
    onToggleFavorite?: (prompt: Prompt) => void;
    favorited?: boolean;
    onSaveToMine?: (prompt: Prompt) => void;
    onOptimizeMine?: (prompt: Prompt) => void;
    /** 单条按需生成预览图（与「用于生图」分离） */
    onGenerateCover?: (prompt: Prompt) => void;
    generatingCover?: boolean;
}) {
    const [previewOpen, setPreviewOpen] = useState(false);
    const tags = prompt ? Array.from(new Set(prompt.tags.filter(Boolean))).slice(0, 8) : [];
    const summary = prompt ? getPromptSummary(prompt) : "";
    const quality = prompt ? getPromptQualityLabel(prompt.qualityScore || 0) : "";
    const sourceLabel = prompt ? getCategoryLabel(prompt.category) : "";
    const rawCoverUrl = (prompt?.coverUrl || "").trim();
    const coverUrl = isUsablePromptCoverUrl(rawCoverUrl) ? rawCoverUrl : "";
    const [coverBroken, setCoverBroken] = useState(false);
    const showCover = Boolean(coverUrl) && !coverBroken;

    useEffect(() => {
        setPreviewOpen(false);
        setCoverBroken(false);
    }, [prompt?.id, coverUrl]);

    useEffect(() => {
        if (!previewOpen) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setPreviewOpen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [previewOpen]);

    const openPreview = () => {
        if (!coverUrl) return;
        setPreviewOpen(true);
    };

    return (
        <>
            <Modal title={prompt?.title} open={Boolean(prompt)} onCancel={onClose} footer={null} width={860}>
                {prompt ? (
                    <div className="grid gap-5 md:grid-cols-[300px_minmax(0,1fr)]">
                        <div className="space-y-3">
                            {showCover ? (
                                <button
                                    type="button"
                                    onClick={openPreview}
                                    className="relative block w-full overflow-hidden rounded-lg border-0 bg-transparent p-0 text-left"
                                    style={{ cursor: "zoom-in" }}
                                    title="点击放大"
                                >
                                    <img
                                        src={coverUrl}
                                        alt={prompt.title}
                                        className="aspect-4/3 w-full object-cover"
                                        draggable={false}
                                        onError={() => {
                                            setCoverBroken(true);
                                            if (coverUrl) markPromptCoverBroken(coverUrl);
                                        }}
                                        onLoad={(event) => {
                                            const img = event.currentTarget;
                                            if (img.naturalWidth > 0 && img.naturalHeight > 0 && (img.naturalWidth < 48 || img.naturalHeight < 48)) {
                                                setCoverBroken(true);
                                                if (coverUrl) markPromptCoverBroken(coverUrl);
                                            }
                                        }}
                                    />
                                </button>
                            ) : (
                                <div className="flex aspect-4/3 w-full flex-col items-center justify-center gap-2 rounded-lg bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-500">
                                    <ImageIcon className="size-8" />
                                    <span className="text-xs">暂无预览图</span>
                                </div>
                            )}
                            {onGenerateCover ? (
                                <Button block icon={<Sparkles className="size-4" />} loading={generatingCover} onClick={() => onGenerateCover(prompt)}>
                                    {showCover ? "重新生成预览图" : "生成预览图"}
                                </Button>
                            ) : null}
                            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-5 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
                                <div className="mb-1 font-medium text-stone-800 dark:text-stone-100">用途摘要</div>
                                <div>{summary}</div>
                                {onGenerateCover ? <div className="mt-2 text-[11px] text-stone-400 dark:text-stone-500">预览图仅本地保存，不会回写第三方仓库；与「用于生图」分开，只生 1 张封面。</div> : null}
                            </div>
                        </div>
                        <div className="min-w-0">
                            <div className="flex flex-wrap gap-1.5">
                                <Tag color="blue" className="m-0">
                                    {sourceLabel}
                                </Tag>
                                <Tag color="processing" className="m-0">
                                    {quality}
                                </Tag>
                                {prompt.topic ? (
                                    <Tag className="m-0" color="geekblue">
                                        {prompt.topic}
                                    </Tag>
                                ) : null}
                                {tags.map((tag) => (
                                    <Tag key={tag} className="m-0">
                                        {tag}
                                    </Tag>
                                ))}
                            </div>
                            <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-stone-800 dark:text-stone-300">{prompt.prompt}</p>
                            <div className="mt-4 text-xs text-stone-500 dark:text-stone-400">
                                质量分 {prompt.qualityScore || 0} · {showCover ? "有预览图" : "无预览图"} · 适合先{showCover ? "看图理解再生成" : "用 AI 优化后生成"}
                            </div>
                            <Space wrap className="mt-5">
                                <Button type="primary" icon={<ImagePlus className="size-4" />} onClick={() => onUseImage?.(prompt)}>
                                    用于生图
                                </Button>
                                <Button icon={<VideoIcon className="size-4" />} onClick={() => onUseVideo?.(prompt)}>
                                    用于视频
                                </Button>
                                <Button icon={<WandSparkles className="size-4" />} onClick={() => onOptimizeAndUseImage?.(prompt)}>
                                    优化后生图
                                </Button>
                                {onOptimizeMine ? (
                                    <Button icon={<WandSparkles className="size-4" />} onClick={() => onOptimizeMine(prompt)}>
                                        优化并另存
                                    </Button>
                                ) : null}
                                {onToggleFavorite ? (
                                    <Button icon={<Star className="size-4" />} type={favorited ? "primary" : "default"} onClick={() => onToggleFavorite(prompt)}>
                                        {favorited ? "已收藏" : "收藏"}
                                    </Button>
                                ) : null}
                                {onSaveToMine ? <Button onClick={() => onSaveToMine(prompt)}>存到我的提示词</Button> : null}
                                <Button icon={<Copy className="size-4" />} onClick={() => onCopy(prompt.prompt)}>
                                    复制提示词
                                </Button>
                                {onSaveAsset ? (
                                    <Button icon={<FolderPlus className="size-4" />} onClick={() => onSaveAsset(prompt)}>
                                        加入我的资产
                                    </Button>
                                ) : null}
                            </Space>
                        </div>
                    </div>
                ) : null}
            </Modal>

            {previewOpen && coverUrl && typeof document !== "undefined"
                ? createPortal(
                      <div
                          role="dialog"
                          aria-modal="true"
                          aria-label="预览图放大"
                          onClick={() => setPreviewOpen(false)}
                          style={{
                              position: "fixed",
                              inset: 0,
                              zIndex: 10000,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              padding: 16,
                              background: "rgba(0,0,0,0.85)",
                          }}
                      >
                          <button
                              type="button"
                              onClick={(event) => {
                                  event.stopPropagation();
                                  setPreviewOpen(false);
                              }}
                              aria-label="关闭预览"
                              style={{
                                  position: "absolute",
                                  top: 16,
                                  right: 16,
                                  zIndex: 1,
                                  width: 44,
                                  height: 44,
                                  borderRadius: 999,
                                  border: 0,
                                  background: "rgba(255,255,255,0.2)",
                                  color: "#fff",
                                  cursor: "pointer",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                              }}
                          >
                              <X className="size-5" />
                          </button>
                          <img
                              src={coverUrl}
                              alt={prompt?.title || "预览图"}
                              onClick={(event) => event.stopPropagation()}
                              draggable={false}
                              style={{
                                  maxHeight: "90vh",
                                  maxWidth: "92vw",
                                  borderRadius: 12,
                                  objectFit: "contain",
                                  boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
                              }}
                          />
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}
