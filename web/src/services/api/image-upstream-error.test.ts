import axios from "axios";
import { describe, expect, it } from "vitest";

import { isPermanentImageUpstreamFailure } from "@/services/api/image";

function axiosError(status: number, data: unknown) {
    return new axios.AxiosError("fail", "ERR_BAD_RESPONSE", undefined, undefined, {
        status,
        statusText: "Error",
        headers: {},
        config: {} as never,
        data,
    });
}

describe("isPermanentImageUpstreamFailure", () => {
    it("treats New API 503 no-channel as permanent", () => {
        const error = axiosError(503, {
            error: { message: "No available channel for model grok-imagine-image-edit", type: "new_api_error" },
        });
        expect(isPermanentImageUpstreamFailure(error)).toBe(true);
    });

    it("treats auth failures as permanent", () => {
        expect(isPermanentImageUpstreamFailure(axiosError(401, { error: { message: "Invalid token" } }))).toBe(true);
        expect(isPermanentImageUpstreamFailure(axiosError(403, { error: { message: "forbidden" } }))).toBe(true);
    });

    it("does not mark ordinary 400 as permanent", () => {
        const error = axiosError(400, { error: { message: "invalid image field" } });
        expect(isPermanentImageUpstreamFailure(error)).toBe(false);
    });
});
