import { useEffect, useState } from "react";

/**
 * 返回 value 的防抖副本：输入停止 delayMs 后才更新。
 * 用于搜索框等「每次按键都会触发查询」的场景，避免每键一次请求。
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
    const [debounced, setDebounced] = useState(value);

    useEffect(() => {
        const timer = window.setTimeout(() => setDebounced(value), delayMs);
        return () => window.clearTimeout(timer);
    }, [value, delayMs]);

    return debounced;
}
