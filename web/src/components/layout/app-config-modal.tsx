import { App, Button, Form, Input, Modal, Progress, Select, Tabs, Tag } from "antd";
import { Cloud, Code2, Pencil, Plus, RefreshCw, Trash2, Wifi } from "lucide-react";
import { useMemo, useState } from "react";

import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { ModelScriptEditor } from "@/components/layout/model-script-editor";
import { ModelPicker } from "@/components/model-picker";
import { fetchChannelModels } from "@/services/api/image";
import { syncAppDataToWebdav, type AppSyncDomainKey, type AppSyncProgressEvent } from "@/services/app-sync";
import { testWebdavConnection, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import {
    AI_PROXY_BASE_URL,
    CHANNEL_COMPAT_OPTIONS,
    createModelChannel,
    encodeChannelModel,
    filterModelsByCapability,
    isAiProxyBaseUrl,
    isLanAiBaseUrl,
    isSameOriginRelayBaseUrl,
    LAN_AI_BASE_URL,
    listConfiguredModelScripts,
    modelOptionLabel,
    modelOptionName,
    modelOptionsFromChannels,
    normalizeCompatProfile,
    normalizeModelOptionValue,
    pruneModelScripts,
    resolveChannelCompatProfile,
    resolveModelScript,
    setModelScript,
    useConfigStore,
    type AiConfig,
    type ApiCallFormat,
    type ModelCapability,
    type ModelChannel,
} from "@/stores/use-config-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    modelsKey: "imageModels" | "videoModels" | "textModels" | "audioModels";
    defaultLabel: string;
    optionsLabel: string;
};

type WebdavDomainProgress = {
    label: string;
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", modelsKey: "imageModels", defaultLabel: "默认生图模型", optionsLabel: "生图模型可选项" },
    { capability: "video", modelKey: "videoModel", modelsKey: "videoModels", defaultLabel: "默认视频模型", optionsLabel: "视频模型可选项" },
    { capability: "text", modelKey: "textModel", modelsKey: "textModels", defaultLabel: "默认文本模型", optionsLabel: "文本模型可选项" },
    { capability: "audio", modelKey: "audioModel", modelsKey: "audioModels", defaultLabel: "默认音频模型", optionsLabel: "音频模型可选项" },
];

const webdavDomainKeys: AppSyncDomainKey[] = ["canvas", "assets", "image-workbench", "video-workbench"];
const webdavDomainLabels: Record<AppSyncDomainKey, string> = {
    canvas: "画布",
    assets: "我的资产",
    "image-workbench": "生图工作台",
    "video-workbench": "视频创作台",
};

const capabilityShortLabel: Record<ModelCapability, string> = {
    image: "生图",
    video: "视频",
    text: "文本",
    audio: "音频",
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
    const [activeTab, setActiveTab] = useState("channels");
    const [editingChannelId, setEditingChannelId] = useState("");
    const [loadingChannelId, setLoadingChannelId] = useState("");
    const [testingWebdav, setTestingWebdav] = useState(false);
    const [syncingWebdav, setSyncingWebdav] = useState(false);
    const [webdavSyncStatus, setWebdavSyncStatus] = useState("");
    const [webdavDomainProgress, setWebdavDomainProgress] = useState(createWebdavDomainProgress);
    const [scriptEditor, setScriptEditor] = useState<{ capability: ModelCapability; modelValue: string } | null>(null);
    /** Per-capability model currently selected in the script manager UI (not the default model). */
    const [scriptTargetByCapability, setScriptTargetByCapability] = useState<Partial<Record<ModelCapability, string>>>({});
    const config = useConfigStore((state) => state.config);
    const webdav = useConfigStore((state) => state.webdav);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const updateWebdavConfig = useConfigStore((state) => state.updateWebdavConfig);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const modelOptions = config.models.map((model) => ({ label: modelOptionLabel(config, model), value: model }));
    const configuredScripts = useMemo(() => listConfiguredModelScripts(config), [config]);
    const editingChannel = config.channels.find((channel) => channel.id === editingChannelId) || null;
    const scriptModelOptionsByCapability = useMemo(() => {
        const scripted = configuredScripts.map((item) => item.key);
        return Object.fromEntries(
            modelGroups.map((group) => {
                const capabilityModels = config[group.modelsKey] || [];
                const defaultModel = config[group.modelKey];
                const capabilityNames = new Set(capabilityModels.map((value) => modelOptionName(value)));
                if (defaultModel) capabilityNames.add(modelOptionName(defaultModel));
                const relatedScripted = scripted.filter((key) => {
                    if (capabilityModels.includes(key) || key === defaultModel) return true;
                    return capabilityNames.has(modelOptionName(key));
                });
                const values = Array.from(new Set([defaultModel, ...capabilityModels, ...relatedScripted].map((value) => (value || "").trim()).filter(Boolean)));
                return [
                    group.capability,
                    values.map((value) => ({
                        value,
                        label: `${modelOptionLabel(config, value)}${resolveModelScript(config, value) ? " · 已自定义" : ""}`,
                    })),
                ];
            }),
        ) as Record<ModelCapability, Array<{ value: string; label: string }>>;
    }, [config, configuredScripts]);
    const webdavReady = Boolean(webdav.url.trim());

    const saveConfig = (nextConfig: AiConfig) => {
        const pruned = pruneModelScripts(nextConfig);
        (Object.keys(pruned) as Array<keyof AiConfig>).forEach((key) => updateConfig(key, pruned[key]));
    };

    const clearModelScript = (modelValue: string) => {
        try {
            const next = setModelScript(config, modelValue, "");
            updateConfig("modelScripts", next.modelScripts);
            message.success("已清除该模型的自定义脚本");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "清除脚本失败");
        }
    };

    const finishConfig = () => {
        const ready = config.channels.some((channel) => channel.baseUrl.trim() && (channel.apiKey.trim() || isSameOriginRelayBaseUrl(channel.baseUrl)) && channel.models.length);
        setConfigDialogOpen(false);
        if (!ready) return;
        message.success(shouldPromptContinue ? "配置已保存，请继续刚才的请求" : "配置已保存");
        clearPromptContinue();
    };

    const updateChannels = (channels: ModelChannel[]) => {
        saveConfig(withChannels(config, channels));
    };

    const saveChannel = (channel: ModelChannel) => {
        const exists = config.channels.some((item) => item.id === channel.id);
        const channels = exists ? config.channels.map((item) => (item.id === channel.id ? channel : item)) : [...config.channels, channel];
        updateChannels(channels);
        message.success(exists ? "渠道已保存" : "渠道已添加");
        if (channel.models.length) {
            message.info({ content: "记得到「模型」Tab 把需要的模型加入可选项", duration: 3 });
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
            videoModels: uniqueModels([...nextConfig.videoModels, agnesModel]),
            videoModel: agnesModel,
        });
        setEditingChannelId(proxyChannel.id);
        message.success("已添加服务器代理渠道，并已把 agnes-video-v2.0 设为默认视频模型");
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
            updateChannels(config.channels.map((channel) => (modelMap.has(channel.id) ? { ...channel, models: modelMap.get(channel.id) || [] } : channel)));
            message.success("模型列表已更新；请到「模型」Tab 确认可选项");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingChannelId("");
        }
    };

    const updateCapabilityModels = (group: ModelGroup, models: string[]) => {
        const next = uniqueModels(models.map((model) => normalizeModelOptionValue(model, config.channels)).filter(Boolean));
        updateConfig(group.modelsKey, next);
        if (!next.includes(config[group.modelKey])) updateConfig(group.modelKey, next[0] || "");
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
                    <div className="mt-1 text-xs font-normal text-stone-500">渠道列表、模型可选项与同步偏好</div>
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
                                        <div className="text-xs leading-5 text-stone-500">列表仅展示摘要；点「编辑」修改密钥与模型。新增或拉取后，请到「模型」Tab 选择可选项才会出现在各处下拉框。</div>
                                        <Button type="link" size="small" className="h-auto p-0 text-xs" onClick={() => setActiveTab("models")}>
                                            去模型设置 →
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
                        key: "models",
                        label: "模型",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <section className="mb-4 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                                    <div className="mb-3">
                                        <div className="text-sm font-semibold">可选项</div>
                                        <div className="mt-1 text-xs leading-5 text-stone-500">决定各处下拉框展示哪些模型；同名模型会以括号里的渠道名区分。请先在渠道里保存模型名。</div>
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        {modelGroups.map((group) => (
                                            <Form.Item key={group.modelsKey} label={group.optionsLabel} className="mb-0">
                                                <Select
                                                    mode="tags"
                                                    showSearch
                                                    allowClear
                                                    maxTagCount="responsive"
                                                    placeholder={config.models.length ? `请选择或输入${group.optionsLabel}` : "先到渠道里填写或拉取模型"}
                                                    value={config[group.modelsKey]}
                                                    options={modelOptions}
                                                    onChange={(models) => updateCapabilityModels(group, models)}
                                                />
                                            </Form.Item>
                                        ))}
                                    </div>
                                </section>

                                <section className="mb-4 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                                    <div className="mb-3">
                                        <div className="text-sm font-semibold">默认模型</div>
                                        <div className="mt-1 text-xs leading-5 text-stone-500">新建任务时的默认选择；单个节点/工作台仍可临时覆盖。</div>
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                        {modelGroups.map((group) => (
                                            <Form.Item key={group.modelKey} label={group.defaultLabel} className="mb-0">
                                                <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                                            </Form.Item>
                                        ))}
                                    </div>
                                </section>

                                <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                                    <div className="mb-3">
                                        <div className="text-sm font-semibold">调用脚本（可选）</div>
                                        <div className="mt-1 text-xs leading-5 text-stone-500">
                                            为任意可选模型写自定义调用脚本，键优先 <code className="mx-0.5">渠道::模型</code>；留空走系统默认。仅保存在本机。
                                        </div>
                                    </div>
                                    <div className="grid gap-3 md:grid-cols-2">
                                        {modelGroups.map((group) => {
                                            const options = scriptModelOptionsByCapability[group.capability] || [];
                                            const selected = scriptTargetByCapability[group.capability];
                                            const modelValue = (selected && options.some((item) => item.value === selected) ? selected : "") || config[group.modelKey] || options[0]?.value || "";
                                            const hasScript = Boolean(modelValue && resolveModelScript(config, modelValue));
                                            const isDefaultModel = Boolean(modelValue && modelValue === config[group.modelKey]);
                                            return (
                                                <div key={`script-${group.modelKey}`} className="space-y-2 rounded-md border border-stone-200 p-3 dark:border-stone-800">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div className="min-w-0 text-sm font-medium">{capabilityShortLabel[group.capability]}脚本</div>
                                                        <div className="flex shrink-0 items-center gap-1.5">
                                                            {isDefaultModel ? <Tag className="m-0">默认</Tag> : null}
                                                            {hasScript ? (
                                                                <Tag className="m-0" color="blue">
                                                                    已自定义
                                                                </Tag>
                                                            ) : (
                                                                <Tag className="m-0">系统默认</Tag>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                                        <Select
                                                            className="min-w-0 flex-1"
                                                            showSearch
                                                            allowClear={false}
                                                            placeholder={options.length ? "选择要配置脚本的模型" : "先添加模型可选项"}
                                                            value={modelValue || undefined}
                                                            options={options}
                                                            optionFilterProp="label"
                                                            onChange={(value) => setScriptTargetByCapability((current) => ({ ...current, [group.capability]: value }))}
                                                        />
                                                        <Button
                                                            size="middle"
                                                            icon={<Code2 className="size-3.5" />}
                                                            disabled={!modelValue}
                                                            onClick={() => modelValue && setScriptEditor({ capability: group.capability, modelValue })}
                                                        >
                                                            编辑脚本
                                                        </Button>
                                                    </div>
                                                    {!options.length ? <div className="text-xs text-stone-500">该能力还没有可选模型。</div> : null}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {configuredScripts.length ? (
                                        <div className="mt-3 rounded-md border border-stone-200 p-3 dark:border-stone-800">
                                            <div className="mb-2 flex items-center justify-between gap-2">
                                                <div className="text-sm font-medium">已配置脚本（{configuredScripts.length}）</div>
                                                <div className="text-xs text-stone-500">仅列出有自定义脚本的模型</div>
                                            </div>
                                            <div className="space-y-2">
                                                {configuredScripts.map((item) => (
                                                    <div key={item.key} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-stone-50 px-2.5 py-2 dark:bg-stone-900/40">
                                                        <div className="min-w-0">
                                                            <div className="truncate text-sm font-medium">{item.label}</div>
                                                            <div className="truncate font-mono text-[11px] text-stone-500">{item.key}</div>
                                                        </div>
                                                        <div className="flex shrink-0 gap-2">
                                                            <Button
                                                                size="small"
                                                                icon={<Code2 className="size-3.5" />}
                                                                onClick={() => {
                                                                    const capability = resolveScriptEditorCapability(config, item.key);
                                                                    setScriptTargetByCapability((current) => ({ ...current, [capability]: item.key }));
                                                                    setScriptEditor({ capability, modelValue: item.key });
                                                                }}
                                                            >
                                                                编辑
                                                            </Button>
                                                            <Button size="small" danger onClick={() => clearModelScript(item.key)}>
                                                                清除
                                                            </Button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ) : null}
                                </section>
                            </Form>
                        ),
                    },
                    {
                        key: "preferences",
                        label: "生成偏好",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                                    <div className="mb-3">
                                        <div className="text-sm font-semibold">默认生成参数</div>
                                        <div className="mt-1 text-xs leading-5 text-stone-500">影响画布与工作台的初始默认值，单个任务仍可覆盖。</div>
                                    </div>
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
                                        <Form.Item label="默认音频声音" className="mb-0">
                                            <Select value={config.audioVoice} options={audioVoiceOptions} onChange={(value) => updateConfig("audioVoice", value)} />
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
                                </section>
                            </Form>
                        ),
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
            <ChannelEditorDrawer open={Boolean(editingChannel)} channel={editingChannel} onSave={saveChannel} onClose={() => setEditingChannelId("")} />
            <ModelScriptEditor
                open={Boolean(scriptEditor)}
                capability={scriptEditor?.capability || "image"}
                modelName={scriptEditor ? modelOptionName(scriptEditor.modelValue) : ""}
                value={scriptEditor ? resolveModelScript(config, scriptEditor.modelValue) : ""}
                onSave={(script) => {
                    if (!scriptEditor) return;
                    try {
                        const next = setModelScript(config, scriptEditor.modelValue, script);
                        updateConfig("modelScripts", next.modelScripts);
                        message.success(script.trim() ? "模型调用脚本已保存" : "已恢复系统默认调用");
                    } catch (error) {
                        message.error(error instanceof Error ? error.message : "保存脚本失败");
                    }
                }}
                onClose={() => setScriptEditor(null)}
            />
        </Modal>
    );
}

/** Prefer capability lists / defaults over name regex when opening a configured script. */
function resolveScriptEditorCapability(config: AiConfig, modelKey: string): ModelCapability {
    const exact = modelGroups.find((group) => config[group.modelKey] === modelKey || (config[group.modelsKey] || []).includes(modelKey));
    if (exact) return exact.capability;
    const name = modelOptionName(modelKey);
    const byName = modelGroups.find((group) => {
        if (modelOptionName(config[group.modelKey] || "") === name) return true;
        return (config[group.modelsKey] || []).some((value) => modelOptionName(value) === name);
    });
    if (byName) return byName.capability;
    if (name.match(/video|sora|veo|seedance|agnes|kling|wan|hailuo/i)) return "video";
    if (name.match(/tts|audio|speech|voice|music|sound/i)) return "audio";
    if (name.match(/image|dall|seedream|flux|imagen|sdxl|gpt-image/i)) return "image";
    return "text";
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const models = modelOptionsFromChannels(channels);
    const imageModels = keepOrSuggest(config.imageModels, filterModelsByCapability(models, "image"), models);
    const videoModels = keepOrSuggest(config.videoModels, filterModelsByCapability(models, "video"), models);
    const textModels = keepOrSuggest(config.textModels, filterModelsByCapability(models, "text"), models);
    const audioModels = keepOrSuggest(config.audioModels, filterModelsByCapability(models, "audio"), models);
    return pruneModelScripts({
        ...config,
        channels,
        models,
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        imageModel: normalizeDefaultModel(config.imageModel, imageModels),
        videoModel: normalizeDefaultModel(config.videoModel, videoModels),
        textModel: normalizeDefaultModel(config.textModel, textModels),
        audioModel: normalizeDefaultModel(config.audioModel, audioModels),
    });
}

function keepOrSuggest(current: string[], suggested: string[], allModels: string[]) {
    const available = new Set(allModels);
    const kept = uniqueModels(current).filter((model) => available.has(model));
    return kept.length ? kept : suggested;
}

function normalizeDefaultModel(value: string, options: string[]) {
    if (options.includes(value)) return value;
    return options[0] || value;
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
