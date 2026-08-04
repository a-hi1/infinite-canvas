import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Button, Modal } from "antd";
import { Grid2x2, LayoutGrid, Plus, RotateCcw, Trash2 } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import type { ImageSplitParams } from "@/lib/canvas/canvas-image-data";

export type CanvasImageSplitParams = ImageSplitParams;

/** 默认 2×2，保持既有切图行为 */
const defaultParams: CanvasImageSplitParams = {
    rows: 2,
    columns: 2,
    horizontalLines: [0.5],
    verticalLines: [0.5],
};

/** 角色九宫格 / 表情表：等分 3×3 */
const sheet3x3Params: CanvasImageSplitParams = {
    rows: 3,
    columns: 3,
    horizontalLines: [1 / 3, 2 / 3],
    verticalLines: [1 / 3, 2 / 3],
};

const maxLines = 11;

export function CanvasNodeSplitDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (params: CanvasImageSplitParams) => void }) {
    const [params, setParams] = useState(defaultParams);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const rows = (params.horizontalLines?.length || 0) + 1;
    const columns = (params.verticalLines?.length || 0) + 1;
    const total = rows * columns;
    const pieceSize = image
        ? {
              width: Math.max(1, Math.floor(image.width / columns)),
              height: Math.max(1, Math.floor(image.height / rows)),
          }
        : null;

    useEffect(() => {
        if (!open) return;
        setParams(defaultParams);
        setImage(null);
    }, [dataUrl, open]);

    useEffect(() => {
        if (!open) return;
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const confirm = () => {
        onConfirm({
            rows,
            columns,
            horizontalLines: params.horizontalLines || [],
            verticalLines: params.verticalLines || [],
        });
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={860} centered destroyOnHidden>
            <div className="space-y-5">
                <div>
                    <h2 className="text-xl font-semibold">切分图片</h2>
                    <p className="mt-1 text-sm opacity-60">
                        拖动分割线对齐原图分割缝，生成 {total} 个图片子节点到画布右侧
                        {rows === 3 && columns === 3 ? " · 九宫格预设为等分 1/3；若原图格子不齐请手动拖线" : ""}
                    </p>
                </div>
                <div className="grid gap-6 md:grid-cols-[minmax(280px,1fr)_280px]">
                    <div className="rounded-xl border p-4">
                        <div className="grid min-h-[320px] place-items-center rounded-lg bg-black/5">
                            <SplitPreview
                                dataUrl={dataUrl}
                                horizontalLines={params.horizontalLines || []}
                                verticalLines={params.verticalLines || []}
                                onChangeHorizontal={(horizontalLines) => setParams((current) => ({ ...current, horizontalLines, rows: horizontalLines.length + 1 }))}
                                onChangeVertical={(verticalLines) => setParams((current) => ({ ...current, verticalLines, columns: verticalLines.length + 1 }))}
                            />
                        </div>
                        <div className="mt-3 flex items-center justify-between text-sm">
                            <span className="opacity-60">原图</span>
                            <span className="font-semibold">{image ? `${image.width} x ${image.height} px` : "读取中"}</span>
                        </div>
                    </div>
                    <div className="space-y-4 py-2">
                        <div className="rounded-xl border px-4 py-3 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="opacity-60">网格</span>
                                <span className="font-semibold">
                                    {rows} × {columns}
                                </span>
                            </div>
                            <div className="mt-2 flex items-center justify-between">
                                <span className="opacity-60">子节点</span>
                                <span className="font-semibold">{total} 个</span>
                            </div>
                            <div className="mt-2 flex items-center justify-between">
                                <span className="opacity-60">单块约</span>
                                <span className="font-semibold">{pieceSize ? `${pieceSize.width} x ${pieceSize.height}` : "未知"}</span>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            <Button
                                type={rows === 3 && columns === 3 ? "primary" : "default"}
                                ghost={rows === 3 && columns === 3}
                                icon={<LayoutGrid className="size-4" />}
                                onClick={() => setParams(sheet3x3Params)}
                                className="col-span-2"
                            >
                                角色九宫格 3×3
                            </Button>
                            <Button icon={<Plus className="size-4" />} disabled={(params.verticalLines?.length || 0) >= maxLines} onClick={() => setParams((current) => ({ ...current, verticalLines: addLine(current.verticalLines || []), columns: (current.verticalLines?.length || 0) + 2 }))}>
                                竖线
                            </Button>
                            <Button icon={<Plus className="size-4" />} disabled={(params.horizontalLines?.length || 0) >= maxLines} onClick={() => setParams((current) => ({ ...current, horizontalLines: addLine(current.horizontalLines || []), rows: (current.horizontalLines?.length || 0) + 2 }))}>
                                横线
                            </Button>
                            <Button
                                icon={<Trash2 className="size-4" />}
                                disabled={!(params.verticalLines?.length || params.horizontalLines?.length)}
                                onClick={() =>
                                    setParams((current) => {
                                        const verticalLines = (current.verticalLines || []).slice(0, -1);
                                        const horizontalLines = (current.horizontalLines || []).slice(0, -1);
                                        return {
                                            ...current,
                                            verticalLines,
                                            horizontalLines,
                                            rows: horizontalLines.length + 1,
                                            columns: verticalLines.length + 1,
                                        };
                                    })
                                }
                            >
                                删末线
                            </Button>
                            <Button icon={<RotateCcw className="size-4" />} onClick={() => setParams(defaultParams)}>
                                重置 2×2
                            </Button>
                        </div>

                        <Button type="primary" size="large" className="w-full" icon={<Grid2x2 className="size-4" />} onClick={confirm}>
                            生成子节点
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function SplitPreview({
    dataUrl,
    horizontalLines,
    verticalLines,
    onChangeHorizontal,
    onChangeVertical,
}: {
    dataUrl: string;
    horizontalLines: number[];
    verticalLines: number[];
    onChangeHorizontal: (lines: number[]) => void;
    onChangeVertical: (lines: number[]) => void;
}) {
    const boxRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ axis: "h" | "v"; index: number } | null>(null);

    const sortedH = useMemo(() => [...horizontalLines].sort((a, b) => a - b), [horizontalLines]);
    const sortedV = useMemo(() => [...verticalLines].sort((a, b) => a - b), [verticalLines]);

    const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!dragRef.current || !boxRef.current) return;
        const rect = boxRef.current.getBoundingClientRect();
        if (dragRef.current.axis === "v") {
            const ratio = clampLine((event.clientX - rect.left) / rect.width);
            onChangeVertical(sortedV.map((value, index) => (index === dragRef.current!.index ? ratio : value)));
            return;
        }
        const ratio = clampLine((event.clientY - rect.top) / rect.height);
        onChangeHorizontal(sortedH.map((value, index) => (index === dragRef.current!.index ? ratio : value)));
    };

    const stopDrag = () => {
        dragRef.current = null;
    };

    return (
        <div
            ref={boxRef}
            className="relative inline-block max-w-full touch-none overflow-hidden rounded-lg bg-black shadow-xl"
            onPointerMove={onPointerMove}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
            onPointerLeave={stopDrag}
        >
            <img src={dataUrl} alt="" className="block max-h-[360px] max-w-full object-contain opacity-95" draggable={false} />
            {sortedV.map((line, index) => (
                <button
                    key={`v-${index}`}
                    type="button"
                    className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-col-resize border-0 bg-transparent p-0"
                    style={{ left: `${line * 100}%` }}
                    onPointerDown={(event) => {
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        dragRef.current = { axis: "v", index };
                    }}
                    aria-label={`垂直分割线 ${index + 1}`}
                >
                    <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,.45)]" />
                </button>
            ))}
            {sortedH.map((line, index) => (
                <button
                    key={`h-${index}`}
                    type="button"
                    className="absolute inset-x-0 z-10 h-3 -translate-y-1/2 cursor-row-resize border-0 bg-transparent p-0"
                    style={{ top: `${line * 100}%` }}
                    onPointerDown={(event) => {
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        dragRef.current = { axis: "h", index };
                    }}
                    aria-label={`水平分割线 ${index + 1}`}
                >
                    <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,.45)]" />
                </button>
            ))}
        </div>
    );
}

function addLine(lines: number[]) {
    if (lines.length >= maxLines) return lines;
    const points = [0, ...lines, 1].sort((a, b) => a - b);
    let bestStart = 0;
    let bestGap = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
        const gap = points[index + 1] - points[index];
        if (gap > bestGap) {
            bestGap = gap;
            bestStart = points[index];
        }
    }
    return [...lines, clampLine(bestStart + bestGap / 2)].sort((a, b) => a - b);
}

function clampLine(value: number) {
    return Math.min(0.95, Math.max(0.05, Number.isFinite(value) ? value : 0.5));
}
