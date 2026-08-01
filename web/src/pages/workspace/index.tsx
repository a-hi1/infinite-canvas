import { App, Button, Empty, Form, Input, Modal, Spin, Tag } from "antd";
import { LogIn, Plus, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { AuthModal } from "@/components/layout/auth-modal";
import { useAuthStore } from "@/stores/use-auth-store";
import {
    clearLastWorkspaceId,
    getLastWorkspaceId,
    setLastWorkspaceId,
    shouldStayOnWorkspaceList,
} from "@/lib/workspace-preference";
import {
    createWorkspace,
    joinWorkspace,
    listWorkspaces,
    type WorkspaceSummary,
} from "@/services/workspace-api";
import { isCloudApiError } from "@/services/cloud-api";

export default function WorkspaceListPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const location = useLocation();
    const stayOnList = shouldStayOnWorkspaceList(location.search);
    const user = useAuthStore((s) => s.user);
    // Depend on stable identity only — account popover refreshUsage must not reload the list.
    const userId = user?.id || "";
    const [authOpen, setAuthOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [redirecting, setRedirecting] = useState(() => Boolean(userId && !stayOnList && getLastWorkspaceId()));
    const [items, setItems] = useState<WorkspaceSummary[]>([]);
    const [createOpen, setCreateOpen] = useState(false);
    const [joinOpen, setJoinOpen] = useState(false);
    const [createForm] = Form.useForm<{ name: string }>();
    const [joinForm] = Form.useForm<{ inviteCode: string }>();
    const [busy, setBusy] = useState(false);

    const openWorkspace = useCallback(
        (workspaceId: string, options?: { replace?: boolean }) => {
            setLastWorkspaceId(workspaceId);
            navigate(`/workspace/${workspaceId}`, { replace: Boolean(options?.replace) });
        },
        [navigate],
    );

    const load = useCallback(async () => {
        if (!userId) {
            setItems([]);
            setRedirecting(false);
            return;
        }
        setLoading(true);
        try {
            const data = await listWorkspaces();
            const list = data.items || [];
            setItems(list);

            // Default: re-enter last opened workspace without forcing another pick.
            if (!stayOnList) {
                const lastId = getLastWorkspaceId();
                if (lastId) {
                    const hit = list.find((ws) => ws.id === lastId);
                    if (hit) {
                        setRedirecting(true);
                        openWorkspace(hit.id, { replace: true });
                        return;
                    }
                    clearLastWorkspaceId();
                }
            }
            setRedirecting(false);
        } catch (error) {
            setRedirecting(false);
            message.error(error instanceof Error ? error.message : "加载工作空间失败");
        } finally {
            setLoading(false);
        }
    }, [message, openWorkspace, stayOnList, userId]);

    useEffect(() => {
        void load();
    }, [load]);

    const handleCreate = async () => {
        try {
            const values = await createForm.validateFields();
            setBusy(true);
            const ws = await createWorkspace({ name: values.name.trim() });
            message.success("工作空间已创建");
            setCreateOpen(false);
            createForm.resetFields();
            openWorkspace(ws.id);
        } catch (error) {
            if (isCloudApiError(error) || error instanceof Error) {
                if ((error as { errorFields?: unknown }).errorFields) return;
                message.error(error instanceof Error ? error.message : "创建失败");
            }
        } finally {
            setBusy(false);
        }
    };

    const handleJoin = async () => {
        try {
            const values = await joinForm.validateFields();
            setBusy(true);
            const ws = await joinWorkspace({ inviteCode: values.inviteCode.trim() });
            message.success("已加入工作空间");
            setJoinOpen(false);
            joinForm.resetFields();
            openWorkspace(ws.id);
        } catch (error) {
            if ((error as { errorFields?: unknown }).errorFields) return;
            message.error(error instanceof Error ? error.message : "加入失败");
        } finally {
            setBusy(false);
        }
    };

    if (!user) {
        return (
            <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
                <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                    <div className="mx-auto max-w-4xl px-6 py-12">
                        <div className="rounded-2xl border border-dashed border-stone-300 bg-card/60 p-10 text-center dark:border-stone-700">
                            <Users className="mx-auto mb-4 size-10 text-stone-400" />
                            <h1 className="text-xl font-semibold text-stone-900 dark:text-stone-100">工作空间</h1>
                            <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
                                登录后可创建或加入协作空间，把选中的资产与生成结果分享给小团队，并同步进度。
                                <br />
                                不会自动上传你的全部本地内容。
                            </p>
                            <Button type="primary" className="mt-6" icon={<LogIn className="size-4" />} onClick={() => setAuthOpen(true)}>
                                登录后使用
                            </Button>
                            <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
                        </div>
                    </div>
                </main>
            </div>
        );
    }

    if (redirecting || (loading && !stayOnList && getLastWorkspaceId())) {
        return (
            <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
                <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                    <div className="flex flex-col items-center gap-3 text-sm text-stone-500">
                        <Spin />
                        <span>正在进入最近使用的工作空间…</span>
                    </div>
                </main>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="mx-auto max-w-5xl px-6 py-8 pb-12">
                    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
                        <div>
                            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">工作空间</h1>
                            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                                显式分享素材与生成结果，同步进度。与「我的资产 · 同步云端」相互独立。
                                {stayOnList ? " 选择后会记住，下次顶栏进入将直接打开。" : ""}
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button onClick={() => setJoinOpen(true)}>用邀请码加入</Button>
                            <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                                创建空间
                            </Button>
                        </div>
                    </div>

                    {loading ? (
                        <div className="flex min-h-48 items-center justify-center">
                            <Spin />
                        </div>
                    ) : items.length ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                            {items.map((ws) => (
                                <button
                                    key={ws.id}
                                    type="button"
                                    className="rounded-xl border border-stone-200 bg-card/90 p-4 text-left shadow-sm backdrop-blur-sm transition hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600"
                                    onClick={() => openWorkspace(ws.id)}
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="truncate text-base font-medium text-stone-900 dark:text-stone-100">{ws.name}</div>
                                            <div className="mt-1 text-xs text-stone-500">
                                                {ws.member_count ?? "—"} 名成员 · 更新 {ws.updated_at ? new Date(ws.updated_at).toLocaleString() : "—"}
                                            </div>
                                        </div>
                                        <Tag className="m-0 shrink-0">{ws.role === "owner" ? "所有者" : "成员"}</Tag>
                                    </div>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <Empty
                            description="还没有工作空间。创建一个，或用同事发来的邀请码加入。"
                            className="rounded-xl border border-dashed border-stone-300 bg-card/70 py-16 dark:border-stone-700"
                        >
                            <div className="flex justify-center gap-2">
                                <Button onClick={() => setJoinOpen(true)}>加入</Button>
                                <Button type="primary" onClick={() => setCreateOpen(true)}>
                                    创建
                                </Button>
                            </div>
                        </Empty>
                    )}
                </div>

                <Modal
                    title="创建工作空间"
                    open={createOpen}
                    onCancel={() => setCreateOpen(false)}
                    onOk={() => void handleCreate()}
                    confirmLoading={busy}
                    okText="创建"
                    destroyOnHidden
                >
                    <Form form={createForm} layout="vertical" className="mt-2">
                        <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }, { max: 80, message: "最多 80 字" }]}>
                            <Input placeholder="例如：渔火分镜协作" maxLength={80} />
                        </Form.Item>
                    </Form>
                </Modal>

                <Modal
                    title="用邀请码加入"
                    open={joinOpen}
                    onCancel={() => setJoinOpen(false)}
                    onOk={() => void handleJoin()}
                    confirmLoading={busy}
                    okText="加入"
                    destroyOnHidden
                >
                    <Form form={joinForm} layout="vertical" className="mt-2">
                        <Form.Item
                            name="inviteCode"
                            label="空间邀请码"
                            extra="这是工作空间邀请码，不是注册账号用的站点邀请码。"
                            rules={[{ required: true, message: "请输入邀请码" }]}
                        >
                            <Input placeholder="粘贴同事分享的邀请码" autoComplete="off" />
                        </Form.Item>
                    </Form>
                </Modal>
            </main>
        </div>
    );
}
