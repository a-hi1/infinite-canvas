import type { CSSProperties } from "react";
import { Collapse, Modal, Tag, Timeline } from "antd";
import { useVersionCheck } from "@/hooks/use-version-check";
import { APP_VERSION } from "@/constant/env";
import type { ReleaseInfo } from "@/lib/release";

function getTagColor(type: string) {
    if (type === "新增") return "green";
    if (type === "修复") return "red";
    if (type === "调整") return "blue";
    if (type === "文档") return "purple";
    if (type === "优化") return "default";
    return "default";
}

function getReleaseTitle(version: string) {
    return version === "Unreleased" ? "未发布 / 本机增量" : version;
}

function ReleaseTimeline({
    releases,
    highlightLatest,
    latestVersion,
    showCurrentTag,
}: {
    releases: ReleaseInfo[];
    highlightLatest?: boolean;
    latestVersion?: string;
    showCurrentTag?: boolean;
}) {
    if (!releases.length) {
        return <div className="py-2 text-sm text-stone-500 dark:text-stone-400">暂无条目</div>;
    }

    return (
        <Timeline
            items={releases.map((release) => ({
                content: (
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{getReleaseTitle(release.version)}</span>
                            {release.date ? <span className="text-xs text-stone-500 dark:text-stone-400">{release.date}</span> : null}
                            <div className="flex min-w-0 items-center gap-1.5">
                                {highlightLatest && latestVersion && release.version === latestVersion ? <Tag color="green">上游最新</Tag> : null}
                                {showCurrentTag && release.version === APP_VERSION ? <Tag>当前本机</Tag> : null}
                            </div>
                        </div>
                        <div className="mt-2 space-y-1.5">
                            {release.items.map((item, index) => (
                                <div key={`${release.version}-${index}`} className="flex items-start gap-2 text-sm leading-6 text-stone-700 dark:text-stone-300">
                                    <Tag color={getTagColor(item.type)} className="m-0 mt-0.5 shrink-0 whitespace-nowrap">
                                        {item.type}
                                    </Tag>
                                    <span className="min-w-0 flex-1">{item.content}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                ),
            }))}
        />
    );
}

type VersionReleaseModalProps = {
    className?: string;
    style?: CSSProperties;
};

export function VersionReleaseModal({ className, style }: VersionReleaseModalProps) {
    const { open, setOpen, openReleaseModal, latestVersion, localReleases, upstreamReleases, checking, hasNewVersion, checkLatestRelease } = useVersionCheck();

    return (
        <>
            <button
                type="button"
                className={className || "shrink-0 cursor-pointer text-xs font-medium text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-white"}
                style={style}
                onClick={openReleaseModal}
                title="查看版本更新（本机 + 上游参考）"
            >
                <span className="relative inline-flex">
                    {APP_VERSION}
                    {hasNewVersion ? <span className="absolute -right-1.5 -top-1 size-1.5 rounded-full bg-green-500" /> : null}
                </span>
            </button>
            <Modal title="版本更新" open={open} width={720} centered footer={null} onCancel={() => setOpen(false)}>
                <div className="mb-5 grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs text-stone-500 dark:text-stone-400">当前本机版本</div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{APP_VERSION}</div>
                        <div className="mt-1 text-[11px] leading-4 text-stone-400 dark:text-stone-500">来自本仓库 VERSION / 构建时打入</div>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-xs text-stone-500 dark:text-stone-400">上游最新（参考）</div>
                            <button
                                type="button"
                                className="cursor-pointer bg-transparent p-0 text-[11px] font-normal text-stone-400 underline-offset-2 transition hover:text-stone-700 hover:underline dark:text-stone-500 dark:hover:text-stone-300"
                                onClick={() => void checkLatestRelease(true)}
                            >
                                {checking ? "检查中..." : "检查更新"}
                            </button>
                        </div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{latestVersion}</div>
                        <div className="mt-1 text-[11px] leading-4 text-stone-400 dark:text-stone-500">
                            basketikun 远程 · {hasNewVersion ? "版本号高于本机，仅供对照" : "仅供对照，不会覆盖本机功能"}
                        </div>
                    </div>
                </div>

                <div className="max-h-[56vh] space-y-4 overflow-y-auto pr-1">
                    <section>
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">本机更新</span>
                            <Tag color="blue">自用构建</Tag>
                            <span className="text-xs text-stone-500 dark:text-stone-400">来自本仓库 CHANGELOG.md，含自研与已移植能力</span>
                        </div>
                        <ReleaseTimeline releases={localReleases} showCurrentTag />
                    </section>

                    <Collapse
                        bordered={false}
                        className="bg-transparent [&_.ant-collapse-header]:px-0! [&_.ant-collapse-content-box]:px-0!"
                        items={[
                            {
                                key: "upstream",
                                label: (
                                    <span className="text-sm text-stone-600 dark:text-stone-300">
                                        上游更新（默认折叠 · 点击展开对照）
                                        {upstreamReleases.length ? (
                                            <span className="ml-2 text-xs font-normal text-stone-400">
                                                {latestVersion} · {upstreamReleases.length} 个版本段
                                            </span>
                                        ) : checking ? (
                                            <span className="ml-2 text-xs font-normal text-stone-400">加载中…</span>
                                        ) : (
                                            <span className="ml-2 text-xs font-normal text-stone-400">检查更新后可查看</span>
                                        )}
                                    </span>
                                ),
                                children: (
                                    <div className="rounded-lg border border-dashed border-stone-200 bg-stone-50/60 p-3 dark:border-stone-700 dark:bg-stone-900/40">
                                        <p className="mb-3 text-xs leading-5 text-stone-500 dark:text-stone-400">
                                            以下为上游公开仓库 changelog，仅作功能对照；本站禁止整仓 merge，移植按矩阵切片进行。
                                        </p>
                                        <ReleaseTimeline releases={upstreamReleases} highlightLatest latestVersion={latestVersion} />
                                    </div>
                                ),
                            },
                        ]}
                    />
                </div>
            </Modal>
        </>
    );
}
