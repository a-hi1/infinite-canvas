import type { VideoModeGuide } from "@/lib/video-mode-guide";

type VideoModeGuideBannerProps = {
    guide: VideoModeGuide;
    /** When set, banner switches to warning style and shows this instead of the guide. */
    warning?: string | null;
    className?: string;
};

/** Compact workbench banner: title + chips + short bullets (or a readiness warning). */
export function VideoModeGuideBanner({ guide, warning, className = "" }: VideoModeGuideBannerProps) {
    if (warning) {
        return (
            <div
                className={`mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100 ${className}`}
            >
                {warning}
            </div>
        );
    }

    return (
        <div
            className={`mt-4 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300 ${className}`}
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs font-semibold text-stone-800 dark:text-stone-100">{guide.title}</span>
                <span className="text-xs text-stone-500 dark:text-stone-400">{guide.summary}</span>
            </div>
            {guide.tags?.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                    {guide.tags.map((tag) => (
                        <span
                            key={tag}
                            className="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[10px] leading-none text-stone-600 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300"
                        >
                            {tag}
                        </span>
                    ))}
                </div>
            ) : null}
            {guide.bullets?.length ? (
                <ul className="mt-1.5 space-y-0.5 text-[11px] leading-4 text-stone-500 dark:text-stone-400">
                    {guide.bullets.map((item) => (
                        <li key={item} className="flex gap-1.5">
                            <span className="mt-[0.35rem] size-1 shrink-0 rounded-full bg-stone-300 dark:bg-stone-600" />
                            <span>{item}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
