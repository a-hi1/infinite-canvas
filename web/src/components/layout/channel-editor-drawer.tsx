import { App, Button, Drawer, Input, Segmented, Select, Space } from "antd";
import { ListPlus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ModelScriptEditor } from "@/components/layout/model-script-editor";
import { ModelSelectModal } from "@/components/layout/model-select-modal";
import { withSoraRelayModelAliases } from "@/lib/openai-compatible-video";
import {
    CHANNEL_COMPAT_OPTIONS,
    defaultBaseUrlForApiFormat,
    encodeChannelModel,
    isAiProxyBaseUrl,
    isLanAiBaseUrl,
    isSameOriginRelayBaseUrl,
    modelMatchesCapability,
    normalizeCompatProfile,
    resolveChannelCompatProfile,
    type ApiCallFormat,
    type ChannelCompatProfile,
    type ModelCapability,
    type ModelChannel,
} from "@/stores/use-config-store";

const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
    { label: "OpenAI", value: "openai" },
    { label: "Gemini", value: "gemini" },
];

const capabilityOptions: Array<{ label: string; value: ModelCapability }> = [
    { label: "生图", value: "image" },
    { label: "视频", value: "video" },
    { label: "文本", value: "text" },
    { label: "音频", value: "audio" },
];

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

function guessCapability(name: string): ModelCapability {
    if (modelMatchesCapability(name, "video")) return "video";
    if (modelMatchesCapability(name, "audio")) return "audio";
    if (modelMatchesCapability(name, "image")) return "image";
    return "text";
}

/**
 * 上游同款渠道编辑抽屉，适配本地 string[] 模型 + modelScripts 侧表 + 生图兼容预设。
 * 能力 Segmented 为展示/默认推断；下拉可选项由渠道已选模型按名称自动推导。
 */
export function ChannelEditorDrawer({
    open,
    channel,
    modelScripts,
    onSave,
    onSaveScript,
    onClose,
}: {
    open: boolean;
    channel: ModelChannel | null;
    /** 完整 config.modelScripts，用于显示「脚本已设」 */
    modelScripts?: Record<string, string>;
    onSave: (channel: ModelChannel) => void;
    /** 保存某个渠道模型的调用脚本到 modelScripts */
    onSaveScript?: (modelValue: string, script: string) => void;
    onClose: () => void;
}) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [capabilityByName, setCapabilityByName] = useState<Record<string, ModelCapability>>({});
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);

    useEffect(() => {
        if (open && channel) {
            const models = uniqueModels(withSoraRelayModelAliases(channel.models));
            setDraft({ ...channel, models });
            setCapabilityByName(Object.fromEntries(models.map((name) => [name, guessCapability(name)])));
            setSelectOpen(false);
            setScriptTarget(null);
        }
    }, [open, channel]);

    const scriptLookup = useMemo(() => modelScripts || {}, [modelScripts]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl =
            !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat)
                ? defaultBaseUrlForApiFormat(apiFormat)
                : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };

    const applySelection = (names: string[]) => {
        const models = uniqueModels(withSoraRelayModelAliases(names));
        setCapabilityByName((current) => {
            const next: Record<string, ModelCapability> = {};
            for (const name of models) next[name] = current[name] || guessCapability(name);
            return next;
        });
        patch({ models });
    };

    const setCapability = (name: string, capability: ModelCapability) => {
        setCapabilityByName((current) => ({ ...current, [name]: capability }));
    };

    const removeModel = (name: string) => {
        patch({ models: draft.models.filter((model) => model !== name) });
        setCapabilityByName((current) => {
            const next = { ...current };
            delete next[name];
            return next;
        });
    };

    const modelScriptKey = (name: string) => encodeChannelModel(draft.id, name);

    const hasScript = (name: string) => {
        const key = modelScriptKey(name);
        return Boolean(scriptLookup[key]?.trim() || scriptLookup[name]?.trim());
    };

    const openScript = (name: string) => {
        const capability = capabilityByName[name] || guessCapability(name);
        const key = modelScriptKey(name);
        const value = scriptLookup[key]?.trim() || scriptLookup[name]?.trim() || "";
        setScriptTarget({ name, capability, value });
    };

    const save = () => {
        if (!draft.baseUrl.trim()) {
            message.warning("请填写接口地址");
            return;
        }
        onSave({
            ...draft,
            name: draft.name.trim() || "未命名渠道",
            baseUrl: draft.baseUrl.trim(),
            apiKey: draft.apiKey.trim(),
            models: uniqueModels(withSoraRelayModelAliases(draft.models)),
            compatProfile: normalizeCompatProfile(draft.compatProfile),
        });
        onClose();
    };

    const keyExtra = isAiProxyBaseUrl(draft.baseUrl)
        ? "使用服务器代理时，这里填写 AI_PROXY_ACCESS_TOKEN；若服务器未启用访问令牌可留空。"
        : isLanAiBaseUrl(draft.baseUrl)
          ? "内网中继：Base URL 保持 /lan-ai。部署侧设置 LAN_AI_UPSTREAM=局域网IP:端口 后重建 app。内网服务若无鉴权可留空 Key；勿在浏览器里填 http://192.168.x.x（会 CORS）。"
          : undefined;

    const compatValue = normalizeCompatProfile(draft.compatProfile);
    const compatHint = CHANNEL_COMPAT_OPTIONS.find((item) => item.value === compatValue)?.hint;
    const resolvedCompat =
        compatValue === "auto"
            ? CHANNEL_COMPAT_OPTIONS.find((item) => item.value === resolveChannelCompatProfile(draft.baseUrl, "auto"))?.label
            : undefined;

    return (
        <Drawer
            open={open}
            width={680}
            title="编辑渠道"
            onClose={onClose}
            destroyOnClose
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" onClick={save}>
                        保存
                    </Button>
                </Space>
            }
        >
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">渠道名称</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder="例如：默认中转站" />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">协议</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">生图兼容预设</span>
                    <Select
                        className="w-full"
                        value={compatValue}
                        options={CHANNEL_COMPAT_OPTIONS.map((item) => ({ label: item.label, value: item.value }))}
                        onChange={(value: ChannelCompatProfile) => patch({ compatProfile: value })}
                    />
                    <div className="mt-1 text-xs leading-5 text-stone-500">
                        {compatHint}
                        {resolvedCompat ? ` · 当前推断为「${resolvedCompat}」` : ""}
                    </div>
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">接口地址</span>
                    <Input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com 或 /ai-proxy" />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-... 或访问令牌，可留空" />
                    {keyExtra ? <div className="mt-1 text-xs leading-5 text-stone-500">{keyExtra}</div> : null}
                    {!draft.apiKey.trim() && isSameOriginRelayBaseUrl(draft.baseUrl) ? (
                        <div className="mt-1 text-xs leading-5 text-stone-500">同源代理/中继可留空密钥。</div>
                    ) : null}
                </label>
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">渠道模型</div>
                    <div className="mt-0.5 text-xs text-stone-500">
                        已选 {draft.models.length} 个；这里选中的模型会直接出现在对应能力的下拉框（按名称识别生图/视频/文本/音频）。调用脚本在此直接设置。
                        {draft.models.some((item) => /^sora([-_.]|$)|sora-2/i.test(item)) ? (
                            <span className="block text-amber-700 dark:text-amber-300">
                                提示：部分中转 VIDEO 端点只认 azure-sora。列表有 sora-2 时会本地补 azure-sora。
                            </span>
                        ) : null}
                    </div>
                </div>
                <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                    选择模型
                </Button>
            </div>

            <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((name) => {
                        const capability = capabilityByName[name] || guessCapability(name);
                        const scripted = hasScript(name);
                        return (
                            <div key={name} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                                <span className="min-w-0 flex-1 truncate text-sm" title={name}>
                                    {name}
                                </span>
                                <div className="flex shrink-0 flex-wrap items-center gap-2">
                                    <Segmented size="small" value={capability} options={capabilityOptions} onChange={(value) => setCapability(name, value as ModelCapability)} />
                                    <Button
                                        size="small"
                                        type={scripted ? "primary" : "default"}
                                        ghost={scripted}
                                        disabled={!onSaveScript}
                                        onClick={() => openScript(name)}
                                    >
                                        {scripted ? "脚本已设" : "调用脚本"}
                                    </Button>
                                    <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(name)} />
                                </div>
                            </div>
                        );
                    })
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">点击「选择模型」拉取或手动增加模型。</div>
                )}
            </div>

            <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget?.capability || "text"}
                modelName={scriptTarget?.name || ""}
                value={scriptTarget?.value || ""}
                onSave={(script) => {
                    if (!scriptTarget || !onSaveScript) return;
                    onSaveScript(modelScriptKey(scriptTarget.name), script);
                    setScriptTarget(null);
                }}
                onClose={() => setScriptTarget(null)}
            />
        </Drawer>
    );
}
