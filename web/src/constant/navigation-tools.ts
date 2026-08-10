import { Clapperboard, FileText, ImagePlus, Images, Maximize2, Settings2, Users, Video } from "lucide-react";

import { isDirectorDeskEnabled } from "@/lib/director-desk";

const baseNavigationTools = [
    {
        slug: "canvas",
        label: "我的画布",
        icon: Maximize2,
    },
    {
        slug: "image",
        label: "生图工作台",
        icon: ImagePlus,
    },
    {
        slug: "video",
        label: "视频创作台",
        icon: Video,
    },
    {
        slug: "prompts",
        label: "提示词库",
        icon: FileText,
    },
    {
        slug: "assets",
        label: "我的资产",
        icon: Images,
    },
    {
        slug: "workspace",
        label: "工作空间",
        icon: Users,
    },
    {
        slug: "director-desk",
        label: "3D导演台",
        icon: Clapperboard,
        /** 打开同域 iframe 弹层，不走路由页；可由 feature flag 隐藏 */
        action: "open-director-desk" as const,
    },
    {
        slug: "config",
        label: "配置",
        icon: Settings2,
        /** 打开配置弹窗，不走路由页 */
        action: "open-config" as const,
    },
] as const;

/** 运行时按开关过滤；关闭后顶栏/移动端不展示导演台入口。 */
export const navigationTools = baseNavigationTools.filter((tool) => {
    if ("action" in tool && tool.action === "open-director-desk") return isDirectorDeskEnabled();
    return true;
}) as unknown as typeof baseNavigationTools;

export type NavigationToolSlug = (typeof baseNavigationTools)[number]["slug"];
