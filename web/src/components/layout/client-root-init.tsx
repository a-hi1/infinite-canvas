import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";

import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { useAuthStore } from "@/stores/use-auth-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const handledConfigParams = useRef(false);
    const unauthorizedNotified = useRef(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const hydrateAuth = useAuthStore((state) => state.hydrate);
    const clearSession = useAuthStore((state) => state.clearSession);

    useEffect(() => {
        void hydrateAuth();
    }, [hydrateAuth]);

    useEffect(() => {
        // 受保护云接口 401 时统一清登录态，避免侧栏连环报错
        const onUnauthorized = () => {
            if (!useAuthStore.getState().user) return;
            clearSession();
            if (unauthorizedNotified.current) return;
            unauthorizedNotified.current = true;
            message.warning("登录已失效，请重新登录后使用云端功能");
            window.setTimeout(() => {
                unauthorizedNotified.current = false;
            }, 3000);
        };
        window.addEventListener("infinite-canvas:cloud-unauthorized", onUnauthorized);
        return () => window.removeEventListener("infinite-canvas:cloud-unauthorized", onUnauthorized);
    }, [clearSession, message]);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const firstChannel = config.channels[0];
        updateConfig(
            "channels",
            firstChannel
                ? config.channels.map((channel, index) =>
                      index === 0
                          ? {
                                ...channel,
                                ...(baseUrl ? { baseUrl } : {}),
                                ...(apiKey ? { apiKey } : {}),
                            }
                          : channel,
                  )
                : [createModelChannel({ id: "default", name: "默认渠道", baseUrl: baseUrl || undefined, apiKey: apiKey || "" })],
        );
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
        message.success(baseUrl?.replace(/\/+$/, "") === "/ai-proxy" ? "已导入服务器代理配置" : "已导入本地直连配置");
    }, [config.channels, message, openConfigDialog, updateConfig]);

    return <>{children}</>;
}
