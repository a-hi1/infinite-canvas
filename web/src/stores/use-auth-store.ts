import { create } from "zustand";

import { cloudLogin, cloudLogout, cloudRegister, getCloudMe, type CloudCredits, type CloudLimits, type CloudUsage, type CloudUser } from "@/services/cloud-api";

type AuthState = {
    hydrated: boolean;
    user: CloudUser | null;
    usage: CloudUsage | null;
    limits: CloudLimits | null;
    credits: CloudCredits | null;
    hydrate: () => Promise<void>;
    refreshUsage: () => Promise<void>;
    login: (email: string, password: string) => Promise<void>;
    register: (input: { email: string; password: string; displayName?: string; inviteCode?: string }) => Promise<void>;
    logout: () => Promise<void>;
    /** 会话失效时清本地登录态，不请求网络 */
    clearSession: () => void;
};

async function loadMe() {
    const data = await getCloudMe();
    return {
        user: data.user || null,
        usage: data.usage || null,
        limits: data.limits || null,
        credits: data.credits || null,
    };
}

export const useAuthStore = create<AuthState>((set, get) => ({
    hydrated: false,
    user: null,
    usage: null,
    limits: null,
    credits: null,
    hydrate: async () => {
        try {
            const me = await loadMe();
            set({ ...me, hydrated: true });
        } catch {
            // API 不可用时保持未登录，不影响本地模式
            set({ user: null, usage: null, limits: null, credits: null, hydrated: true });
        }
    },
    refreshUsage: async () => {
        if (!get().user) return;
        try {
            const me = await loadMe();
            set({ user: me.user, usage: me.usage, limits: me.limits, credits: me.credits });
        } catch {
            // ignore transient errors
        }
    },
    login: async (email, password) => {
        const data = await cloudLogin({ email, password });
        // 以 /auth/me 再确认一次 Cookie 会话，并拉用量
        try {
            const me = await loadMe();
            set({ user: me.user || data.user, usage: me.usage, limits: me.limits, credits: me.credits, hydrated: true });
        } catch {
            set({ user: data.user, usage: null, limits: null, credits: null, hydrated: true });
        }
    },
    register: async (input) => {
        const data = await cloudRegister(input);
        try {
            const me = await loadMe();
            set({ user: me.user || data.user, usage: me.usage, limits: me.limits, credits: me.credits, hydrated: true });
        } catch {
            set({ user: data.user, usage: null, limits: null, credits: null, hydrated: true });
        }
    },
    logout: async () => {
        try {
            await cloudLogout();
        } catch {
            // ignore network errors on logout
        }
        set({ user: null, usage: null, limits: null, credits: null });
    },
    clearSession: () => {
        set({ user: null, usage: null, limits: null, credits: null });
    },
}));
