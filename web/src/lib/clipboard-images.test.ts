import { describe, expect, it } from "vitest";

import {
    clipboardImagesFromDataTransfer,
    clipboardImagesFromPasteEvent,
    shouldIgnoreClipboardPasteTarget,
} from "./clipboard-images";

describe("clipboard-images", () => {
    it("reads image files from DataTransfer.files", () => {
        const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
        const dt = {
            files: [file, new File([""], "note.txt", { type: "text/plain" })],
            items: [],
        } as unknown as DataTransfer;
        expect(clipboardImagesFromDataTransfer(dt).map((f) => f.name)).toEqual(["shot.png"]);
    });

    it("falls back to DataTransfer.items when files is empty", () => {
        const file = new File([new Uint8Array([9])], "image.png", { type: "image/png" });
        const dt = {
            files: [],
            items: [
                { kind: "string", type: "text/plain", getAsFile: () => null },
                { kind: "file", type: "image/png", getAsFile: () => file },
            ],
        } as unknown as DataTransfer;
        expect(clipboardImagesFromDataTransfer(dt)).toHaveLength(1);
        expect(clipboardImagesFromPasteEvent({ clipboardData: dt })).toHaveLength(1);
    });

    it("returns empty for missing clipboard data", () => {
        expect(clipboardImagesFromDataTransfer(null)).toEqual([]);
        expect(clipboardImagesFromPasteEvent({})).toEqual([]);
    });

    it("does not ignore non-element paste targets", () => {
        expect(shouldIgnoreClipboardPasteTarget(null)).toBe(false);
        expect(shouldIgnoreClipboardPasteTarget({} as EventTarget)).toBe(false);
    });
});
