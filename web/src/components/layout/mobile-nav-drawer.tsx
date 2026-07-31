import { Drawer } from "antd";
import { Link } from "react-router-dom";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores/use-config-store";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    return (
        <Drawer title="导航" placement="left" size={280} open={open} onClose={onClose} className="md:hidden">
            <div className="space-y-1">
                {navigationTools.map((tool) => {
                    const Icon = tool.icon;
                    const active = tool.slug === activeToolSlug;
                    const itemClass = cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-base transition",
                        active ? "bg-stone-100 font-medium text-stone-950 dark:bg-stone-800 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                    );
                    if ("action" in tool && tool.action === "open-config") {
                        return (
                            <button
                                key={tool.slug}
                                type="button"
                                className={itemClass}
                                onClick={() => {
                                    onClose();
                                    openConfigDialog(false);
                                }}
                            >
                                <Icon className="size-5" />
                                <span>{tool.label}</span>
                            </button>
                        );
                    }
                    return (
                        <Link key={tool.slug} to={`/${tool.slug}`} onClick={onClose} className={itemClass}>
                            <Icon className="size-5" />
                            <span>{tool.label}</span>
                        </Link>
                    );
                })}
            </div>
        </Drawer>
    );
}
