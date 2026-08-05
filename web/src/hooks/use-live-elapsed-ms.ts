import { useEffect, useState } from "react";

/**
 * Live wall-clock elapsed ms from a start timestamp while `active`.
 * Used by workbench history cards so concurrent "生成中" rows tick past 0秒.
 */
export function useLiveElapsedMs(startedAt: number | undefined, active: boolean): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [active, startedAt]);

    if (!active || !startedAt) return 0;
    return Math.max(0, now - startedAt);
}
