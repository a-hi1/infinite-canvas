import { App, Button, Form, Input, Modal, Progress, Select, Tabs, Tag } from "antd";
import { Cloud, Download, Pencil, Plus, RefreshCw, Trash2, Upload, Wifi } from "lucide-react";
import { useRef, useState } from "react";

import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { ConfigPromptSources } from "@/components/layout/config-prompt-sources";
import { ModelPicker } from "@/components/model-picker";
import { fetchChannelModels } from "@/services/api/image";
import { exportAppConfig, importAppConfig } from "@/services/config-file";
import { syncAppDataToWebdav, type AppSyncDomainKey, type AppSyncProgressEvent } from "@/services/app-sync";
import { testWebdavConnection, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import { audioFormatOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { resolveAudioVoiceProfile } from "@/lib/audio-voice-profile";
import {
    AI_PROXY_BASE_URL,
    CHANNEL_COMPAT_OPTIONS,
    createModelChannel,
    deriveCapabilityModelLists,
    encodeChannelModel,
    isAiProxyBaseUrl,
    isLanAiBaseUrl,
    isSameOriginRelayBaseUrl,
    LAN_AI_BASE_URL,
    normalizeCompatProfile,
    pruneModelScripts,
    resolveChannelCompatProfile,
    setModelScript,
    useConfigStore,
    type AiConfig,
    type ApiCallFormat,
    type ModelCapability,
    type ModelChannel,
} from "@/stores/use-config-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel" | "transcriptionModel";
    defaultLabel: string;
    audioTask?: "tts" | "stt";
};

type WebdavDomainProgress = {
    label: string;
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", defaultLabel: "默认生图模型" },
    { capability: "video", modelKey: "videoModel", defaultLabel: "默认视频模型" },
    { capability: "text", modelKey: "textModel", defaultLabel: "默认文本模型" },
    { capability: "audio", modelKey: "audioModel", defaultLabel: "默认语音生成模型", audioTask: "tts" },
    { capability: "audio", modelKey: "transcriptionModel", defaultLabel: "默认语音转文字模型", audioTask: "stt" },
];

const webdavDomainKeys: AppSyncDomainKey[] = ["canvas", "assets", "image-workbench", "video-workbench"];
const webdavDomainLabels: Record<AppSyncDomainKey, string> = {
    canvas: "画布",
    assets: "我的资产",
    "image-workbench": "生图工作台",
    "video-workbench": "视频创作台",
};

function createWebdavDomainProgress(): Record<AppSyncDomainKey, WebdavDomainProgress> {
    return webdavDomainKeys.reduce(
        (progress, key) => ({
            ...progress,
            [key]: { label: webdavDomainLabels[key], stage: "等待同步" },
        }),
        {} as Record<AppSyncDomainKey, WebdavDomainProgress>,
    );
}

export function AppConfigModal() {
    const { message } = App.useApp();
    const configInputRef = useRef<HTMLInputElement>(null);
    const [activeTab, setActiveTab] = useState("channels");
    const [editingChannelId, setEditingChannelId] = useState("");
    const [loadingChannelId, setLoadingChannelId] = useState("");
    const [testingWebdav, setTestingWebdav] = useState(false);
    const [syncingWebdav, setSyncingWebdav] = useState(false);
    const [webdavSyncStatus, setWebdavSyncStatus] = useState("");
    const [webdavDomainProgress, setWebdavDomainProgress] = useState(createWebdavDomainProgress);
    const config = useConfigStore((state) => state.config);
    const defaultAudioVoiceProfile = resolveAudioVoiceProfile({ ...config, model: config.audioModel }, config.audioModel);
    const webdav = useConfigStore((state) => state.webdav);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const updateWebdavConfig = useConfigStore((state) => state.updateWebdavConfig);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const editingChannel = config.channels.find((channel) => channel.id === editingChannelId) || null;
    const webdavReady = Boolean(webdav.url.trim());

    const saveConfig = (nextConfig: AiConfig) => {
        const pruned = pruneModelScripts(nextConfig);
        (Object.keys(pruned) as Array<keyof AiConfig>).forEach((key) => updateConfig(key, pruned[key]));
    };

    const finishConfig = () => {
        const ready = config.channels.some((channel) => channel.baseUrl.trim() && (channel.apiKey.trim() || isSameOriginRelayBaseUrl(channel.baseUrl)) && channel.models.length);
        setConfigDialogOpen(false);
        if (!ready) return;
        message.success(shouldPromptContinue ? "配置已保存，请继续刚才的请求" : "配置已保存");
        clearPromptContinue();
    };

    const loadConfigFile = async (file: File) => {
        try {
            await importAppConfig(file);
            message.success("配置与用户偏好已导入");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "配置文件读取失败");
        } finally {
            if (configInputRef.current) configInputRef.current.value = "";
        }
    };

    const updateChannels = (channels: ModelChannel[]) => {
        saveConfig(withChannels(config, channels));
    };

    const saveChannel = (channel: ModelChannel) => {
        const exists = config.channels.some((item) => item.id === channel.id);
        const channels = exists ? config.channels.map((item) => (item.id === channel.id ? channel : item)) : [...config.channels, channel];
        updateChannels(channels);
        message.success(exists ? "渠道已保存" : "渠道已添加");
    };

    const saveChannelModelScript = (modelValue: string, script: string) => {
        try {
            const next = setModelScript(config, modelValue, script);
            updateConfig("modelScripts", next.modelScripts);
            message.success(script.trim() ? "模型调用脚本已保存" : "已恢复系统默认调用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存脚本失败");
        }
    };

    const addChannel = () => {
        const channel = createModelChannel({ name: `渠道 ${config.channels.length + 1}` });
        updateChannels([...config.channels, channel]);
        setEditingChannelId(channel.id);
    };

    const addProxyChannel = () => {
        const name = "服务器 AI 代理";
        const proxyChannel = createModelChannel({ name, baseUrl: AI_PROXY_BASE_URL, apiFormat: "openai", models: ["gpt-image-2", "agnes-video-v2.0", "gpt-5.5", "gpt-4o-mini-tts"] });
        const nextConfig = withChannels(config, [...config.channels, proxyChannel]);
        const agnesModel = encodeChannelModel(proxyChannel.id, "agnes-video-v2.0");
        saveConfig({
            ...nextConfig,
            videoModel: nextConfig.videoModels.includes(agnesModel) ? agnesModel : nextConfig.videoModel,
        });
        setEditingChannelId(proxyChannel.id);
        message.success("已添加服务器代理渠道；agnes-video-v2.0 已进入视频下拉，可在偏好设置里设为默认");
    };

    const addLanAiChannel = () => {
        const name = "内网 AI（同源中继）";
        const lanChannel = createModelChannel({
            name,
            baseUrl: LAN_AI_BASE_URL,
            apiFormat: "openai",
            // 明确 Grok 生图兼容，避免 auto 误判；可点「拉取模型」覆盖模型列表
            compatProfile: "grok-image",
            models: ["grok-3", "grok-2-image", "gpt-4o", "gpt-4o-mini"],
        });
        updateChannels([...config.channels, lanChannel]);
        setEditingChannelId(lanChannel.id);
        message.success("已添加内网渠道。Base URL 为 /lan-ai；生图兼容已设为「Grok / Grok2API」。部署侧配置 LAN_AI_UPSTREAM 后可用");
    };

    const deleteChannel = (id: string) => {
        if (config.channels.length <= 1) {
            message.warning("至少保留一个渠道");
            return;
        }
        if (editingChannelId === id) setEditingChannelId("");
        updateChannels(config.channels.filter((channel) => channel.id !== id));
    };

    const refreshAllModels = async () => {
        const runnable = config.channels.filter((channel) => channel.baseUrl.trim() && (channel.apiKey.trim() || isSameOriginRelayBaseUrl(channel.baseUrl)));
        if (!runnable.length) {
            message.error("请先填写至少一个渠道的 Base URL 和 API Key；服务器代理/内网中继未要求令牌时 API Key 可留空");
            return;
        }
        setLoadingChannelId("all");
        try {
            const entries = await Promise.all(runnable.map(async (channel) => [channel.id, uniqueModels(await fetchChannelModels(channel))] as const));
            const modelMap = new Map(entries);
            updateChannels(
                config.channels.map((channel) =>
                    modelMap.has(channel.id)
                        ? { ...channel, models: uniqueModels([...(channel.models || []), ...(modelMap.get(channel.id) || [])]) }
                        : channel,
                ),
            );
            message.success("模型列表已更新；各工作台下拉会按渠道模型自动同步");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingChannelId("");
        }
    };

    const testWebdav = async () => {
        if (!webdavReady) {
            message.error("请先填写 WebDAV 地址");
            return;
        }
        setTestingWebdav(true);
        try {
            await testWebdavConnection(webdav);
            message.success("WebDAV 连接可用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "WebDAV 连接测试失败");
        } finally {
            setTestingWebdav(false);
        }
    };

    const updateWebdavProgress = (event: AppSyncProgressEvent) => {
        setWebdavSyncStatus(event.stage);
        if (!event.domain) return;
        setWebdavDomainProgress((current) => ({
            ...current,
            [event.domain as AppSyncDomainKey]: {
                label: event.label || webdavDomainLabels[event.domain as AppSyncDomainKey],
                stage: event.stage,
                current: event.current,
                total: event.total,
                status: event.status,
            },
        }));
    };

    const syncWebdav = async () => {
        if (!webdavReady) {
            message.error("请先填写 WebDAV 地址");
            return;
        }
        setSyncingWebdav(true);
        setWebdavDomainProgress(createWebdavDomainProgress());
        setWebdavSyncStatus("准备同步");
        try {
            const result = await syncAppDataToWebdav(webdav, updateWebdavProgress);
            updateWebdavConfig("lastSyncedAt", result.syncedAt);
            message.success(`同步完成：${result.projects} 个画布，${result.assets} 个素材，${result.imageLogs + result.videoLogs} 条记录，本次上传 ${result.uploadedFiles} 个文件 ${formatBytes(result.uploadedBytes)}`);
        } catch (error) {
            setWebdavSyncStatus(error instanceof Error ? error.message : "WebDAV 同步失败");
            message.error(error instanceof Error ? error.message : "WebDAV 同步失败");
        } finally {
            setSyncingWebdav(false);
        }
    };

    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">配置与用户偏好</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">渠道聚合、默认模型和同步偏好</div>
                </div>
            }
            open={isConfigOpen}
            width={980}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }}
            footer={
                <Button type="primary" onClick={finishConfig}>
                    完成
                </Button>
            }
        >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-3 dark:border-stone-800">
                <div className="text-xs text-stone-500">JSON 文件包含 API Key 和 WebDAV 凭据，请妥善保管。</div>
                <div className="flex gap-2">
                    <Button icon={<Upload className="size-4" />} onClick={() => configInputRef.current?.click()}>
                        导入配置
                    </Button>
                    <Button icon={<Download className="size-4" />} onClick={exportAppConfig}>
                        导出配置
                    </Button>
                    <input ref={configInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => event.target.files?.[0] && void loadConfigFile(event.target.files[0])} />
                </div>
            </div>
            <Tabs
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                    {
                        key: "channels",
                        label: "渠道",
                        children: (
                            <div>
                                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0 flex-1 space-y-1">
                                        <div className="text-xs leading-5 text-stone-500">
                                            每个渠道选择协议并拉取模型；编辑抽屉里可选模型、配置调用脚本。渠道已保存的模型会按名称自动进入对应能力的下拉框，默认模型可在「偏好设置」调整。
                                        </div>
                                        <Button type="link" size="small" className="h-auto p-0 text-xs" onClick={() => setActiveTab("preferences")}>
                                            去偏好设置 →
                                        </Button>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap gap-2">
                                        <Button icon={<RefreshCw className="size-4" />} loading={loadingChannelId === "all"} onClick={() => void refreshAllModels()}>
                                            拉取全部
                                        </Button>
                                        <Button onClick={addProxyChannel}>服务器代理</Button>
                                        <Button onClick={addLanAiChannel}>内网中继</Button>
                                        <Button type="primary" icon={<Plus className="size-4" />} onClick={addChannel}>
                                            新增渠道
                                        </Button>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    {config.channels.map((channel) => {
                                        const compat = normalizeCompatProfile(channel.compatProfile);
                                        const compatLabel =
                                            CHANNEL_COMPAT_OPTIONS.find((item) => item.value === compat)?.label ||
                                            "自动";
                                        const resolved =
                                            compat === "auto"
                                                ? CHANNEL_COMPAT_OPTIONS.find((item) => item.value === resolveChannelCompatProfile(channel.baseUrl, "auto"))?.label
                                                : null;
                                        const keyReady = Boolean(channel.apiKey.trim() || isSameOriginRelayBaseUrl(channel.baseUrl));
                                        return (
                                            <div
                                                key={channel.id}
                                                className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-4 py-3 transition-colors hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900/40"
                                            >
                                                <div className="min-w-0">
                                                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                        <div className="truncate text-sm font-semibold">{channel.name || "未命名渠道"}</div>
                                                        {isAiProxyBaseUrl(channel.baseUrl) ? <Tag className="m-0">服务器代理</Tag> : null}
                                                        {isLanAiBaseUrl(channel.baseUrl) ? <Tag className="m-0">内网中继</Tag> : null}
                                                        {!keyReady ? <Tag className="m-0" color="warning">未填 Key</Tag> : null}
                                                    </div>
                                                    <div className="mt-1 truncate text-xs text-stone-500">
                                                        {apiFormatLabel(channel.apiFormat)} · 兼容 {compatLabel}
                                                        {resolved ? `（${resolved}）` : ""} · {channel.models.length} 个模型 · {channel.baseUrl || "未填写接口地址"}
                                                    </div>
                                                    <div className="mt-1 text-xs text-stone-400">{keyReady ? "密钥已配置" : "同源代理可留空密钥"} · 点编辑修改详情</div>
                                                </div>
                                                <div className="flex shrink-0 gap-2">
                                                    <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditingChannelId(channel.id)}>
                                                        编辑
                                                    </Button>
                                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => deleteChannel(channel.id)} />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ),
                    },
                    {
                        key: "preferences",
                        label: "偏好设置",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-2 text-sm font-semibold">默认模型</div>
                                <div className="mb-1 text-xs leading-5 text-stone-500">
                                    下拉选项直接来自各渠道已保存的模型（按名称自动识别生图/视频/文本/音频）。请先在「渠道」里选择模型；新建任务默认用这里的选择，单个节点/工作台仍可临时覆盖。
                                </div>
                                <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                    {modelGroups.map((group) => (
                                        <Form.Item key={group.modelKey} label={group.defaultLabel} className="mb-0">
                                            <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => {
                                                updateConfig(group.modelKey, model);
                                                if (group.modelKey === "audioModel") updateConfig("audioVoice", resolveAudioVoiceProfile({ ...config, model, audioModel: model }, model).voice);
                                            }} capability={group.capability} audioTask={group.audioTask} fullWidth />
                                        </Form.Item>
                                    ))}
                                </div>

                                <div className="mb-2 text-sm font-semibold">生成偏好</div>
                                <div className="mb-1 text-xs leading-5 text-stone-500">影响画布与工作台的初始默认值，单个任务仍可覆盖。</div>
                                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                    <Form.Item label="画布默认生图张数" extra="新建画布生图和配置节点默认使用。" className="mb-0">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={15}
                                            value={config.canvasImageCount}
                                            onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                            onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                                        />
                                    </Form.Item>
                                    <Form.Item label={`默认音频音色 · ${defaultAudioVoiceProfile.providerLabel}`} className="mb-0">
                                        <Select value={defaultAudioVoiceProfile.voice} options={defaultAudioVoiceProfile.options} onChange={(value) => updateConfig("audioVoice", value)} />
                                    </Form.Item>
                                    <Form.Item label="默认音频格式" className="mb-0">
                                        <Select value={config.audioFormat} options={audioFormatOptions} onChange={(value) => updateConfig("audioFormat", value)} />
                                    </Form.Item>
                                    <Form.Item label="默认音频语速" className="mb-0">
                                        <Input
                                            type="number"
                                            min={0.25}
                                            max={4}
                                            step={0.05}
                                            value={config.audioSpeed}
                                            onChange={(event) => updateConfig("audioSpeed", event.target.value)}
                                            onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                        />
                                    </Form.Item>
                                </div>
                                <Form.Item label="默认音频指令" className="mb-4 mt-4">
                                    <Input.TextArea rows={2} value={config.audioInstructions} placeholder="例如：自然、温暖、适合旁白。" onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                                </Form.Item>
                                <Form.Item label="系统提示词" className="mb-0">
                                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder="例如：你是一位擅长电影感写实摄影的视觉导演。" onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                                </Form.Item>
                            </Form>
                        ),
                    },
                    {
                        key: "prompt-sources",
                        label: "提示词来源",
                        children: <ConfigPromptSources />,
                    },
                    {
                        key: "webdav",
                        label: "WebDAV",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                                    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                            <div className="flex items-center gap-2 text-sm font-semibold">
                                                <Cloud className="size-4" />
                                                WebDAV 同步
                                            </div>
                                            <div className="mt-1 text-xs text-stone-500">同步画布、我的资产、生成记录和本地媒体文件，不包含 AI API Key；浏览器会直接连接 WebDAV 服务。</div>
                                        </div>
                                        <div className="text-xs text-stone-500">{webdav.lastSyncedAt ? `上次同步 ${formatWebdavTime(webdav.lastSyncedAt)}` : "尚未同步"}</div>
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        <Form.Item label="WebDAV 地址" className="mb-0">
                                            <Input value={webdav.url} placeholder="https://nas.example.com/webdav" onChange={(event) => updateWebdavConfig("url", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="远程目录" extra={`会在该目录下分业务目录保存，每个目录包含 ${WEBDAV_MANIFEST_FILE_NAME} 和 files/`} className="mb-0">
                                            <Input value={webdav.directory} placeholder="infinite-canvas" onChange={(event) => updateWebdavConfig("directory", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="用户名" className="mb-0">
                                            <Input value={webdav.username} autoComplete="username" onChange={(event) => updateWebdavConfig("username", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="密码 / 应用密码" className="mb-0">
                                            <Input.Password value={webdav.password} autoComplete="current-password" onChange={(event) => updateWebdavConfig("password", event.target.value)} />
                                        </Form.Item>
                                    </div>
                                    <div className="mt-4 flex flex-wrap items-center gap-2">
                                        <Button icon={<Wifi className="size-4" />} disabled={!webdavReady || syncingWebdav} loading={testingWebdav} onClick={() => void testWebdav()}>
                                            测试连接
                                        </Button>
                                        <Button type="primary" icon={<RefreshCw className="size-4" />} disabled={!webdavReady || testingWebdav} loading={syncingWebdav} onClick={() => void syncWebdav()}>
                                            {syncingWebdav ? "同步中" : "立即同步"}
                                        </Button>
                                        {webdavSyncStatus ? <span className="text-xs text-stone-500">{webdavSyncStatus}</span> : null}
                                    </div>
                                    {syncingWebdav || webdavSyncStatus ? <WebdavProgressGrid progress={webdavDomainProgress} /> : null}
                                </section>
                            </Form>
                        ),
                    },
                ]}
            />
            <ChannelEditorDrawer
                open={Boolean(editingChannel)}
                channel={editingChannel}
                modelScripts={config.modelScripts}
                onSave={saveChannel}
                onSaveScript={saveChannelModelScript}
                onClose={() => setEditingChannelId("")}
            />
        </Modal>
    );
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const derived = deriveCapabilityModelLists(channels, config);
    return pruneModelScripts({
        ...config,
        channels,
        ...derived,
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
    });
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

function apiFormatLabel(apiFormat: ApiCallFormat) {
    return apiFormat === "gemini" ? "Gemini" : "OpenAI";
}

function formatWebdavTime(value: string) {
    return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function WebdavProgressGrid({ progress }: { progress: Record<AppSyncDomainKey, WebdavDomainProgress> }) {
    return (
        <div className="mt-3 grid gap-2">
            {webdavDomainKeys.map((key) => {
                const item = progress[key];
                const count = item.total ? `${item.current || 0}/${item.total}` : "";
                return (
                    <div key={key} className="rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                        <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-xs">
                            <span className="shrink-0 font-medium text-stone-700 dark:text-stone-200">{item.label}</span>
                            <span className="min-w-0 truncate text-right text-stone-500">
                                {item.stage}
                                {count ? ` · ${count}` : ""}
                            </span>
                        </div>
                        <Progress percent={getWebdavProgressPercent(item)} size="small" status={getWebdavProgressStatus(item)} showInfo={false} />
                    </div>
                );
            })}
        </div>
    );
}

function getWebdavProgressPercent(item: WebdavDomainProgress) {
    if (item.status === "success") return 100;
    if (item.total) return Math.min(100, Math.round(((item.current || 0) / item.total) * 100));
    if (item.status === "exception") return 100;
    if (item.stage === "等待同步") return 0;
    if (item.stage === "读取远端清单") return 12;
    if (item.stage === "读取本地数据") return 24;
    if (item.stage === "下载缺失媒体") return 36;
    if (item.stage === "写入本地合并结果") return 58;
    if (item.stage === "上传新增媒体") return 66;
    if (item.stage === "媒体已齐全" || item.stage === "媒体无需上传") return 74;
    if (item.stage.startsWith("上传清单")) return 90;
    return item.status === "active" ? 30 : 0;
}

function getWebdavProgressStatus(item: WebdavDomainProgress): "normal" | "active" | "success" | "exception" {
    if (item.status === "success" || item.status === "exception") return item.status;
    return item.status === "active" ? "active" : "normal";
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
