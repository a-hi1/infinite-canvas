import { useEffect, useState } from "react";
import { App, Button, Popover, Progress, Typography } from "antd";
import { LogOut, RefreshCw, UserRound } from "lucide-react";

import { useAuthStore } from "@/stores/use-auth-store";

function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatYuanFromCents(cents: number) {
    if (!Number.isFinite(cents)) return "¥0.00";
    return `¥${(cents / 100).toFixed(2)}`;
}

export function AccountPopover() {
    const { message } = App.useApp();
    const user = useAuthStore((state) => state.user);
    const usage = useAuthStore((state) => state.usage);
    const limits = useAuthStore((state) => state.limits);
    const credits = useAuthStore((state) => state.credits);
    const logout = useAuthStore((state) => state.logout);
    const refreshUsage = useAuthStore((state) => state.refreshUsage);
    const [open, setOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    useEffect(() => {
        if (!open || !user) return;
        void refreshUsage();
    }, [open, refreshUsage, user]);

    if (!user) return null;

    const used = usage?.used_bytes || 0;
    const max = limits?.max_user_bytes || 0;
    const percent = max > 0 ? Math.min(100, Math.round((used / max) * 1000) / 10) : 0;
    const nearFull = max > 0 && used / max >= 0.9;
    const balanceCents = credits?.balance_cents ?? user.credit_balance_cents ?? 0;
    const platformBilling = Boolean(credits?.platform_billing_enabled);

    const content = (
        <div className="w-72 space-y-3">
            <div>
                <div className="text-sm font-medium text-stone-900 dark:text-stone-100">{user.display_name || "已登录账号"}</div>
                <div className="mt-0.5 break-all text-xs text-stone-500 dark:text-stone-400">{user.email}</div>
                {user.plan_code ? <div className="mt-1 text-[11px] text-stone-400">套餐 {user.plan_code}</div> : null}
            </div>

            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
                <div className="mb-1 flex items-center justify-between gap-2 text-xs text-stone-500 dark:text-stone-400">
                    <span>平台积分余额</span>
                    <span className="font-medium text-stone-700 dark:text-stone-200">{formatYuanFromCents(balanceCents)}</span>
                </div>
                <div className="text-[11px] leading-5 text-stone-400">
                    {platformBilling
                        ? `平台代生成已开启${typeof credits?.image_price_cents === "number" ? `，约 ¥${(credits.image_price_cents / 100).toFixed(2)}/张` : ""}；图片工作台可开关「平台积分生图」。`
                        : "默认仍用你自己的 API Key 生成；服务器开启平台生图后，图片工作台才会出现「平台积分生图」开关。"}
                </div>
            </div>

            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
                <div className="mb-2 flex items-center justify-between gap-2 text-xs text-stone-500 dark:text-stone-400">
                    <span>云端已用容量</span>
                    <Button
                        type="text"
                        size="small"
                        className="!h-6 !px-1"
                        icon={<RefreshCw className={`size-3 ${refreshing ? "animate-spin" : ""}`} />}
                        onClick={() => {
                            setRefreshing(true);
                            void refreshUsage().finally(() => setRefreshing(false));
                        }}
                    >
                        刷新
                    </Button>
                </div>
                <Progress percent={percent} size="small" status={nearFull ? "exception" : "active"} showInfo={false} />
                <div className="mt-1 flex justify-between text-xs text-stone-600 dark:text-stone-300">
                    <span>{formatBytes(used)}</span>
                    <span>{max > 0 ? formatBytes(max) : "未配置上限"}</span>
                </div>
                {usage ? (
                    <div className="mt-2 text-[11px] text-stone-500 dark:text-stone-400">
                        云端记录 {usage.job_count || 0} 条
                        {typeof usage.image_job_count === "number" || typeof usage.video_job_count === "number"
                            ? `（图 ${usage.image_job_count || 0} / 视频 ${usage.video_job_count || 0}）`
                            : ""}
                    </div>
                ) : (
                    <div className="mt-2 text-[11px] text-stone-400">打开后自动拉取用量</div>
                )}
                {nearFull ? <Typography.Text type="danger" className="!mt-2 !block !text-[11px]">空间将满，上云可能失败，请删除部分云端历史</Typography.Text> : null}
            </div>

            <div className="text-[11px] leading-5 text-stone-500 dark:text-stone-400">
                云端仅保存登录后同步的生成结果。画布、素材、API Key 默认仍在本机；云故障不影响本地创作。
            </div>

            <Button
                block
                danger
                icon={<LogOut className="size-3.5" />}
                onClick={async () => {
                    await logout();
                    setOpen(false);
                    message.success("已退出登录");
                }}
            >
                退出登录
            </Button>
        </div>
    );

    return (
        <Popover open={open} onOpenChange={setOpen} trigger="click" placement="bottomRight" content={content}>
            <button
                type="button"
                className="mr-1 inline-flex max-w-[160px] items-center gap-1 truncate rounded-md px-1.5 py-1 text-xs text-stone-600 transition hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-white"
                title={user.email}
            >
                <UserRound className="size-3.5 shrink-0" />
                <span className="truncate">{user.display_name || user.email}</span>
            </button>
        </Popover>
    );
}
