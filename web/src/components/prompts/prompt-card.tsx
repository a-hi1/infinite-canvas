import { Copy, ImageIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Card, Tag } from "antd";

import { getCategoryLabel, getPromptQualityLabel, getPromptSummary, isUsablePromptCoverUrl, markPromptCoverBroken, type Prompt } from "@/services/api/prompts";

export function PromptCard({
    item,
    onOpen,
    onCopy,
    actionLabel = "复制",
    actionIcon = <Copy className="size-3.5" />,
    actionType = "text",
    extraAction,
    onCoverBroken,
}: {
    item: Prompt;
    onOpen: () => void;
    onCopy: () => void;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionType?: "text" | "primary";
    extraAction?: ReactNode;
    /** 封面加载失败/过小时回调，便于列表重排 */
    onCoverBroken?: (promptId: string, coverUrl: string) => void;
}) {
    const tags = Array.from(new Set(item.tags.filter(Boolean))).slice(0, 4);
    const summary = getPromptSummary(item);
    const quality = getPromptQualityLabel(item.qualityScore || 0);
    const sourceLabel = getCategoryLabel(item.category);
    const initialCover = isUsablePromptCoverUrl(item.coverUrl) ? item.coverUrl.trim() : "";
    const [coverBroken, setCoverBroken] = useState(false);
    const showCover = Boolean(initialCover) && !coverBroken;

    useEffect(() => {
        setCoverBroken(false);
    }, [item.id, item.coverUrl]);

    const failCover = () => {
        if (coverBroken) return;
        setCoverBroken(true);
        if (initialCover) {
            markPromptCoverBroken(initialCover);
            onCoverBroken?.(item.id, initialCover);
        }
    };

    return (
        <Card
            hoverable
            className="overflow-hidden"
            styles={{ body: { padding: 0 } }}
            cover={
                <button type="button" className="block w-full text-left" onClick={onOpen}>
                    {showCover ? (
                        <img
                            src={initialCover}
                            alt={item.title}
                            className="aspect-4/3 w-full object-cover"
                            loading="lazy"
                            onError={failCover}
                            onLoad={(event) => {
                                const img = event.currentTarget;
                                if (img.naturalWidth > 0 && img.naturalHeight > 0 && (img.naturalWidth < 48 || img.naturalHeight < 48)) {
                                    failCover();
                                }
                            }}
                        />
                    ) : (
                        <div className="flex aspect-4/3 w-full flex-col items-center justify-center gap-2 bg-stone-100 px-4 text-center text-stone-400 dark:bg-stone-900 dark:text-stone-500">
                            <ImageIcon className="size-8" />
                            <span className="text-xs">无预览图 · 建议先看摘要</span>
                        </div>
                    )}
                </button>
            }
        >
            <button type="button" className="block w-full text-left" onClick={onOpen}>
                <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                        <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{item.title}</h2>
                        <span className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500 dark:bg-stone-800 dark:text-stone-300">{quality}</span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-600 dark:text-stone-400">{summary}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        <Tag className="m-0 text-[11px]" color="blue">
                            {sourceLabel}
                        </Tag>
                        {item.topic ? (
                            <Tag className="m-0 text-[11px]" color="processing">
                                {item.topic}
                            </Tag>
                        ) : null}
                        {tags.map((tag) => (
                            <Tag key={tag} className="m-0 text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                    </div>
                </div>
            </button>
            <div className="px-4 pb-3">
                <div
                    className="prompt-action-scroll flex gap-2 overflow-x-auto overscroll-x-contain"
                    onWheel={(event) => {
                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                        event.preventDefault();
                        event.currentTarget.scrollLeft += event.deltaY;
                    }}
                >
                    {extraAction}
                    <Button size="small" type={actionType} icon={actionIcon} onClick={onCopy} className="shrink-0">
                        {actionLabel}
                    </Button>
                </div>
            </div>
        </Card>
    );
}
