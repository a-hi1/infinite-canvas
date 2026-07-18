import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Tag } from "antd";
import { CloudDownload, Download, FileUp, Plus } from "lucide-react";

import { readZip } from "@/lib/zip";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import {
    getCanvasLibraryCloudSummary,
    getCanvasProjectCloudBadge,
    getCanvasCloudStatusVersion,
    hydrateCanvasCloudStatus,
    pullAndMergeCanvasProjects,
    subscribeCanvasCloudStatus,
} from "@/services/canvas-cloud-sync";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import type { CanvasExportFile } from "@/types/canvas-export";
import { useAuthStore } from "@/stores/use-auth-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";

export default function CanvasPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const cloudPulledRef = useRef(false);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const cloudUser = useAuthStore((state) => state.user);
    const [cloudSyncing, setCloudSyncing] = useState(false);
    const cloudStatusVersion = useSyncExternalStore(subscribeCanvasCloudStatus, getCanvasCloudStatusVersion, () => 0);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const enterProject = (id: string) => {
        navigate(`/canvas/${id}${agentQuery}`);
    };
    const createAndEnter = () => enterProject(createProject(`无限画布 ${projects.length + 1}`));
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            await Promise.all(
                data.projects.flatMap((project) =>
                    project.files.map(async (item) => {
                        const blob = zip.get(item.path);
                        if (!blob) return;
                        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                        await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
                    }),
                ),
            );
            data.projects.forEach((item) => importProject(item.project));
            message.success(`已导入 ${data.projects.length} 个画布`);
        } catch {
            message.error("导入失败，请选择有效的画布压缩包");
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        enterProject(mode === "new" ? createProject(`无限画布 ${projects.length + 1}`) : projects[0]?.id || createProject(`无限画布 ${projects.length + 1}`));
    }, [createProject, hydrated, mode, projects]);

    useEffect(() => {
        void hydrateCanvasCloudStatus();
    }, []);

    // Login once: soft pull cloud project list (local-first merge). Never blocks offline use.
    useEffect(() => {
        if (!hydrated || !cloudUser || cloudPulledRef.current) return;
        cloudPulledRef.current = true;
        setCloudSyncing(true);
        void pullAndMergeCanvasProjects()
            .then((result) => {
                if (result.ok && (result.pulled > 0 || (result.mediaDownloaded || 0) > 0)) {
                    const parts = [];
                    if (result.pulled > 0) parts.push(`${result.pulled} 个画布`);
                    if ((result.mediaDownloaded || 0) > 0) parts.push(`${result.mediaDownloaded} 个媒体`);
                    message.success(`已从云端合并 ${parts.join("、")}`);
                }
            })
            .finally(() => setCloudSyncing(false));
    }, [cloudUser, hydrated, message]);

    const cloudSummary = useMemo(
        () => getCanvasLibraryCloudSummary(projects, { loggedIn: Boolean(cloudUser), syncing: cloudSyncing }),
        // cloudStatusVersion refreshes badges after push/pull snapshot writes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [projects, cloudUser, cloudSyncing, cloudStatusVersion],
    );

    const syncFromCloud = async () => {
        if (!cloudUser) {
            message.info("登录后可从云端拉取画布项目与媒体（本地草稿不会丢）");
            return;
        }
        setCloudSyncing(true);
        try {
            const result = await pullAndMergeCanvasProjects();
            if (!result.ok) message.warning("云端暂不可用，已保留本机画布");
            else if (result.pulled > 0 || (result.mediaDownloaded || 0) > 0) {
                const parts = [];
                if (result.pulled > 0) parts.push(`${result.pulled} 个画布`);
                if ((result.mediaDownloaded || 0) > 0) parts.push(`${result.mediaDownloaded} 个媒体`);
                message.success(`已合并 ${parts.join("、")}`);
            } else message.success("已与云端对齐（无更新）");
        } finally {
            setCloudSyncing(false);
        }
    };

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">正在打开画布...</main>;

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">画布库</p>
                        <h1 className="mt-3 text-3xl font-semibold">无限画布</h1>
                        <p className="mt-2 text-xs text-stone-500">默认保存在本机；登录后会异步同步项目 JSON 与节点媒体（storageKey），云失败不丢本地草稿。</p>
                        <div className="mt-3">
                            <Tag
                                className="m-0 inline-flex h-7 items-center rounded-full px-3 text-xs"
                                color={
                                    cloudSummary.tone === "synced"
                                        ? "success"
                                        : cloudSummary.tone === "failed"
                                          ? "error"
                                          : cloudSummary.tone === "pending"
                                            ? "processing"
                                            : "default"
                                }
                            >
                                {cloudSummary.label}
                                {cloudSummary.detail ? ` · ${cloudSummary.detail}` : ""}
                            </Tag>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(projects.filter((project) => selectedIds.includes(project.id)), `无限画布-${selectedIds.length}个项目`)}>
                                    导出选中
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    删除选中
                                </Button>
                            </>
                        ) : null}
                        {projects.length ? (
                            <Button disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                删除全部
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated || cloudSyncing} icon={<CloudDownload className="size-4" />} loading={cloudSyncing} onClick={() => void syncFromCloud()}>
                            同步云端
                        </Button>
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            导入画布
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </div>
                </header>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">正在加载画布...</section>
                ) : projects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {projects.map((project) => (
                            <CanvasProjectCard
                                key={project.id}
                                project={project}
                                cloudBadge={getCanvasProjectCloudBadge(project, { loggedIn: Boolean(cloudUser), syncing: cloudSyncing })}
                            />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">还没有画布</h2>
                        <p className="mt-3 text-sm text-stone-500">新建一个画布后，就可以独立保存节点、连线和画布外观。</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
