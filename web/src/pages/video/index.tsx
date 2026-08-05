import { ArrowLeft, ArrowRight, BookOpen, ClipboardPaste, Download, FolderPlus, History, ImageIcon, LoaderCircle, Music2, Plus, Share2, SlidersHorizontal, Sparkles, Square, Trash2, Upload, VideoIcon, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { App, Button, Drawer, Empty, Image, Modal, Segmented, Switch, Tag, Typography } from "antd";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasPromptChipInput } from "@/components/canvas/canvas-prompt-chip-input";
import { SelectCheckbox } from "@/components/ui/select-checkbox";
import { ShareToWorkspaceModal, type ShareDraft } from "@/components/workspace/share-to-workspace-modal";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoModeGuideBanner } from "@/components/video-mode-guide-banner";
import { VideoSettingsPanel, normalizeVideoResolutionValue, videoSettingsSummary } from "@/components/video-settings-panel";
import { agnesVideoModeGuide, agnesVideoRequestError, isAgnesVideoConfig } from "@/lib/agnes-video";
import { suggestAssetCategory } from "@/lib/asset-category";
import { assetTitleFromPrompt } from "@/lib/asset-display";
import { canvasThemes } from "@/lib/canvas-theme";
import {
    clipboardImagesFromPasteEvent,
    isClipboardAsyncReadAvailable,
    readClipboardImageBlobs,
    shouldIgnoreClipboardPasteTarget,
} from "@/lib/clipboard-images";
import { grokEditVideoReferenceError, GROK_EDIT_REFERENCE_LIMITS, grokResolutionShortfallMessage, grokVideoModeGuide, isGrokVideoConfig, normalizeGrokResolution, videoResolutionDisplay } from "@/lib/grok-video";
import { useLiveElapsedMs } from "@/hooks/use-live-elapsed-ms";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import {
    isSoraOrVeoVideoConfig,
    isSoraVideoConfig,
    isVeoVideoConfig,
    soraVeoModeGuide,
    soraVeoReferenceImageLimit,
    soraVeoReferenceImageMaxBytes,
} from "@/lib/openai-compatible-video";
import { optimizeGenerationPrompt } from "@/lib/prompt-optimize";
import { workbenchVideoPromptReferences } from "@/lib/workbench-prompt-references";
import { clampVideoConfigToCapability } from "@/lib/model-capability";
import { boolConfig, isSeedanceVideoConfig, seedanceReferenceLabel, seedanceVideoReferenceError, seedanceVideoReferenceHint, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import {
    GENERIC_OPENAI_VIDEO_MODE_GUIDE,
    SEEDANCE_VIDEO_MODE_GUIDE,
    type VideoModeGuide,
} from "@/lib/video-mode-guide";
import { deleteStoredMedia, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { createVideoGenerationTask, pollVideoGenerationTask, rewritePrivateVideoUrlToLanRelay, storeGeneratedVideo, videoPollBudget, type VideoGenerationTask } from "@/services/api/video";
import { CloudHistoryPanel } from "@/components/cloud-history-panel";
import { cloudSyncColor, cloudSyncLabel, normalizeCloudSyncStatus, type CloudSyncStatus } from "@/lib/cloud-sync";
import { formatYuanFromCents, hasEnoughCredits, isPlatformVideoReady, platformVideoPriceCents } from "@/lib/platform-credits";
import { generatePlatformVideo, isStorageQuotaError } from "@/services/cloud-api";
import { saveVideoToCloudDetailed } from "@/services/cloud-history";
import { WORKSPACE_ITEM_KIND, WORKSPACE_ITEM_SOURCE } from "@/services/workspace-api";
import { useAssetStore } from "@/stores/use-asset-store";
import { useAuthStore } from "@/stores/use-auth-store";
import { isSameOriginRelayBaseUrl, modelOptionLabel, modelOptionName, resolveModelChannel, resolveModelScript, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type GeneratedVideo = {
    id: string;
    url: string;
    storageKey: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    video?: GeneratedVideo;
    error?: string;
    /** 用户所选清晰度（如 1080p）；用于结果区「实 vs 选」标注 */
    requestedResolution?: string;
    /** 创建成功 body 里的 resolution（可能已降档） */
    acceptedResolution?: string;
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
    videoReferences: ReferenceVideo[];
    audioReferences: ReferenceAudio[];
    durationMs: number;
    size: string;
    resolution: string;
    seconds: string;
    status: "生成中" | "成功" | "失败";
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
    cloudSync?: CloudSyncStatus;
    cloudJobIds?: string[];
    cloudError?: string;
    cloudErrorReason?: string;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "baseUrl" | "apiFormat"> & { channelId?: string; channelName?: string };

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:video_generation_logs";
const PLATFORM_VIDEO_PREF_KEY = "infinite-canvas:prefer_platform_video";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });

export default function VideoPage() {
    const { message } = App.useApp();
    const [searchParams, setSearchParams] = useSearchParams();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const activeLogIdsRef = useRef<Set<string>>(new Set());
    const latestVideoJobIdRef = useRef("");
    const videoJobControllersRef = useRef(new Map<string, AbortController>());
    const [, setActiveJobTick] = useState(0);
    const bumpActiveJobs = () => setActiveJobTick((value) => value + 1);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cloudUser = useAuthStore((state) => state.user);
    const credits = useAuthStore((state) => state.credits);
    const refreshUsage = useAuthStore((state) => state.refreshUsage);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [videoReferences, setVideoReferences] = useState<ReferenceVideo[]>([]);
    const [audioReferences, setAudioReferences] = useState<ReferenceAudio[]>([]);
    const promptReferences = useMemo(() => workbenchVideoPromptReferences(references, videoReferences, audioReferences), [references, videoReferences, audioReferences]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [optimizingPrompt, setOptimizingPrompt] = useState(false);
    const [referenceDragTarget, setReferenceDragTarget] = useState<"image" | "video" | "audio" | null>(null);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [historySource, setHistorySource] = useState<"local" | "cloud">("local");
    const [shareDrafts, setShareDrafts] = useState<ShareDraft[]>([]);
    const [shareOpen, setShareOpen] = useState(false);
    const [cloudRefreshKey, setCloudRefreshKey] = useState(0);
    const [preferPlatformVideo, setPreferPlatformVideo] = useState(() => {
        try {
            return localStorage.getItem(PLATFORM_VIDEO_PREF_KEY) === "1";
        } catch {
            return false;
        }
    });

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const textModel = effectiveConfig.textModel || effectiveConfig.model;
    const platformVideoReady = isPlatformVideoReady(cloudUser, credits);
    const usePlatformVideo = preferPlatformVideo && platformVideoReady;
    const videoPriceCents = platformVideoPriceCents(credits);
    const platformVideoModelLabel = credits?.video_model || "平台视频模型";

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
                const optimized = await optimizeGenerationPrompt(effectiveConfig, incoming, "video", {
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
    const videoRequestConfig = buildVideoConfig(effectiveConfig, model);
    const videoRequestChannel = resolveModelChannel(videoRequestConfig, model);
    const agnesMode = isAgnesVideoConfig(videoRequestConfig);
    const seedanceMode = isSeedanceVideoConfig(videoRequestConfig);
    const grokMode = isGrokVideoConfig(videoRequestConfig);
    const soraMode = isSoraVideoConfig(videoRequestConfig);
    const veoMode = isVeoVideoConfig(videoRequestConfig);
    const soraVeoMode = isSoraOrVeoVideoConfig(videoRequestConfig);
    const soraVeoImageMax = soraVeoMode ? soraVeoReferenceImageLimit(model) : SEEDANCE_REFERENCE_LIMITS.images;
    const soraVeoImageMaxBytes = soraVeoMode ? soraVeoReferenceImageMaxBytes(model) : SEEDANCE_REFERENCE_LIMITS.imageMaxBytes;
    const videoProviderLabel = agnesMode
        ? "Agnes Video"
        : seedanceMode
          ? "Seedance / Agent Plan"
          : grokMode
            ? "Grok Imagine"
            : soraMode
              ? "Sora /videos"
              : veoMode
                ? "Veo /videos"
                : "OpenAI /videos";
    const videoUsesCustomScript = Boolean(resolveModelScript(effectiveConfig, model));
    const videoReadinessWarning = getVideoReadinessWarning(videoRequestConfig, model);
    const referenceModeGuide: VideoModeGuide = agnesMode
        ? agnesVideoModeGuide
        : seedanceMode
          ? SEEDANCE_VIDEO_MODE_GUIDE
          : grokMode
            ? grokVideoModeGuide
            : soraVeoMode
              ? soraVeoModeGuide
              : GENERIC_OPENAI_VIDEO_MODE_GUIDE;
    const canGenerate = Boolean(prompt.trim());

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    const addReferences = async (files?: FileList | null) => {
        const selectedFiles = Array.from(files || []);
        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/") && !file.type.startsWith("video/") && !isSupportedAudioFile(file));
        if (unsupported.length) message.warning("已忽略不支持的参考素材，请使用图片、mp4/mov 视频或 mp3/wav 音频");
        const imageMax = soraVeoMode ? soraVeoImageMax : SEEDANCE_REFERENCE_LIMITS.images;
        const imageMaxBytes = soraVeoMode ? soraVeoImageMaxBytes : SEEDANCE_REFERENCE_LIMITS.imageMaxBytes;
        const videoMax = grokMode ? GROK_EDIT_REFERENCE_LIMITS.videos : SEEDANCE_REFERENCE_LIMITS.videos;
        const videoMaxBytes = grokMode ? GROK_EDIT_REFERENCE_LIMITS.videoMaxBytes : SEEDANCE_REFERENCE_LIMITS.videoMaxBytes;
        const audioMax = SEEDANCE_REFERENCE_LIMITS.audios;
        const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/") && file.size <= imageMaxBytes).slice(0, Math.max(0, imageMax - references.length));
        const videoFiles = selectedFiles.filter((file) => file.type.startsWith("video/") && file.size <= videoMaxBytes).slice(0, Math.max(0, videoMax - videoReferences.length));
        const audioFiles = selectedFiles.filter((file) => isSupportedAudioFile(file) && file.size <= SEEDANCE_REFERENCE_LIMITS.audioMaxBytes).slice(0, audioMax - audioReferences.length);
        if (selectedFiles.some((file) => file.type.startsWith("image/") && file.size > imageMaxBytes)) {
            message.warning(soraVeoMode ? "已忽略超过 20MB 的参考图（Sora/Veo 上限）" : "已忽略超过 30MB 的参考图");
        }
        if (soraVeoMode && selectedFiles.some((file) => file.type.startsWith("image/")) && references.length >= imageMax) {
            message.warning(veoMode ? `Veo 图生视频最多 ${imageMax} 张参考图` : "Sora 图生视频只使用 1 张首帧参考图");
        }
        if (selectedFiles.some((file) => file.type.startsWith("video/") && file.size > videoMaxBytes)) {
            message.warning(grokMode ? "已忽略超过 100MB 的参考视频（Grok edits 上限）" : "已忽略超过 50MB 的参考视频");
        }
        if (selectedFiles.some((file) => isSupportedAudioFile(file) && file.size > SEEDANCE_REFERENCE_LIMITS.audioMaxBytes)) message.warning("已忽略超过 15MB 的参考音频");
        if (grokMode && selectedFiles.some((file) => file.type.startsWith("video/")) && videoReferences.length >= videoMax) {
            message.warning("Grok 视频编辑只支持 1 条参考视频");
        }
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        const nextVideoReferences = await Promise.all(
            videoFiles.map(async (file) => {
                const video = await uploadMediaFile(file, "video-reference");
                return { id: nanoid(), name: file.name, type: video.mimeType, url: video.url, storageKey: video.storageKey, bytes: video.bytes, width: video.width, height: video.height, durationMs: video.durationMs };
            }),
        );
        const nextAudioReferences = filterAudioReferencesByDuration(
            audioReferences,
            await Promise.all(
                audioFiles.map(async (file) => {
                    const audio = await uploadMediaFile(file, "audio-reference");
                    return { id: nanoid(), name: file.name, type: audio.mimeType, url: audio.url, storageKey: audio.storageKey, durationMs: audio.durationMs };
                }),
            ),
            message.warning,
        );
        setReferences((value) => [...value, ...nextReferences].slice(0, imageMax));
        setVideoReferences((value) => [...value, ...nextVideoReferences].slice(0, videoMax));
        setAudioReferences((value) => [...value, ...nextAudioReferences].slice(0, audioMax));
    };

    const handleReferenceDragEnter = (event: DragEvent<HTMLDivElement>, target: "image" | "video" | "audio") => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes("Files")) setReferenceDragTarget(target);
    };

    const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setReferenceDragTarget(null);
    };

    const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setReferenceDragTarget(null);
        void addReferences(event.dataTransfer.files);
    };

    const addReferenceImageBlobs = async (blobs: Array<Blob | File>, successPrefix = "已读取") => {
        if (!blobs.length) {
            message.error("剪切板里没有可读取的图片");
            return;
        }
        const imageMax = soraVeoMode ? soraVeoImageMax : SEEDANCE_REFERENCE_LIMITS.images;
        const available = Math.max(0, imageMax - references.length);
        if (!available) {
            message.warning(`当前最多 ${imageMax} 张参考图`);
            return;
        }
        if (blobs.length > available) message.warning(`当前最多 ${imageMax} 张参考图，超出的图片未加入`);
        const nextReferences = await Promise.all(
            blobs.slice(0, available).map(async (blob, index) => {
                const image = await uploadImage(blob);
                const name = blob instanceof File && blob.name ? blob.name : `clipboard-${index + 1}.png`;
                return { id: nanoid(), name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences].slice(0, imageMax));
        message.success(`${successPrefix} ${nextReferences.length} 张参考图`);
    };

    const addReferencesFromClipboard = async () => {
        try {
            if (!isClipboardAsyncReadAvailable()) {
                message.warning("当前为 HTTP 页面，请在参考图区域按 Ctrl+V 粘贴截图，或改用上传/拖拽");
                return;
            }
            const blobs = await readClipboardImageBlobs();
            await addReferenceImageBlobs(blobs);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "剪切板里没有可读取的图片");
        }
    };

    // HTTP (server IP:port) cannot use clipboard.read(); paste events still carry images.
    const addReferenceImageBlobsRef = useRef(addReferenceImageBlobs);
    addReferenceImageBlobsRef.current = addReferenceImageBlobs;
    useEffect(() => {
        const onPaste = (event: ClipboardEvent) => {
            const files = clipboardImagesFromPasteEvent(event);
            if (!files.length) return;
            // Image paste can target the prompt field; still treat as reference upload.
            if (shouldIgnoreClipboardPasteTarget(event.target) && event.target instanceof HTMLInputElement) return;
            event.preventDefault();
            void addReferenceImageBlobsRef.current(files, "已粘贴");
        };
        window.addEventListener("paste", onPaste);
        return () => window.removeEventListener("paste", onPaste);
    }, []);

    const generate = async () => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setElapsedMs(0);
        setRunning(true);
        setPreviewLog(null);
        setResults([{ id: nanoid(), status: "pending" }]);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);
        try {
            if (snapshot.platform) {
                const platformJobId = nanoid();
                const controller = new AbortController();
                const platformPending = buildLog({
                    prompt: snapshot.text,
                    model: platformVideoModelLabel,
                    config: snapshot.config,
                    references: [],
                    videoReferences: [],
                    audioReferences: [],
                    durationMs: 0,
                    status: "生成中",
                });
                const platformLog: GenerationLog = { ...platformPending, id: platformJobId };
                latestVideoJobIdRef.current = platformJobId;
                activeLogIdsRef.current.add(platformJobId);
                videoJobControllersRef.current.set(platformJobId, controller);
                bumpActiveJobs();
                await saveLog(platformLog);
                setLogs((value) => [platformLog, ...value.filter((item) => item.id !== platformLog.id)]);
                try {
                    const platform = await generatePlatformVideo(
                        {
                            prompt: snapshot.text,
                            seconds: snapshot.config.videoSeconds,
                            size: snapshot.config.size,
                            clientLocalId: platformJobId,
                        },
                        { signal: controller.signal },
                    );
                    if (controller.signal.aborted) throw new DOMException("请求已取消", "AbortError");
                    const stored = platform.blob
                        ? await storeGeneratedVideo({ blob: platform.blob, mimeType: platform.mimeType }, snapshot.config)
                        : await storeGeneratedVideo({ url: platform.url, mimeType: platform.mimeType }, snapshot.config);
                    const nextVideo: GeneratedVideo = {
                        id: platform.job.id || nanoid(),
                        url: stored.url || platform.url,
                        storageKey: stored.storageKey || "",
                        durationMs: performance.now() - batchStartedAt,
                        width: platform.width || stored.width || 0,
                        height: platform.height || stored.height || 0,
                        bytes: platform.bytes || stored.bytes || 0,
                        mimeType: platform.mimeType || stored.mimeType || "video/mp4",
                    };
                    const loggedIn = Boolean(useAuthStore.getState().user);
                    const successLog: GenerationLog = {
                        ...platformLog,
                        status: "成功",
                        durationMs: performance.now() - batchStartedAt,
                        video: nextVideo,
                        error: undefined,
                        // Platform path already stored on server; mark local history as synced when logged in.
                        cloudSync: loggedIn ? "synced" : "skipped",
                        cloudJobIds: platform.job.id ? [platform.job.id] : undefined,
                        cloudError: undefined,
                        cloudErrorReason: undefined,
                    };
                    await saveLog(successLog);
                    setLogs((value) => value.map((item) => (item.id === successLog.id ? successLog : item)));
                    if (latestVideoJobIdRef.current === platformJobId) {
                        setResults([
                            {
                                id: nextVideo.id,
                                status: "success",
                                video: nextVideo,
                                requestedResolution: platformLog.resolution || platformLog.config?.vquality || "",
                            },
                        ]);
                    }
                    message.success(platform.chargedCents ? `视频已生成（已扣 ${platform.chargedCents} 分）` : "视频已生成");
                    void refreshUsage();
                    if (loggedIn) setCloudRefreshKey((value) => value + 1);
                } catch (platformError) {
                    if (isAbortLikeError(platformError) || controller.signal.aborted) {
                        const cancelledLog: GenerationLog = {
                            ...platformLog,
                            status: "失败",
                            durationMs: performance.now() - batchStartedAt,
                            error: "已停止生成",
                        };
                        await saveLog(cancelledLog);
                        setLogs((value) => value.map((item) => (item.id === cancelledLog.id ? cancelledLog : item)));
                        if (latestVideoJobIdRef.current === platformJobId) setResults([{ id: platformJobId, status: "failed", error: "已停止生成" }]);
                        message.info("已停止该任务");
                    } else {
                        const errorMessage = platformError instanceof Error ? platformError.message : "生成失败";
                        const failedLog: GenerationLog = { ...platformLog, status: "失败", durationMs: performance.now() - batchStartedAt, error: errorMessage };
                        await saveLog(failedLog);
                        setLogs((value) => value.map((item) => (item.id === failedLog.id ? failedLog : item)));
                        if (latestVideoJobIdRef.current === platformJobId) setResults([{ id: platformJobId, status: "failed", error: errorMessage }]);
                        message.error(errorMessage);
                    }
                } finally {
                    activeLogIdsRef.current.delete(platformJobId);
                    videoJobControllersRef.current.delete(platformJobId);
                    bumpActiveJobs();
                    if (!activeLogIdsRef.current.size) {
                        setRunning(false);
                        setStartedAt(0);
                    }
                }
                return;
            }
            const createController = new AbortController();
            // Temporary key until log id exists; create request can still be stopped via latest placeholder.
            const createJobKey = `create:${nanoid()}`;
            videoJobControllersRef.current.set(createJobKey, createController);
            bumpActiveJobs();
            try {
                const task = await createVideoGenerationTask(snapshot.config, snapshot.text, snapshot.references, snapshot.videoReferences, snapshot.audioReferences, { signal: createController.signal });
                if (createController.signal.aborted) throw new DOMException("请求已取消", "AbortError");
                const log = buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, videoReferences: snapshot.videoReferences, audioReferences: snapshot.audioReferences, durationMs: 0, status: "生成中", task });
                latestVideoJobIdRef.current = log.id;
                // Move controller ownership from create key to real log id.
                videoJobControllersRef.current.delete(createJobKey);
                videoJobControllersRef.current.set(log.id, createController);
                await saveLog(log);
                // saveLog refreshes from storage; also prepend optimistically so left list updates even if storage is slow.
                setLogs((value) => [log, ...value.filter((item) => item.id !== log.id)]);
                void pollGenerationLog(log, snapshot.config, createController);
            } catch (createError) {
                videoJobControllersRef.current.delete(createJobKey);
                bumpActiveJobs();
                if (isAbortLikeError(createError) || createController.signal.aborted) {
                    setResults([{ id: nanoid(), status: "failed", error: "已停止生成" }]);
                    message.info("已停止该任务");
                } else {
                    const errorMessage = createError instanceof Error ? createError.message : "生成失败";
                    setResults([{ id: nanoid(), status: "failed", error: errorMessage }]);
                    await saveLog(buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, videoReferences: snapshot.videoReferences, audioReferences: snapshot.audioReferences, durationMs: performance.now() - batchStartedAt, status: "失败", error: errorMessage }));
                    message.error(errorMessage);
                }
                if (!activeLogIdsRef.current.size) {
                    setRunning(false);
                    setStartedAt(0);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "生成失败";
            setResults([{ id: nanoid(), status: "failed", error: errorMessage }]);
            await saveLog(buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, videoReferences: snapshot.videoReferences, audioReferences: snapshot.audioReferences, durationMs: performance.now() - batchStartedAt, status: "失败", error: errorMessage }));
            message.error(errorMessage);
            if (!activeLogIdsRef.current.size) {
                setRunning(false);
                setStartedAt(0);
            }
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
            const optimized = await optimizeGenerationPrompt(effectiveConfig, text, "video", {
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

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请输入视频提示词");
            return null;
        }
        if (usePlatformVideo) {
            if (references.length || videoReferences.length || audioReferences.length) {
                message.warning("平台积分视频当前仅支持文生视频，请清空参考素材，或关闭「平台积分生视频」");
                return null;
            }
            if (!hasEnoughCredits(credits?.balance_cents, videoPriceCents, 1)) {
                message.error(`积分不足：约需 ${formatYuanFromCents(videoPriceCents)}，当前 ${formatYuanFromCents(credits?.balance_cents)}`);
                return null;
            }
            return {
                text,
                config: videoRequestConfig,
                references: [] as ReferenceImage[],
                videoReferences: [] as ReferenceVideo[],
                audioReferences: [] as ReferenceAudio[],
                platform: true as const,
            };
        }
        const warning = getVideoReadinessWarning(videoRequestConfig, model);
        if (warning) {
            message.warning(warning);
            openConfigDialog(true);
            return null;
        }
        const agnesReferenceError = agnesMode ? agnesVideoRequestError(videoRequestConfig, references, videoReferences, audioReferences) : "";
        if (agnesReferenceError) {
            message.error(agnesReferenceError);
            return null;
        }
        if (grokMode && videoReferences.length) {
            if (audioReferences.length) {
                message.error("Grok 视频编辑暂不支持参考音频，请移除音频后重试");
                return null;
            }
            if (references.length) {
                message.error("Grok 不能同时使用参考图与参考视频：请只保留参考视频（edits）或只保留参考图（generation）");
                return null;
            }
            const grokVideoError = grokEditVideoReferenceError(videoReferences);
            if (grokVideoError) {
                message.error(grokVideoError);
                return null;
            }
        } else if (!seedanceMode && !agnesMode && (videoReferences.length || audioReferences.length)) {
            message.error("当前模型/渠道不是 Seedance 2.0、火山 Agent Plan 或支持 edits 的 Grok 中转，不能使用参考视频或参考音频，请切换视频模型或移除这些参考素材");
            return null;
        }
        const videoReferenceError = seedanceMode ? seedanceVideoReferenceError(videoReferences) : "";
        if (videoReferenceError) {
            message.error(`${videoReferenceError}。${seedanceVideoReferenceHint}`);
            return null;
        }
        return { text, config: videoRequestConfig, references: [...references], videoReferences: [...videoReferences], audioReferences: [...audioReferences], platform: false as const };
    };

    const retryResult = () => {
        void generate();
    };

    const downloadVideo = (video: GeneratedVideo) => {
        saveAs(video.url, "video.mp4");
    };

    const saveResultToAssets = (video: GeneratedVideo) => {
        const generationPrompt = prompt.trim();
        const title = assetTitleFromPrompt(generationPrompt, "生成视频");
        addAsset({
            kind: "video",
            title,
            coverUrl: "",
            category: suggestAssetCategory({ title, source: "视频创作台", prompt: generationPrompt, kind: "video" }),
            tags: [],
            source: "视频创作台",
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "video-page", prompt: generationPrompt },
        });
        message.success("已加入我的资产");
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) =>
                [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }].slice(
                    0,
                    soraVeoMode ? soraVeoImageMax : SEEDANCE_REFERENCE_LIMITS.images,
                ),
            );
        } else if (payload.kind === "video") {
            setVideoReferences((value) => [...value, { id: nanoid(), name: payload.title, type: "video/mp4", url: payload.url, storageKey: payload.storageKey, width: payload.width, height: payload.height }].slice(0, SEEDANCE_REFERENCE_LIMITS.videos));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        setReferences([]);
        setVideoReferences([]);
        setAudioReferences([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const mediaKeys = logs
            .filter((log) => selectedLogIds.includes(log.id))
            .map((log) => log.video?.storageKey)
            .filter((key): key is string => Boolean(key));
        void Promise.all([deleteStoredMedia(mediaKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(refreshLogs);
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = async (log: GenerationLog) => {
        await logStore.setItem(log.id, serializeLog(log));
        await refreshLogs();
    };

    const refreshLogs = async () => {
        const nextLogs = await readStoredLogs();
        setLogs(nextLogs);
        resumePendingLogs(nextLogs);
        return nextLogs;
    };

    const resumePendingLogs = (items: GenerationLog[]) => {
        for (const log of items) {
            if (log.status === "生成中" && log.task) void pollGenerationLog(log);
        }
    };

    const stopVideoJob = (jobId: string) => {
        const controller = videoJobControllersRef.current.get(jobId);
        if (!controller) {
            // Stale "生成中" after refresh: mark failed so UI is not stuck forever.
            const pending = logs.find((item) => item.id === jobId && item.status === "生成中");
            if (pending) {
                void saveLog({ ...pending, status: "失败", error: "已停止生成", durationMs: Date.now() - pending.createdAt }).then(() => {
                    setLogs((value) => value.map((item) => (item.id === jobId ? { ...item, status: "失败", error: "已停止生成" } : item)));
                });
                if (latestVideoJobIdRef.current === jobId) setResults([{ id: jobId, status: "failed", error: "已停止生成" }]);
                message.info("已标记停止（当前会话无活跃请求）");
                return;
            }
            message.info("该任务已结束或不可停止");
            return;
        }
        if (!controller.signal.aborted) controller.abort();
        message.info("正在停止该任务…");
    };

    const stopLatestVideoJob = () => {
        const jobId = latestVideoJobIdRef.current;
        if (jobId && videoJobControllersRef.current.has(jobId)) {
            stopVideoJob(jobId);
            return;
        }
        // Create phase: controller may still use create:* key.
        const createEntry = Array.from(videoJobControllersRef.current.entries()).find(([id]) => id.startsWith("create:"));
        if (createEntry) {
            if (!createEntry[1].signal.aborted) createEntry[1].abort();
            message.info("正在停止该任务…");
            return;
        }
        message.info("当前没有可停止的生成任务");
    };

    const pollGenerationLog = async (log: GenerationLog, configOverride?: AiConfig, existingController?: AbortController) => {
        if (!log.task || activeLogIdsRef.current.has(log.id)) return;
        activeLogIdsRef.current.add(log.id);
        const controller = existingController || videoJobControllersRef.current.get(log.id) || new AbortController();
        videoJobControllersRef.current.set(log.id, controller);
        bumpActiveJobs();
        setRunning(true);
        setStartedAt((value) => value || performance.now());
        setResults((value) => (value.length ? value : [{ id: log.id, status: "pending" }]));
        const taskConfig = buildVideoConfig(configWithLogConfig(effectiveConfig, log.config), log.task.model || log.model);
        const pollingConfig = configOverride || taskConfig;
        try {
            const warning = getVideoReadinessWarning(pollingConfig, log.task.model || log.model);
            if (warning) throw new Error(`无法继续查询历史任务：${warning}`);
            const budget = videoPollBudget(log.task);
            for (let attempt = 0; attempt < budget.maxAttempts; attempt += 1) {
                if (controller.signal.aborted) throw new DOMException("请求已取消", "AbortError");
                const state = await pollVideoGenerationTask(pollingConfig, log.task, { signal: controller.signal });
                if (controller.signal.aborted) throw new DOMException("请求已取消", "AbortError");
                if (state.status === "completed") {
                    const stored = await storeGeneratedVideo(state.result, pollingConfig);
                    const nextVideo: GeneratedVideo = {
                        id: nanoid(),
                        url: stored.url,
                        storageKey: stored.storageKey,
                        durationMs: Date.now() - log.createdAt,
                        width: stored.width || 1280,
                        height: stored.height || 720,
                        bytes: stored.bytes,
                        mimeType: stored.mimeType,
                    };
                    const requestedResolution = log.task?.requestedResolution || pollingConfig.vquality || log.config?.vquality || log.resolution || "";
                    const acceptedResolution = log.task?.acceptedResolution;
                    if (latestVideoJobIdRef.current === log.id) {
                        setResults([
                            {
                                id: nextVideo.id,
                                status: "success",
                                video: nextVideo,
                                requestedResolution,
                                acceptedResolution,
                            },
                        ]);
                    }
                    const loggedIn = Boolean(useAuthStore.getState().user);
                    const successLog: GenerationLog = {
                        ...log,
                        status: "成功",
                        durationMs: nextVideo.durationMs,
                        video: nextVideo,
                        error: undefined,
                        cloudSync: loggedIn ? "pending" : "skipped",
                        cloudError: undefined,
                    };
                    await saveLog(successLog);
                    setLogs((value) => value.map((item) => (item.id === successLog.id ? successLog : item)));
                    const shortfall = isGrokVideoConfig(pollingConfig)
                        ? grokResolutionShortfallMessage(requestedResolution, nextVideo.width, nextVideo.height, acceptedResolution)
                        : "";
                    if (shortfall) {
                        message.warning(shortfall, 8);
                    } else {
                        message.success(stored.storageKey ? "视频已生成" : "视频已生成（经代理预览）");
                    }
                    if (loggedIn) {
                        void syncVideoLogToCloud(successLog).then(async (next) => {
                            await saveLog(next);
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
                    return;
                }
                if (state.status === "failed") throw new Error(state.error);
                if (attempt === budget.maxAttempts - 1) {
                    throw new Error(
                        `${budget.timeoutLabel}视频生成超时，请稍后重试` + (budget.isSoraVeo ? "（中转排队较慢时可到历史记录里继续查询）" : ""),
                    );
                }
                await delay(budget.delayMs, controller.signal);
            }
        } catch (error) {
            if (isAbortLikeError(error) || controller.signal.aborted) {
                if (latestVideoJobIdRef.current === log.id) setResults([{ id: log.id, status: "failed", error: "已停止生成" }]);
                await saveLog({ ...log, status: "失败", durationMs: Date.now() - log.createdAt, error: "已停止生成" });
                setLogs((value) => value.map((item) => (item.id === log.id ? { ...item, status: "失败", error: "已停止生成" } : item)));
                message.info("已停止该任务");
            } else {
                const errorMessage = error instanceof Error ? error.message : "生成失败";
                if (latestVideoJobIdRef.current === log.id) setResults([{ id: log.id, status: "failed", error: errorMessage }]);
                await saveLog({ ...log, status: "失败", durationMs: Date.now() - log.createdAt, error: errorMessage });
                message.error(errorMessage);
            }
        } finally {
            activeLogIdsRef.current.delete(log.id);
            videoJobControllersRef.current.delete(log.id);
            bumpActiveJobs();
            if (!activeLogIdsRef.current.size) {
                setRunning(false);
                setStartedAt(0);
            }
        }
    };

    const openShareLogs = (targetLogs: GenerationLog[]) => {
        if (!cloudUser) {
            message.info("登录后可将生成结果分享到工作空间");
            return;
        }
        const drafts: ShareDraft[] = [];
        for (const log of targetLogs) {
            if (log.status !== "成功" || !log.video) continue;
            const video = log.video;
            if (!video.storageKey && !video.url) continue;
            drafts.push({
                kind: WORKSPACE_ITEM_KIND.GEN_VIDEO,
                title: log.title || assetTitleFromPrompt(log.prompt, "生成视频"),
                prompt: log.prompt,
                model: log.model || log.config.videoModel || log.config.model,
                storageKey: video.storageKey,
                mediaUrl: video.url,
                width: video.width,
                height: video.height,
                bytes: video.bytes,
                mime: video.mimeType,
                sourceType: WORKSPACE_ITEM_SOURCE.WORKBENCH_LOCAL,
                sourceRef: `${log.id}:${video.id}`,
                filename: `${log.title || "video"}.mp4`,
            });
        }
        if (!drafts.length) {
            message.warning("所选记录没有可分享的本地视频（需成功且可读）");
            return;
        }
        setShareDrafts(drafts);
        setShareOpen(true);
    };

    const retryCloudSync = (log: GenerationLog) => {
        if (!cloudUser) {
            message.warning("请先登录后再同步到云端");
            return;
        }
        const pending = { ...log, cloudSync: "pending" as const, cloudError: undefined };
        void saveLog(pending).then(() => setLogs((value) => value.map((item) => (item.id === pending.id ? pending : item))));
        void syncVideoLogToCloud(pending).then(async (next) => {
            await saveLog(next);
            setLogs((value) => value.map((item) => (item.id === next.id ? next : item)));
            if (next.cloudSync === "synced") {
                message.success("已同步到云端历史");
                setCloudRefreshKey((value) => value + 1);
            } else if (next.cloudSync === "failed") {
                message.error(next.cloudError || "云端同步失败");
            }
        });
    };

    const previewGenerationLog = (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        setVideoReferences(log.videoReferences || []);
        setAudioReferences(log.audioReferences || []);
        if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.vquality) updateConfig("vquality", log.config.vquality);
        if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
        if (log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", log.config.videoGenerateAudio);
        if (log.config.videoWatermark) updateConfig("videoWatermark", log.config.videoWatermark);
        setResults(
            log.status === "生成中"
                ? [{ id: log.id, status: "pending" }]
                : log.video
                  ? [
                        {
                            id: log.video.id,
                            status: "success",
                            video: log.video,
                            requestedResolution: log.task?.requestedResolution || log.resolution || log.config?.vquality || "",
                            acceptedResolution: log.task?.acceptedResolution,
                        },
                    ]
                  : [{ id: log.id, status: "failed", error: log.error || "生成失败" }],
        );
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel logs={logs} selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} historySource={historySource} cloudEnabled={Boolean(cloudUser)} cloudRefreshKey={cloudRefreshKey} onHistorySourceChange={setHistorySource} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={() => setDeleteConfirmOpen(true)} onPreviewLog={previewGenerationLog} onRetryCloud={retryCloudSync} onShareSelected={() => openShareLogs(logs.filter((log) => selectedLogIds.includes(log.id)))} onShareLog={(log) => openShareLogs([log])} onStopLog={stopVideoJob} stoppableLogIds={Array.from(new Set([...activeLogIdsRef.current, ...videoJobControllersRef.current.keys()]))} />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">视频创作台</h1>
                                <div className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {videoRequestChannel.name} · {videoProviderLabel}
                                </div>
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

                        <VideoModeGuideBanner guide={referenceModeGuide} warning={videoReadinessWarning} />

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
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} title="从我的资产或工作空间导入" onClick={() => setAssetPickerOpen(true)}>
                                            我的资产
                                        </Button>
                                    </div>
                                </div>
                                <CanvasPromptChipInput
                                    value={prompt}
                                    references={promptReferences}
                                    onChange={setPrompt}
                                    disabled={optimizingPrompt}
                                    placeholder="描述镜头运动、主体动作、场景氛围和画面风格；有参考素材时可输入 @ 选择"
                                    className="min-h-42 max-h-70 w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
                                />
                                <div className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">AI 优化会使用当前文本模型，补全镜头运动、动作节奏与画面风格；若描述像人物/场景/分镜，会按对应生产维度增强。</div>
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">参考图</span>
                                    <div className="flex gap-2">
                                        <Button
                                            size="small"
                                            icon={<ClipboardPaste className="size-3.5" />}
                                            title={isClipboardAsyncReadAvailable() ? "从系统剪切板读取图片" : "HTTP 下请用 Ctrl+V 粘贴到参考图区域"}
                                            onClick={() => void addReferencesFromClipboard()}
                                        >
                                            剪切板
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            上传
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${referenceDragTarget === "image" ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => handleReferenceDragEnter(event, "image")}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            {item.dataUrl ? (
                                                <Image
                                                    src={item.dataUrl}
                                                    alt={item.name}
                                                    className="size-full object-cover"
                                                    classNames={{ root: "block size-full", image: "size-full object-cover" }}
                                                    styles={{ root: { width: "100%", height: "100%", display: "block" }, image: { width: "100%", height: "100%", objectFit: "cover" } }}
                                                    preview={{ mask: "预览" }}
                                                />
                                            ) : (
                                                <div className="flex size-full items-center justify-center bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-500">
                                                    <ImageIcon className="size-5" />
                                                </div>
                                            )}
                                            <span className="pointer-events-none absolute left-1 top-1 z-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{seedanceReferenceLabel("image", index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button type="button" className="absolute right-1 top-1 z-2 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))} aria-label="移除参考图">
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? (
                                        <div className="flex min-w-full items-center justify-center text-sm text-stone-500">
                                            {referenceDragTarget === "image"
                                                ? "松开即可上传参考资产"
                                                : soraVeoMode
                                                  ? veoMode
                                                      ? `暂无参考图，可拖入 / Ctrl+V；Veo 图生最多 ${soraVeoImageMax} 张`
                                                      : "暂无参考图，可拖入 / Ctrl+V；Sora 图生仅 1 张首帧"
                                                  : "暂无参考图，可拖入 / 上传 / Ctrl+V 粘贴，最多 9 张"}
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">参考视频</span>
                                    <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                        上传
                                    </Button>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${referenceDragTarget === "video" ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => handleReferenceDragEnter(event, "video")}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    {videoReferences.map((item, index) => (
                                        <div key={item.id} className="group relative h-20 w-32 shrink-0 overflow-hidden rounded-md border border-stone-200 bg-black dark:border-stone-800">
                                            {item.url ? (
                                                <video src={item.url} className="size-full object-cover" muted preload="metadata" />
                                            ) : (
                                                <div className="flex size-full items-center justify-center text-stone-400">
                                                    <VideoIcon className="size-5" />
                                                </div>
                                            )}
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{seedanceReferenceLabel("video", index)}</span>
                                            <ReferenceOrderButtons index={index} total={videoReferences.length} onMove={(offset) => setVideoReferences((value) => moveListItem(value, index, offset))} />
                                            <button type="button" className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => setVideoReferences((value) => value.filter((ref) => ref.id !== item.id))} aria-label="移除参考视频">
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!videoReferences.length ? (
                                        <div className="flex min-w-full items-center justify-center text-sm text-stone-500">
                                            {referenceDragTarget === "video" ? "松开即可上传参考资产" : `暂无参考视频，可拖入文件，最多 ${grokMode ? 1 : 3} 个${grokMode ? "（Grok edits）" : ""}`}
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">参考音频</span>
                                    <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                        上传
                                    </Button>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${referenceDragTarget === "audio" ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => handleReferenceDragEnter(event, "audio")}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    {audioReferences.map((item, index) => (
                                        <div key={item.id} className="group relative flex h-20 w-48 shrink-0 flex-col justify-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-2 dark:border-stone-800 dark:bg-stone-900">
                                            <div className="flex min-w-0 items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                                                <Music2 className="size-4 shrink-0" />
                                                <span className="shrink-0 rounded bg-stone-200 px-1 text-[10px] text-stone-700 dark:bg-stone-800 dark:text-stone-200">{seedanceReferenceLabel("audio", index)}</span>
                                                <span className="truncate">{item.name}</span>
                                            </div>
                                            {item.url ? <audio src={item.url} controls className="h-8 w-full" preload="metadata" /> : <div className="h-8 rounded bg-stone-200/70 text-center text-xs leading-8 text-stone-500 dark:bg-stone-800">音频预览不可用</div>}
                                            <ReferenceOrderButtons index={index} total={audioReferences.length} onMove={(offset) => setAudioReferences((value) => moveListItem(value, index, offset))} />
                                            <button type="button" className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => setAudioReferences((value) => value.filter((ref) => ref.id !== item.id))} aria-label="移除参考音频">
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!audioReferences.length ? (
                                        <div className="flex min-w-full items-center justify-center text-center text-sm text-stone-500">
                                            {referenceDragTarget === "audio" ? "松开即可上传参考资产" : "暂无参考音频，可拖入文件，最多 3 个，mp3/wav，单个 15MB 内"}
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {videoSettingsSummary(videoRequestConfig)}
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
                            {platformVideoReady ? (
                                <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
                                    <div className="min-w-0">
                                        <div className="font-medium text-stone-800 dark:text-stone-100">平台积分生视频</div>
                                        <div className="mt-0.5 opacity-75">
                                            {platformVideoModelLabel}
                                            {videoPriceCents > 0 ? ` · 约 ${formatYuanFromCents(videoPriceCents)}/条` : " · 当前免费"}
                                            {" · "}余额 {formatYuanFromCents(credits?.balance_cents)}
                                            {" · "}仅文生视频
                                        </div>
                                    </div>
                                    <Switch
                                        checked={preferPlatformVideo}
                                        onChange={(checked) => {
                                            setPreferPlatformVideo(checked);
                                            try {
                                                localStorage.setItem(PLATFORM_VIDEO_PREF_KEY, checked ? "1" : "0");
                                            } catch {
                                                // ignore
                                            }
                                        }}
                                    />
                                </div>
                            ) : null}
                            <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
                                {usePlatformVideo
                                    ? `请求模式：平台代生成 /api/generate/video · ${platformVideoModelLabel} · OpenAI 兼容文生视频（成功后扣积分）`
                                    : `请求模式：${modelOptionLabel(effectiveConfig, model)} · ${videoUsesCustomScript ? "自定义调用脚本" : videoProviderLabel} · ${videoSettingsSummary(videoRequestConfig)}`}
                                {!usePlatformVideo && videoUsesCustomScript ? (
                                    <div className="mt-1 opacity-75">当前视频模型已配置本地调用脚本；脚本需自行完成创建与轮询。清空脚本后回退 Grok/Agnes/Seedance/OpenAI 默认路径。</div>
                                ) : null}
                            </div>
                            <div className="flex gap-2">
                                <Button type="primary" size="large" className="flex-1" icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={() => void generate()}>
                                    {running ? "再生成一条" : "开始生成"}
                                </Button>
                                {running ? (
                                    <Button size="large" danger icon={<Square className="size-4" />} onClick={stopLatestVideoJob}>
                                        停止
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <h2 className="text-xl font-semibold">生成结果</h2>
                            {running ? <Tag className="m-0 px-2 py-1">等待 {formatDuration(elapsedMs)}</Tag> : null}
                        </div>
                        {results.length ? (
                            <div className="grid gap-4">
                                {results.map((result) =>
                                    result.status === "success" && result.video ? (
                                        <ResultVideoCard
                                            key={result.id}
                                            video={result.video}
                                            requestedResolution={result.requestedResolution || effectiveConfig.vquality}
                                            acceptedResolution={result.acceptedResolution}
                                            onDownload={downloadVideo}
                                            onSaveAsset={saveResultToAssets}
                                        />
                                    ) : result.status === "failed" ? (
                                        <FailedVideoCard key={result.id} error={result.error || "生成失败"} onRetry={retryResult} />
                                    ) : (
                                        <PendingVideoCard key={result.id} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <VideoIcon className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成视频" />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title="生成记录" placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel logs={logs} selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} historySource={historySource} cloudEnabled={Boolean(cloudUser)} cloudRefreshKey={cloudRefreshKey} onHistorySourceChange={setHistorySource} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={() => setDeleteConfirmOpen(true)} onPreviewLog={previewGenerationLog} onRetryCloud={retryCloudSync} onShareSelected={() => openShareLogs(logs.filter((log) => selectedLogIds.includes(log.id)))} onShareLog={(log) => openShareLogs([log])} onStopLog={stopVideoJob} stoppableLogIds={Array.from(new Set([...activeLogIdsRef.current, ...videoJobControllersRef.current.keys()]))} />
            </Drawer>
            <Drawer title="参数" placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} optimizeMode="video" />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除选中的 {selectedLogIds.length} 条生成记录吗？
            </Modal>
            <ShareToWorkspaceModal
                open={shareOpen}
                drafts={shareDrafts}
                onClose={() => {
                    setShareOpen(false);
                    setShareDrafts([]);
                }}
            />
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const videoConfig = { ...config, model, videoModel: model };

    const onModelChange = (value: string) => {
        updateConfig("videoModel", value);
        const clamped = clampVideoConfigToCapability({ ...config, model: value, videoModel: value });
        if (clamped.size !== undefined) updateConfig("size", clamped.size);
        if (clamped.videoSeconds !== undefined) updateConfig("videoSeconds", clamped.videoSeconds);
        if (clamped.vquality !== undefined) updateConfig("vquality", clamped.vquality);
        if (clamped.videoGenerateAudio !== undefined) updateConfig("videoGenerateAudio", clamped.videoGenerateAudio);
        if (clamped.videoWatermark !== undefined) updateConfig("videoWatermark", clamped.videoWatermark);
    };

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">模型</span>
                <ModelPicker config={config} value={model} onChange={onModelChange} capability="video" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <VideoSettingsPanel config={videoConfig} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" />
            </div>
        </>
    );
}

function ResultVideoCard({
    video,
    requestedResolution,
    acceptedResolution,
    onDownload,
    onSaveAsset,
}: {
    video: GeneratedVideo;
    requestedResolution?: string;
    acceptedResolution?: string;
    onDownload: (video: GeneratedVideo) => void;
    onSaveAsset: (video: GeneratedVideo) => void;
}) {
    const [previewError, setPreviewError] = useState(false);
    const rawUrl = video.url || "";
    // 历史远程直链若是 127.0.0.1，尽量改写到 /lan-ai；真正可播仍依赖生成时已落盘 blob
    const lanUrl = rewritePrivateVideoUrlToLanRelay(rawUrl) || "";
    const playUrl = video.storageKey ? rawUrl : lanUrl || rawUrl;
    const isBlob = playUrl.startsWith("blob:") || Boolean(video.storageKey);
    const isLan = playUrl.includes("/lan-ai/") || playUrl.startsWith("/lan-ai");
    const isProxy = playUrl.includes("/ai-proxy/media");
    const isRemote = /^https?:\/\//i.test(playUrl) && !isProxy && !isLan;
    const clarity = videoResolutionDisplay(requestedResolution || "", video.width, video.height, acceptedResolution);
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            {playUrl && !previewError ? (
                <video
                    key={playUrl}
                    src={playUrl}
                    controls
                    playsInline
                    preload="auto"
                    className="aspect-video w-full bg-black object-contain"
                    onError={() => setPreviewError(true)}
                />
            ) : (
                <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-black px-4 text-center text-sm text-white/70">
                    <span>{previewError ? "视频预览失败" : "视频预览不可用"}</span>
                    <span className="text-xs text-white/50">
                        {isProxy
                            ? "本机代理拉不到远端 CDN（常见于 vidgen 出网超时）。生成可能已成功：请用新标签打开原始视频链接，或换可访问外网的网络后重试"
                            : isLan
                              ? "内网中继预览失败：请确认 LAN_AI_UPSTREAM 指向可访问的视频服务，且返回的文件路径可被 /lan-ai 转发"
                              : isRemote
                                ? "远端视频地址无法在当前网络播放。若是内网 127.0.0.1/局域网链接，请用「内网中继」渠道重新生成以落盘；也可新标签打开链接"
                                : "可尝试下载后本地播放"}
                    </span>
                    {rawUrl && /^https?:\/\//i.test(rawUrl) ? (
                        <a className="text-xs text-sky-300 underline" href={lanUrl || rawUrl} target="_blank" rel="noreferrer">
                            新标签打开视频
                        </a>
                    ) : null}
                </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {video.width}x{video.height}
                    </span>
                    {clarity.mismatched && clarity.actualLabel ? (
                        <span className="font-medium text-amber-600 dark:text-amber-400" title={clarity.requestedLabel ? `所选 ${clarity.requestedLabel}，实测 ${clarity.actualLabel}` : `实测 ${clarity.actualLabel}`}>
                            实 {clarity.actualLabel}
                            {clarity.requestedLabel ? ` · 选 ${clarity.requestedLabel}` : ""}
                        </span>
                    ) : clarity.actualLabel ? (
                        <span title="按源文件短边估算的清晰度档">{clarity.actualLabel}</span>
                    ) : null}
                    <span>{formatBytes(video.bytes)}</span>
                    <span>{formatDuration(video.durationMs)}</span>
                    {isBlob || video.storageKey ? <span className="text-emerald-600 dark:text-emerald-400">本地可播</span> : null}
                    {isLan && !video.storageKey ? <span className="text-sky-600 dark:text-sky-400">内网中继</span> : null}
                    {isProxy && !video.storageKey ? <span className="text-sky-600 dark:text-sky-400">代理预览</span> : null}
                    {isRemote && !video.storageKey ? <span className="text-amber-600 dark:text-amber-400">远程直链</span> : null}
                </div>
                <div className="flex shrink-0 gap-1">
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(video)}>
                        添加到资产
                    </Button>
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(video)}>
                        下载
                    </Button>
                </div>
            </div>
        </div>
    );
}

function PendingVideoCard() {
    return (
        <div className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>生成中</span>
            </div>
        </div>
    );
}

function FailedVideoCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
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
    onShareSelected,
    onShareLog,
    onStopLog,
    stoppableLogIds = [],
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
    onShareSelected?: () => void;
    onShareLog?: (log: GenerationLog) => void;
    onStopLog?: (logId: string) => void;
    stoppableLogIds?: string[];
}) {
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const showCloud = historySource === "cloud";
    const stoppable = new Set(stoppableLogIds);

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">生成记录</h2>
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
                <CloudHistoryPanel type="video" refreshKey={cloudRefreshKey} />
            ) : (
                <>
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                        <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                            新建
                        </Button>
                        <SelectCheckbox
                            variant="toolbar"
                            checked={allSelected}
                            indeterminate={!allSelected && selectedLogIds.length > 0}
                            disabled={!logs.length}
                            label={allSelected ? "取消全选" : "全选"}
                            aria-label={allSelected ? "取消全选" : "全选"}
                            onChange={(checked) => onSelectedLogIdsChange(checked ? logs.map((log) => log.id) : [])}
                        />
                        {selectedLogIds.length ? (
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-stone-900 px-1.5 text-[11px] font-medium tabular-nums text-white dark:bg-stone-100 dark:text-stone-900">
                                {selectedLogIds.length}
                            </span>
                        ) : null}
                        {onShareSelected ? (
                            <Button size="small" icon={<Share2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onShareSelected}>
                                分享
                            </Button>
                        ) : null}
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
                                canStop={Boolean(onStopLog && log.status === "生成中")}
                                onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                                onClick={() => onPreviewLog(log)}
                                onRetryCloud={onRetryCloud}
                                onShare={onShareLog && log.status === "成功" ? () => onShareLog(log) : undefined}
                                onStop={onStopLog ? () => onStopLog(log.id) : undefined}
                            />
                        ))}
                        {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">暂无生成记录</div> : null}
                    </div>
                </>
            )}
        </>
    );
}

function LogCard({
    log,
    selected,
    active,
    canStop,
    onSelectedChange,
    onClick,
    onRetryCloud,
    onShare,
    onStop,
}: {
    log: GenerationLog;
    selected: boolean;
    active: boolean;
    canStop?: boolean;
    onSelectedChange: (checked: boolean) => void;
    onClick: () => void;
    onRetryCloud?: (log: GenerationLog) => void;
    onShare?: () => void;
    onStop?: () => void;
}) {
    const syncLabel = cloudSyncLabel(log.cloudSync);
    const isGenerating = log.status === "生成中";
    // Concurrent jobs keep durationMs=0 until done; tick from createdAt so multi-task cards don't stick at 0秒.
    const liveElapsedMs = useLiveElapsedMs(log.createdAt, isGenerating);
    const displayDurationMs = isGenerating ? liveElapsedMs : log.durationMs;
    const clarity = videoResolutionDisplay(
        log.task?.requestedResolution || log.resolution || log.config?.vquality || "",
        log.video?.width,
        log.video?.height,
        log.task?.acceptedResolution,
    );
    const requestedTag = `${String(log.resolution || "").replace(/p$/i, "") || "?"}p`;
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
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
                <SelectCheckbox className="mt-0.5" checked={selected} aria-label="选择该记录" onChange={onSelectedChange} />
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.size}</Tag>
                        {clarity.mismatched && clarity.actualLabel ? (
                            <>
                                <Tag color="orange" className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" title={`所选 ${clarity.requestedLabel || requestedTag}，实测 ${clarity.actualLabel}${clarity.pixelLabel ? `（${clarity.pixelLabel}）` : ""}`}>
                                    实 {clarity.actualLabel}
                                </Tag>
                                <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none opacity-70" title="生成时选择的清晰度">
                                    选 {clarity.requestedLabel || requestedTag}
                                </Tag>
                            </>
                        ) : (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{requestedTag}</Tag>
                        )}
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.seconds}s</Tag>
                        {syncLabel ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={cloudSyncColor(log.cloudSync)}>
                                {syncLabel}
                            </Tag>
                        ) : null}
                    </div>
                    {canStop && onStop ? (
                        <div className="mt-2" onClick={(event) => event.stopPropagation()}>
                            <Button size="small" danger icon={<Square className="size-3.5" />} onClick={onStop}>
                                停止
                            </Button>
                        </div>
                    ) : null}
                    {onShare ? (
                        <div className="mt-2" onClick={(event) => event.stopPropagation()}>
                            <Button size="small" icon={<Share2 className="size-3.5" />} onClick={onShare}>
                                分享
                            </Button>
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
                <div className="grid justify-items-end gap-2">
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={log.status === "成功" ? "blue" : isGenerating ? "processing" : "red"}>
                        {log.status}
                    </Tag>
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                        {formatDuration(displayDurationMs)}
                    </Tag>
                </div>
            </div>
        </div>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const logs: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            logs.push(value);
        });
        return (await Promise.all(logs.map(normalizeLog))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const video = log.video?.storageKey ? { ...log.video, url: await resolveMediaUrl(log.video.storageKey, log.video.url) } : log.video;
    const videoReferences = await Promise.all(
        (log.videoReferences || []).map(async (item) => ({
            ...item,
            url: item.storageKey ? await resolveMediaUrl(item.storageKey, item.url) : item.url,
        })),
    );
    const audioReferences = await Promise.all(
        (log.audioReferences || []).map(async (item) => ({
            ...item,
            url: item.storageKey ? await resolveMediaUrl(item.storageKey, item.url) : item.url,
        })),
    );
    const references = await Promise.all(
        (log.references || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.videoModel || "",
        config,
        references,
        videoReferences,
        audioReferences,
        durationMs: log.durationMs || 0,
        size: log.size || config.size || "",
        resolution: normalizeResolution(log.resolution || config.vquality || ""),
        seconds: log.seconds || config.videoSeconds || "",
        status: log.status || "成功",
        task: log.task,
        video,
        error: log.error,
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
        videoReferences: log.videoReferences.map((item) => (item.storageKey ? { ...item, url: "" } : item)),
        audioReferences: log.audioReferences.map((item) => (item.storageKey ? { ...item, url: "" } : item)),
        video: log.video?.storageKey ? { ...log.video, url: "" } : log.video,
    };
}

function isSupportedAudioFile(file: File) {
    return file.type === "audio/mpeg" || file.type === "audio/mp3" || file.type === "audio/wav" || file.type === "audio/x-wav" || /\.(mp3|wav)$/i.test(file.name);
}

function filterAudioReferencesByDuration(existing: ReferenceAudio[], next: ReferenceAudio[], warn: (content: string) => void) {
    let total = existing.reduce((sum, item) => sum + (item.durationMs || 0), 0);
    const accepted: ReferenceAudio[] = [];
    let skipped = false;
    for (const item of next) {
        if (item.durationMs && (item.durationMs < 2000 || item.durationMs > 15000)) {
            skipped = true;
            continue;
        }
        if (item.durationMs && total + item.durationMs > 15000) {
            skipped = true;
            continue;
        }
        total += item.durationMs || 0;
        accepted.push(item);
    }
    if (skipped) warn("已忽略不符合时长要求的参考音频：单个 2-15 秒，总时长不超过 15 秒");
    return accepted;
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
        <div className="absolute inset-x-1 bottom-1 z-2 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        videoModel: log.config?.videoModel || log.model || "",
        size: log.config?.size || log.size || "",
        vquality: normalizeResolution(log.config?.vquality || log.resolution || ""),
        videoSeconds: log.config?.videoSeconds || log.seconds || "",
        videoGenerateAudio: log.config?.videoGenerateAudio || "true",
        videoWatermark: log.config?.videoWatermark || "false",
        baseUrl: log.config?.baseUrl || "",
        apiFormat: log.config?.apiFormat || "openai",
        channelId: log.config?.channelId,
        channelName: log.config?.channelName,
    };
}


async function syncVideoLogToCloud(log: GenerationLog): Promise<GenerationLog> {
    if (!useAuthStore.getState().user) {
        return { ...log, cloudSync: "failed", cloudError: "未登录", cloudErrorReason: "auth_required" };
    }
    if (!log.video?.url) {
        return { ...log, cloudSync: "failed", cloudError: "没有可上传的视频", cloudErrorReason: undefined };
    }
    const saved = await saveVideoToCloudDetailed({
        url: log.video.url,
        storageKey: log.video.storageKey,
        prompt: log.prompt,
        model: log.model,
        width: log.video.width,
        height: log.video.height,
        durationMs: log.video.durationMs,
        clientLocalId: log.video.id || log.id,
        provider: log.task?.provider,
        params: { size: log.size, seconds: log.seconds, resolution: log.resolution, localLogId: log.id },
    });
    if (!saved.job) return { ...log, cloudSync: "failed", cloudError: saved.error || "上传失败", cloudErrorReason: saved.reason };
    return { ...log, cloudSync: "synced", cloudJobIds: [saved.job.id], cloudError: undefined, cloudErrorReason: undefined };
}

function buildLog({ prompt, model, config, references, videoReferences, audioReferences, durationMs, status, task, video, error }: { prompt: string; model: string; config: AiConfig; references: ReferenceImage[]; videoReferences: ReferenceVideo[]; audioReferences: ReferenceAudio[]; durationMs: number; status: GenerationLog["status"]; task?: VideoGenerationTask; video?: GeneratedVideo; error?: string }): GenerationLog {
    const channel = resolveModelChannel(config, model);
    const logConfig = {
        model: config.model,
        videoModel: config.videoModel,
        size: config.size,
        vquality: normalizeResolution(config.vquality),
        videoSeconds: config.videoSeconds,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
        baseUrl: channel.baseUrl,
        apiFormat: channel.apiFormat,
        channelId: channel.id,
        channelName: channel.name,
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
        videoReferences,
        audioReferences,
        durationMs,
        size: logConfig.size,
        resolution: logConfig.vquality,
        seconds: logConfig.videoSeconds,
        status,
        task,
        video,
        error,
    };
}

function configWithLogConfig(config: AiConfig, logConfig: GenerationLogConfig): AiConfig {
    if (!logConfig.baseUrl) return { ...config, ...logConfig };
    const model = logConfig.videoModel || logConfig.model;
    const rawModel = modelOptionName(model);
    const currentChannel = logConfig.channelId ? config.channels.find((channel) => channel.id === logConfig.channelId) : resolveModelChannel(config, model);
    return {
        ...config,
        ...logConfig,
        channels: [
            {
                id: logConfig.channelId || "history",
                name: logConfig.channelName || "历史任务渠道",
                baseUrl: logConfig.baseUrl,
                apiKey: currentChannel?.apiKey || config.apiKey,
                apiFormat: logConfig.apiFormat,
                models: rawModel ? [rawModel] : [],
            },
            ...config.channels.filter((channel) => channel.id !== logConfig.channelId),
        ],
    };
}

function getVideoReadinessWarning(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    if (!model.trim()) return "请先配置视频模型";
    if (!channel.baseUrl.trim()) return "请先配置视频 Base URL";
    if (!channel.apiKey.trim() && !isSameOriginRelayBaseUrl(channel.baseUrl)) return "请先配置视频渠道 API Key";
    if (channel.apiFormat === "gemini") return "Gemini 调用格式暂不支持视频生成，请改用 OpenAI 格式渠道";
    return "";
}

function buildVideoConfig(config: AiConfig, model: string): AiConfig {
    const partial = { ...config, model, videoModel: model };
    const clamped = clampVideoConfigToCapability(partial);
    // Grok 请求层仍吃 "720p" 形式；能力注册表 UI 用 "720"，这里统一回写请求兼容值
    const grok = isGrokVideoConfig(partial);
    const vquality = grok ? normalizeGrokResolution(clamped.vquality || config.vquality) : clamped.vquality || normalizeResolution(config.vquality);
    return {
        ...config,
        model,
        videoModel: model,
        size: clamped.size ?? config.size,
        videoSeconds: clamped.videoSeconds ?? config.videoSeconds,
        vquality,
        videoGenerateAudio: clamped.videoGenerateAudio ?? String(boolConfig(config.videoGenerateAudio, true)),
        videoWatermark: clamped.videoWatermark ?? String(boolConfig(config.videoWatermark, false)),
    };
}

function normalizeResolution(value: string) {
    return normalizeVideoResolutionValue(value);
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("请求已取消", "AbortError"));
            return;
        }
        const timer = window.setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            window.clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(new DOMException("请求已取消", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function isAbortLikeError(error: unknown) {
    if (!error) return false;
    if (typeof error === "object" && error !== null) {
        const name = "name" in error ? String((error as { name?: unknown }).name || "") : "";
        const message = "message" in error ? String((error as { message?: unknown }).message || "") : "";
        if (name === "AbortError" || name === "CanceledError") return true;
        if (message === "请求已取消" || message === "已停止生成" || /aborted|abort|canceled|cancelled/i.test(message)) return true;
    }
    return false;
}
