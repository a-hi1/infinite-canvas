import { describe, expect, it } from "vitest";

import { BYOK_IMAGE_REFERENCE_LIMIT, PLATFORM_IMAGE_REFERENCE_LIMIT, resolveImageReferenceLimit, SCRIPT_IMAGE_REFERENCE_LIMIT } from "@/lib/image-reference-limits";

describe("resolveImageReferenceLimit", () => {
    it("keeps platform path at 4", () => {
        expect(resolveImageReferenceLimit({ platform: true })).toBe(PLATFORM_IMAGE_REFERENCE_LIMIT);
        expect(PLATFORM_IMAGE_REFERENCE_LIMIT).toBe(4);
    });

    it("raises BYOK and script built-in caps to 6", () => {
        expect(resolveImageReferenceLimit({})).toBe(BYOK_IMAGE_REFERENCE_LIMIT);
        expect(resolveImageReferenceLimit({ script: true })).toBe(SCRIPT_IMAGE_REFERENCE_LIMIT);
        expect(BYOK_IMAGE_REFERENCE_LIMIT).toBe(6);
        expect(SCRIPT_IMAGE_REFERENCE_LIMIT).toBe(6);
    });

    it("prefers platform over script when both flags set", () => {
        expect(resolveImageReferenceLimit({ platform: true, script: true })).toBe(4);
    });
});
