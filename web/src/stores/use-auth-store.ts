import { create } from "zustand";

import { cloudLogin, cloudLogout, cloudRegister, getCloudMe, type CloudUser } from "@/services/cloud-api";

type AuthState = {
    hydrated: boolean;
    user: CloudUser | null;
    hydrate: () => Promise<void>;
    login: (email: string, password: string) => Promise<void>;
    register: (input: { email: string; password: string; displayName?: string; inviteCode?: string }) => Promise<void>;
    logout: () => Promise<void>;
};

export const useAuthStore = create<AuthState>((set) => ({
    hydrated: false,
    user: null,
    hydrate: async () => {
        try {
            const data = await getCloudMe();
            set({ user: data.user || null, hydrated: true });
        } catch {
            // API 不可用时保持未登录，不影响本地模式
            set({ user: null, hydrated: true });
        }
    },
    login: async (email, password) => {
        const data = await cloudLogin({ email, password });
        // 以 /auth/me 再确认一次 Cookie 会话，避免只信内存 user、刷新后像“掉登录”
        try {
            const me = await getCloudMe();
            set({ user: me.user || data.user, hydrated: true });
        } catch {
            set({ user: data.user, hydrated: true });
        }
    },
    register: async (input) => {
        const data = await cloudRegister(input);
        try {
            const me = await getCloudMe();
            set({ user: me.user || data.user, hydrated: true });
        } catch {
            set({ user: data.user, hydrated: true });
        }
    },
    logout: async () => {
        try {
            await cloudLogout();
        } catch {
            // ignore network errors on logout
        }
        set({ user: null });
    },
}));
