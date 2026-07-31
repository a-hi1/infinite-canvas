import { saveAs } from "file-saver";

import { createPromptSource, type PromptSource } from "@/services/api/prompt-source-presets";
import { useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

/** 导出当前 AI 配置 + WebDAV + 提示词来源（含密钥，请用户自行保管）。 */
export function exportAppConfig() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const data: AppConfigFile = {
        app: "infinite-canvas",
        version: 1,
        exportedAt: new Date().toISOString(),
        config,
        webdav,
        promptSources: { sources, schedule },
    };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

/** 导入配置文件；保留本仓 AiConfig 字段（含 modelScripts / 可选项 / compatProfile）。 */
export async function importAppConfig(file: File) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error("配置文件格式不正确");
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.config || !data.webdav || !data.promptSources) {
        throw new Error("配置文件格式不正确");
    }
    if (!Array.isArray(data.config.channels) || typeof data.config !== "object") {
        throw new Error("配置文件格式不正确");
    }

    useConfigStore.setState({
        config: {
            ...useConfigStore.getState().config,
            ...data.config,
            modelScripts: data.config.modelScripts && typeof data.config.modelScripts === "object" ? data.config.modelScripts : {},
        },
        webdav: {
            ...useConfigStore.getState().webdav,
            ...data.webdav,
        },
    });

    const sources = Array.isArray(data.promptSources.sources)
        ? data.promptSources.sources.map((source) => createPromptSource(source))
        : usePromptSourceStore.getState().sources;
    const schedule = {
        ...usePromptSourceStore.getState().schedule,
        ...(data.promptSources.schedule || {}),
    };
    usePromptSourceStore.setState({ sources, schedule });
}
