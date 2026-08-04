import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { APP_VERSION } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";

/** 仅作参考：上游 basketikun 的版本与更新日志，不覆盖本机 CHANGELOG */
const upstreamVersionUrl = "https://raw.githubusercontent.com/basketikun/infinite-canvas/main/VERSION";
const upstreamChangelogUrl = "https://raw.githubusercontent.com/basketikun/infinite-canvas/main/CHANGELOG.md";

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

function toVersionParts(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    const latest = toVersionParts(latestVersion);
    const current = toVersionParts(currentVersion);
    if (!latest || !current) return false;
    return latest.some((value, index) => value > current[index] && latest.slice(0, index).every((part, prevIndex) => part === current[prevIndex]));
}

export function useVersionCheck() {
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    /** 上游 VERSION 文案；失败时回退为本机版本，避免误显示「有更新」 */
    const [upstreamLatestVersion, setUpstreamLatestVersion] = useState(currentVersion);
    const [upstreamReleases, setUpstreamReleases] = useState<ReleaseInfo[]>([]);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const hasNewVersion = isNewerVersion(upstreamLatestVersion, currentVersion);

    const checkUpstreamVersion = useCallback(async () => {
        try {
            const response = await fetch(upstreamVersionUrl);
            if (!response.ok) return false;
            const version = await response.text();
            setUpstreamLatestVersion(version.trim() || currentVersion);
            return true;
        } catch {
            return false;
        }
    }, [currentVersion]);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            try {
                const [versionResponse, changelogResponse] = await Promise.all([fetch(upstreamVersionUrl), fetch(upstreamChangelogUrl)]);
                if (!versionResponse.ok) throw new Error("版本读取失败");
                if (!changelogResponse.ok) throw new Error("更新日志读取失败");
                const [version, changelog] = await Promise.all([versionResponse.text(), changelogResponse.text()]);
                setUpstreamLatestVersion(version.trim() || currentVersion);
                // 只写入上游分区，绝不覆盖构建时打进包的本机 releases
                setUpstreamReleases(changelog.trim() ? parseChangelog(changelog) : []);
                if (showMessage) message.success("已获取上游最新版本信息");
                return true;
            } catch {
                if (showMessage) message.error("获取上游版本信息失败");
                return false;
            } finally {
                setChecking(false);
            }
        },
        [currentVersion, message],
    );

    useEffect(() => {
        void checkUpstreamVersion();
    }, [checkUpstreamVersion]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void checkLatestRelease();
    }, [checkLatestRelease]);

    return {
        open,
        setOpen,
        openReleaseModal,
        /** 本机构建版本（VERSION 文件） */
        currentVersion,
        /** 上游 basketikun 最新版本号（参考） */
        latestVersion: upstreamLatestVersion,
        upstreamLatestVersion,
        /** 本机 CHANGELOG 解析结果，始终展示 */
        localReleases,
        /** 上游 CHANGELOG，默认折叠展示 */
        upstreamReleases,
        /** @deprecated 兼容旧调用：等同 localReleases，勿再被上游覆盖 */
        releases: localReleases,
        checking,
        hasNewVersion,
        checkLatestRelease,
    };
}
