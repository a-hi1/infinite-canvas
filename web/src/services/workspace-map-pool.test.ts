import { describe, expect, it } from "vitest";

import { mapPool } from "./workspace-api";

describe("mapPool", () => {
    it("runs all items with concurrency cap", async () => {
        const seen: number[] = [];
        let active = 0;
        let maxActive = 0;
        const results = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            seen.push(n);
            await new Promise((r) => setTimeout(r, 5));
            active -= 1;
            return n * 10;
        });
        expect(results).toEqual([10, 20, 30, 40, 50]);
        expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
        expect(maxActive).toBeLessThanOrEqual(2);
    });

    it("handles empty list", async () => {
        const results = await mapPool([], 3, async (n: number) => n);
        expect(results).toEqual([]);
    });
});
