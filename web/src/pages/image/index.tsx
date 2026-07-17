import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, Modal, Segmented, Tag, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { optimizeGenerationPrompt } from "@/lib/prompt-optimize";
import { modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { CloudHistoryPanel } from "@/components/cloud-history-panel";
import { cloudSyncColor, cloudSyncLabel, normalizeCloudSyncStatus, type CloudSyncStatus } from "@/lib/cloud-sync";
import { isStorageQuotaError } from "@/services/cloud-api";
import { saveImageToCloudDetailed } from "@/services/cloud-history";
import { deleteStoredImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useAuthStore } from "@/stores/use-auth-store";
import type { ReferenceImage } from "@/types/image";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    image?: GeneratedImage;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "成功" | "失败";
    images: GeneratedImage[];
    thumbnails: string[];
    cloudSync?: CloudSyncStatus;
    cloudJobIds?: string[];
    cloudError?: string;
    cloudErrorReason?: string;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

export default function ImagePage() {
    const { message } = App.useApp();
    const [searchParams, setSearchParams] = useSearchParams();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cloudUser = useAuthStore((state) => state.user);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [optimizingPrompt, setOptimizingPrompt] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [historySource, setHistorySource] = useState<"local" | "cloud">("local");
    const [cloudRefreshKey, setCloudRefreshKey] = useState(0);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const textModel = effectiveConfig.textModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    useEffect(() => {
        const incoming = searchParams.get("prompt")?.trim() || "";
        if (!incoming) return;
        setPrompt(incoming);
        const shouldOptimize = searchParams.get("optimize") === "1";
        setSearchParams({}, { replace: true });
        if (!shouldOptimize) return;
        void (async () => {
            if (!isAiConfigReady(effectiveConfig, textModel)) {
                message.warning("已填入提示词。请先配置文本模型后再点 AI 优化");
                openConfigDialog(true);
                return;
            }
            setOptimizingPrompt(true);
            try {
                const optimized = await optimizeGenerationPrompt(effectiveConfig, incoming, "image", {
                    onDelta: (value) => setPrompt(value),
                });
                setPrompt(optimized);
                message.success("提示词已优化，可直接生成");
            } catch (error) {
                message.error(error instanceof Error ? error.message : "提示词优化失败");
            } finally {
                setOptimizingPrompt(false);
            }
        })();
    }, [effectiveConfig, isAiConfigReady, message, openConfigDialog, searchParams, setSearchParams, textModel]);

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error("剪切板里没有可读取的图片");
                return;
            }
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success(`已读取 ${nextReferences.length} 张参考图`);
        } catch {
            message.error("剪切板里没有可读取的图片");
        }
    };

    const optimizePrompt = async () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请先输入提示词");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, textModel)) {
            message.warning("请先配置可用的文本模型，用于优化提示词");
            openConfigDialog(true);
            return;
        }
        setOptimizingPrompt(true);
        try {
            const optimized = await optimizeGenerationPrompt(effectiveConfig, text, "image", {
                onDelta: (value) => setPrompt(value),
            });
            setPrompt(optimized);
            message.success("提示词已优化");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "提示词优化失败");
        } finally {
            setOptimizingPrompt(false);
        }
    };

    const generate = async () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请输入生图提示词");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return;
        }

        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;

        setElapsedMs(0);
        setRunning(true);
        setPreviewLog(null);
        setResults(Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" })));
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);

        const batchResult = await runGenerationBatch(snapshot, generationCount);
        const successImages = batchResult.images;
        const successCount = successImages.length;
        const failCount = generationCount - successCount;

        try {
            const logImages = await Promise.all(
                successImages.map(async (image) => {
                    const stored = await uploadImage(image.dataUrl);
                    return { ...image, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
                }),
            );
            const log = buildLog({
                prompt: text,
                model,
                config: { ...snapshot.config, count: String(generationCount) },
                references: snapshot.references,
                durationMs: performance.now() - batchStartedAt,
                successCount,
                failCount,
                status: successCount ? "成功" : "失败",
                images: logImages,
            });
            const loggedIn = Boolean(useAuthStore.getState().user);
            const logWithSync: GenerationLog = { ...log, cloudSync: successCount ? (loggedIn ? "pending" : "skipped") : undefined };
            saveLog(logWithSync);
            setLogs((value) => {
                const exists = value.some((item) => item.id === logWithSync.id);
                return exists ? value.map((item) => (item.id === logWithSync.id ? logWithSync : item)) : [logWithSync, ...value];
            });
            if (successCount) {
                message.success("图片已生成");
                if (loggedIn) {
                    void syncImageLogToCloud(logWithSync).then((next) => {
                        saveLog(next);
                        setLogs((value) => value.map((item) => (item.id === next.id ? next : item)));
                        if (next.cloudSync === "synced") {
                            message.success("已同步到云端历史");
                            setCloudRefreshKey((value) => value + 1);
                            void useAuthStore.getState().refreshUsage();
                        } else if (next.cloudSync === "failed") {
                            const detail = next.cloudError || "";
                            if (isStorageQuotaError({ message: detail, reason: next.cloudErrorReason })) {
                                message.warning("云端空间不足，请删除部分云端历史后重试");
                            } else {
                                message.warning(detail ? `云端同步失败：${detail}` : "云端同步失败，可在本机记录中重试");
                            }
                        }
                    });
                } else {
                    message.info("登录后可将结果同步到云端，跨设备回看", 2.5);
                }
            } else {
                message.error(batchResult.firstError || "生成失败");
            }
        } finally {
            setRunning(false);
        }
    };

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        try {
            // 已有本地 storageKey：直接复用，不要再去拉 imgen 远程地址
            if (image.storageKey) {
                const localUrl = await resolveImageUrl(image.storageKey, image.dataUrl);
                if (localUrl && (localUrl.startsWith("blob:") || localUrl.startsWith("data:"))) {
                    setReferences((value) => [
                        ...value,
                        {
                            id: nanoid(),
                            name: `result-${index + 1}.png`,
                            type: image.mimeType || "image/png",
                            dataUrl: localUrl,
                            storageKey: image.storageKey,
                        },
                    ]);
                    message.success("已加入参考图");
                    return;
                }
            }

            // 远程临时图：尝试本地下载；失败则明确提示
            if (/^https?:\/\//i.test(image.dataUrl)) {
                try {
                    const stored = await uploadImage(image.dataUrl);
                    if (!stored.storageKey && stored.remote) {
                        message.error("这张生成图是远程临时地址，浏览器读不到内容，无法作为参考图。请先下载到本地再上传");
                        return;
                    }
                    setReferences((value) => [
                        ...value,
                        {
                            id: nanoid(),
                            name: `result-${index + 1}.png`,
                            type: stored.mimeType || image.mimeType || "image/png",
                            dataUrl: stored.url,
                            storageKey: stored.storageKey,
                        },
                    ]);
                    message.success("已加入参考图");
                    return;
                } catch {
                    message.error("无法读取该生成图（远程地址 CORS/网络限制）。请下载后重新上传本地图片再生成");
                    return;
                }
            }

            const stored = await uploadImage(image.dataUrl);
            setReferences((value) => [
                ...value,
                {
                    id: nanoid(),
                    name: `result-${index + 1}.png`,
                    type: stored.mimeType || image.mimeType || "image/png",
                    dataUrl: stored.url,
                    storageKey: stored.storageKey,
                },
            ]);
            message.success("已加入参考图");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加入参考图失败");
        }
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        try {
            // 1) 已有本地副本：直接进本机素材，与是否上云无关
            if (image.storageKey) {
                const localUrl = await resolveImageUrl(image.storageKey, image.dataUrl);
                addAsset({
                    kind: "image",
                    title: `生成结果 ${index + 1}`,
                    coverUrl: localUrl || image.dataUrl,
                    tags: [],
                    source: "生图工作台",
                    data: {
                        dataUrl: localUrl || image.dataUrl,
                        storageKey: image.storageKey,
                        width: image.width,
                        height: image.height,
                        bytes: image.bytes,
                        mimeType: image.mimeType || "image/png",
                    },
                    metadata: { source: "image-page", prompt },
                });
                message.success("已加入我的素材（本机）");
                return;
            }

            // 2) 远程 imgen 等：uploadImage 会尝试 CORS → ai-proxy → 登录后服务端拉取
            const stored = await uploadImage(image.dataUrl);
            if (!stored.storageKey && stored.remote) {
                message.error("这张生成图还不能进素材：远程临时地址浏览器读不到。请先登录后重试（服务端可代拉），或下载后本地导入");
                return;
            }
            addAsset({
                kind: "image",
                title: `生成结果 ${index + 1}`,
                coverUrl: stored.url,
                tags: [],
                source: "生图工作台",
                data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
                metadata: { source: "image-page", prompt },
            });
            message.success("已加入我的素材（本机）");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加入素材失败");
        }
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else {
            message.warning("生图工作台只能使用文本或图片素材");
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        setReferences([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const imageKeys = logs.filter((log) => selectedLogIds.includes(log.id)).flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        void Promise.all([deleteStoredImages(imageKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(refreshLogs);
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = (log: GenerationLog) => {
        void logStore.setItem(log.id, serializeLog(log)).then(refreshLogs);
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());

    const previewGenerationLog = async (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
        setResults(log.images.map((image) => ({ id: image.id, status: "success", image })));
    };

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请输入生图提示词");
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return null;
        }
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: [...references] };
    };

    const runGenerationBatch = async (snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }, count: number) => {
        const batchStartedAt = performance.now();
        // 优先一次请求拿齐 count；失败或数量不足时再串行补齐，避免并发触发 429。
        try {
            const generated = snapshot.references.length ? await requestEdit({ ...snapshot.config, count: String(count) }, snapshot.text, snapshot.references) : await requestGeneration({ ...snapshot.config, count: String(count) }, snapshot.text);
            const images: GeneratedImage[] = [];
            for (let index = 0; index < Math.min(generated.length, count); index += 1) {
                const image = generated[index];
                let dataUrl = image.dataUrl;
                let storageKey: string | undefined;
                let width = 0;
                let height = 0;
                let bytes = getDataUrlByteSize(image.dataUrl);
                try {
                    const stored = await uploadImage(image.dataUrl);
                    dataUrl = stored.url;
                    storageKey = stored.storageKey;
                    width = stored.width;
                    height = stored.height;
                    bytes = stored.bytes;
                } catch {
                    const meta = await readImageMeta(image.dataUrl);
                    width = meta.width;
                    height = meta.height;
                }
                if (!width || !height) {
                    const meta = await readImageMeta(dataUrl);
                    width = meta.width;
                    height = meta.height;
                }
                const nextImage: GeneratedImage = { id: image.id, dataUrl, storageKey, durationMs: performance.now() - batchStartedAt, width, height, bytes };
                setResults((value) => updateResultAt(value, index, { status: "success", image: nextImage }));
                images.push(nextImage);
            }
            if (images.length < count) {
                const { images: fallbackImages, firstError } = await runGenerationSlotsSerial(snapshot, images.length, count);
                return { images: [...images, ...fallbackImages], firstError: images.length || fallbackImages.length ? "" : firstError || "接口返回图片数量不足" };
            }
            return { images, firstError: "" };
        } catch (error) {
            const firstError = error instanceof Error ? error.message : "生成失败";
            const serial = await runGenerationSlotsSerial(snapshot, 0, count);
            return { images: serial.images, firstError: serial.images.length ? "" : serial.firstError || firstError };
        }
    };

    const runGenerationSlotsSerial = async (snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }, startIndex: number, count: number) => {
        const images: GeneratedImage[] = [];
        let firstError = "";
        for (let index = startIndex; index < count; index += 1) {
            try {
                images.push(await runGenerationSlot(index, snapshot));
            } catch (error) {
                if (!firstError) firstError = error instanceof Error ? error.message : "生成失败";
            }
        }
        return { images, firstError };
    };

    const runGenerationSlot = async (index: number, snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }) => {
        const itemStartedAt = performance.now();
        try {
            const result = snapshot.references.length ? await requestEdit(snapshot.config, snapshot.text, snapshot.references) : await requestGeneration(snapshot.config, snapshot.text);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            let dataUrl = image.dataUrl;
            let storageKey: string | undefined;
            let width = 0;
            let height = 0;
            let bytes = getDataUrlByteSize(image.dataUrl);
            try {
                const stored = await uploadImage(image.dataUrl);
                dataUrl = stored.url;
                storageKey = stored.storageKey;
                width = stored.width;
                height = stored.height;
                bytes = stored.bytes;
            } catch {
                const meta = await readImageMeta(image.dataUrl);
                width = meta.width;
                height = meta.height;
            }
            if (!width || !height) {
                const meta = await readImageMeta(dataUrl);
                width = meta.width;
                height = meta.height;
            }
            const nextImage: GeneratedImage = { id: image.id, dataUrl, storageKey, durationMs: performance.now() - itemStartedAt, width, height, bytes };
            setResults((value) => updateResultAt(value, index, { status: "success", image: nextImage }));
            return nextImage;
        } catch (error) {
            setResults((value) => updateResultAt(value, index, { status: "failed", error: error instanceof Error ? error.message : "生成失败" }));
            throw error;
        }
    };

    const retryCloudSync = (log: GenerationLog) => {
        if (!cloudUser) {
            message.warning("请先登录后再同步到云端");
            return;
        }
        const pending = { ...log, cloudSync: "pending" as const, cloudError: undefined };
        saveLog(pending);
        setLogs((value) => value.map((item) => (item.id === pending.id ? pending : item)));
        void syncImageLogToCloud(pending).then((next) => {
            saveLog(next);
            setLogs((value) => value.map((item) => (item.id === next.id ? next : item)));
            if (next.cloudSync === "synced") {
                message.success("已同步到云端历史");
                setCloudRefreshKey((value) => value + 1);
            } else if (next.cloudSync === "failed") {
                message.error(next.cloudError || "云端同步失败");
            }
        });
    };

    const retryResult = (index: number) => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setPreviewLog(null);
        setResults((value) => updateResultAt(value, index, { status: "pending", error: undefined, image: undefined }));
        void runGenerationSlot(index, snapshot).catch(() => {});
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        historySource={historySource}
                        cloudEnabled={Boolean(cloudUser)}
                        cloudRefreshKey={cloudRefreshKey}
                        onHistorySourceChange={setHistorySource}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                        onRetryCloud={retryCloudSync}
                    />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">生图工作台</h1>
                                </div>
                                <div className="flex shrink-0 gap-2 lg:hidden">
                                    <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                        记录
                                    </Button>
                                    <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                        参数
                                    </Button>
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">提示词</span>
                                    <div className="flex flex-wrap justify-end gap-2">
                                        <Button size="small" icon={<WandSparkles className="size-3.5" />} loading={optimizingPrompt} disabled={!prompt.trim() || optimizingPrompt || running} onClick={() => void optimizePrompt()}>
                                            AI 优化
                                        </Button>
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            查看提示词库
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            查看我的素材
                                        </Button>
                                    </div>
                                </div>
                                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder="描述画面主体、风格、构图、光线和用途" disabled={optimizingPrompt} />
                                <div className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">AI 优化会使用当前文本模型，把简短描述扩写成更准确、美观的生图提示词。</div>
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">参考图</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            剪切板
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            上传
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className="hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-stone-300 p-2 pb-3 overscroll-x-contain dark:border-stone-700"
                                    onWheel={(event) => {
                                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label="移除参考图"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">暂无参考图</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    调整
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                            </div>
                        </div>

                        <div className="mt-auto space-y-2 pt-6">
                            <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
                                请求模式：{modelOptionLabel(effectiveConfig, model)} · {references.length ? "图生图 /v1/images/edits" : "文生图 /v1/images/generations"} · 参考图 {references.length} 张 · 生成 {generationCount} 张
                                <div className="mt-1 opacity-75">多张时优先一次请求；不足或失败时串行补齐，降低 429 风险。</div>
                            </div>
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running} onClick={() => void generate()}>
                                开始生成
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-xl font-semibold">生成结果</h2>
                            </div>
                            {running ? <Tag className="m-0 px-2 py-1">等待 {formatDuration(elapsedMs)}</Tag> : null}
                        </div>
                        {results.length ? (
                            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                {results.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "failed" ? (
                                        <FailedImageCard key={result.id} error={result.error || "生成失败"} onRetry={() => retryResult(index)} />
                                    ) : (
                                        <PendingImageCard key={result.id} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <ImagePlus className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成图片" />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title="生成记录" placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    historySource={historySource}
                    cloudEnabled={Boolean(cloudUser)}
                    cloudRefreshKey={cloudRefreshKey}
                    onHistorySourceChange={setHistorySource}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                    onRetryCloud={retryCloudSync}
                />
            </Drawer>
            <Drawer title="参数" placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} optimizeMode="image" />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除选中的 {selectedLogIds.length} 条生成记录吗？
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">模型</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <Image src={image.dataUrl} alt={`生成结果 ${index + 1}`} className="aspect-square object-cover" />
            <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-3 gap-2">
                    <Tooltip title="添加到素材">
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                            添加到素材
                        </Button>
                    </Tooltip>
                    <Tooltip title="加入参考图">
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                            加入参考图
                        </Button>
                    </Tooltip>
                    <Tooltip title="下载">
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            下载
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard() {
    return (
        <div className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>生成中</span>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">生成失败</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger onClick={onRetry}>
                    重试
                </Button>
            </div>
        </div>
    );
}

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    historySource = "local",
    cloudEnabled = false,
    cloudRefreshKey = 0,
    onHistorySourceChange,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
    onRetryCloud,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    historySource?: "local" | "cloud";
    cloudEnabled?: boolean;
    cloudRefreshKey?: number;
    onHistorySourceChange?: (value: "local" | "cloud") => void;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
    onRetryCloud?: (log: GenerationLog) => void;
}) {
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));
    const showCloud = historySource === "cloud";

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">生成记录</h2>
                </div>
                <Tag className="m-0">{showCloud ? "云端" : logs.length}</Tag>
            </div>
            {onHistorySourceChange ? (
                <div className="mb-3">
                    <Segmented
                        block
                        size="small"
                        value={historySource}
                        onChange={(value) => onHistorySourceChange(value as "local" | "cloud")}
                        options={[
                            { label: "本机", value: "local" },
                            { label: "云端", value: "cloud", disabled: !cloudEnabled },
                        ]}
                    />
                    {!cloudEnabled ? <div className="mt-1.5 text-[11px] text-stone-400">登录后可查看云端历史</div> : null}
                </div>
            ) : null}
            {showCloud ? (
                <CloudHistoryPanel type="image" refreshKey={cloudRefreshKey} />
            ) : (
                <>
                    <div className="mb-4 flex flex-wrap gap-2">
                        <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                            新建
                        </Button>
                        <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                            {allSelected ? "取消" : "全选"}
                        </Button>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                            删除
                        </Button>
                    </div>
                    <div className="space-y-3">
                        {logs.map((log) => (
                            <LogCard
                                key={log.id}
                                log={log}
                                selected={selectedLogIds.includes(log.id)}
                                active={activeLogId === log.id}
                                onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                                onClick={() => onPreviewLog(log)}
                                onRetryCloud={onRetryCloud}
                            />
                        ))}
                        {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">暂无生成记录</div> : null}
                    </div>
                </>
            )}
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick, onRetryCloud }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void; onRetryCloud?: (log: GenerationLog) => void }) {
    const thumbnails = (log.thumbnails || []).filter(Boolean).slice(0, 4);
    const syncLabel = cloudSyncLabel(log.cloudSync);

    return (
        <div
            role="button"
            tabIndex={0}
            className={`block w-full cursor-pointer rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onClick();
                }
            }}
        >
            <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image, index) => (
                                    <img key={`${log.id}-${index}`} src={image} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                        {log.cloudSync === "failed" && onRetryCloud ? (
                            <div className="mt-2" onClick={(event) => event.stopPropagation()}>
                                <Button size="small" onClick={() => onRetryCloud(log)}>
                                    重试上云
                                </Button>
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <div className="flex gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                            成功 {log.successCount ?? log.imageCount}
                        </Tag>
                        {log.failCount ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                失败 {log.failCount}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.imageCount} 张</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                            {formatDuration(log.durationMs)}
                        </Tag>
                        {syncLabel ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={cloudSyncColor(log.cloudSync)}>
                                {syncLabel}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex justify-end">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.time}</Tag>
                    </div>
                </div>
            </div>
        </div>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "成功",
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
        cloudSync: normalizeCloudSyncStatus(log.cloudSync),
        cloudJobIds: Array.isArray(log.cloudJobIds) ? log.cloudJobIds.filter((id): id is string => typeof id === "string") : undefined,
        cloudError: typeof log.cloudError === "string" ? log.cloudError : undefined,
        cloudErrorReason: typeof log.cloudErrorReason === "string" ? log.cloudErrorReason : undefined,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
        thumbnails: [],
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}


async function syncImageLogToCloud(log: GenerationLog): Promise<GenerationLog> {
    if (!useAuthStore.getState().user) {
        return { ...log, cloudSync: "failed", cloudError: "未登录", cloudErrorReason: "auth_required" };
    }
    if (!log.images?.length) {
        return { ...log, cloudSync: "failed", cloudError: "没有可上传的图片", cloudErrorReason: undefined };
    }
    const saved = await Promise.all(
        log.images.map((image) =>
            saveImageToCloudDetailed({
                dataUrl: image.dataUrl,
                storageKey: image.storageKey,
                prompt: log.prompt,
                model: log.model,
                width: image.width,
                height: image.height,
                clientLocalId: image.id,
                params: { count: log.imageCount, size: log.size, quality: log.quality, localLogId: log.id },
            }),
        ),
    );
    const jobIds = saved.map((item) => item.job?.id).filter(Boolean) as string[];
    if (!jobIds.length) {
        const first = saved.find((item) => item.error);
        return { ...log, cloudSync: "failed", cloudError: first?.error || "上传失败", cloudErrorReason: first?.reason };
    }
    return { ...log, cloudSync: "synced", cloudJobIds: jobIds, cloudError: undefined, cloudErrorReason: undefined };
}

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}
