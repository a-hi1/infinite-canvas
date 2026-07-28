import { App, Button, Drawer, Input, Select, Space } from "antd";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { fetchChannelModels } from "@/services/api/image";
import {
    CHANNEL_COMPAT_OPTIONS,
    defaultBaseUrlForApiFormat,
    isAiProxyBaseUrl,
    isLanAiBaseUrl,
    isSameOriginRelayBaseUrl,
    normalizeCompatProfile,
    resolveChannelCompatProfile,
    type ApiCallFormat,
    type ChannelCompatProfile,
    type ModelChannel,
} from "@/stores/use-config-store";

const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
    { label: "OpenAI", value: "openai" },
    { label: "Gemini", value: "gemini" },
];

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

export function ChannelEditorDrawer({
    open,
    channel,
    onSave,
    onClose,
}: {
    open: boolean;
    channel: ModelChannel | null;
    onSave: (channel: ModelChannel) => void;
    onClose: () => void;
}) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [loadingModels, setLoadingModels] = useState(false);

    useEffect(() => {
        if (open && channel) setDraft({ ...channel, models: uniqueModels(channel.models) });
    }, [open, channel]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl =
            !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat)
                ? defaultBaseUrlForApiFormat(apiFormat)
                : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };

    const refreshModels = async () => {
        if (!draft.baseUrl.trim() || (!draft.apiKey.trim() && !isSameOriginRelayBaseUrl(draft.baseUrl))) {
            message.error("请先填写 Base URL 和 API Key；服务器代理/内网中继未要求令牌时 API Key 可留空");
            return;
        }
        setLoadingModels(true);
        try {
            const models = uniqueModels(await fetchChannelModels(draft));
            patch({ models });
            message.success(`已拉取 ${models.length} 个模型`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingModels(false);
        }
    };

    const save = () => {
        onSave({
            ...draft,
            name: draft.name.trim() || "未命名渠道",
            baseUrl: draft.baseUrl.trim(),
            apiKey: draft.apiKey.trim(),
            models: uniqueModels(draft.models),
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
                    <span className="mb-1 block text-sm font-medium">调用格式</span>
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
                    <span className="mb-1 block text-sm font-medium">Base URL</span>
                    <Input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com 或 /ai-proxy" />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key / 代理访问令牌</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-... 或访问令牌，可留空" />
                    {keyExtra ? <div className="mt-1 text-xs leading-5 text-stone-500">{keyExtra}</div> : null}
                </label>
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">模型列表</div>
                    <div className="mt-0.5 text-xs text-stone-500">已保存 {draft.models.length} 个；拉取或手动输入后仍需到「模型」Tab 勾选可选项才会出现在下拉框。</div>
                </div>
                <Button icon={<RefreshCw className="size-4" />} loading={loadingModels} onClick={() => void refreshModels()}>
                    拉取模型
                </Button>
            </div>

            <Select
                className="w-full"
                mode="tags"
                showSearch
                allowClear
                maxTagCount="responsive"
                placeholder="输入模型名，或点击拉取模型"
                value={draft.models}
                onChange={(models) => patch({ models: uniqueModels(models) })}
            />
        </Drawer>
    );
}
