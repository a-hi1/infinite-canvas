import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    userId: "user-a",
    uploadCloudBlob: vi.fn(),
    getImageBlob: vi.fn(),
    getMediaBlob: vi.fn(),
}));

vi.mock("@/services/cloud-api", () => ({
    downloadCloudBlobByKey: vi.fn(),
    isCloudApiError: () => false,
    uploadCloudBlob: mocks.uploadCloudBlob,
}));

vi.mock("@/services/image-storage", () => ({
    getImageBlob: mocks.getImageBlob,
    setImageBlob: vi.fn(),
}));

vi.mock("@/services/file-storage", () => ({
    getMediaBlob: mocks.getMediaBlob,
    setMediaBlob: vi.fn(),
}));

vi.mock("@/stores/use-auth-store", () => ({
    useAuthStore: {
        getState: () => ({ user: { id: mocks.userId } }),
    },
}));

import { uploadReferencedCloudBlobs } from "@/services/cloud-blob-sync";

beforeEach(() => {
    mocks.userId = "user-a";
    mocks.uploadCloudBlob.mockReset();
    mocks.getImageBlob.mockReset();
    mocks.getMediaBlob.mockReset();
    mocks.getImageBlob.mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    mocks.getMediaBlob.mockResolvedValue(new Blob(["media"], { type: "video/mp4" }));
    mocks.uploadCloudBlob.mockResolvedValue({ id: "cloud-file" });
});

describe("uploadReferencedCloudBlobs", () => {
    it("coalesces concurrent uploads for the same account and storage key", async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        mocks.uploadCloudBlob.mockImplementation(async () => {
            await pending;
            return { id: "cloud-file" };
        });

        const key = "image:concurrent-test";
        const first = uploadReferencedCloudBlobs({ storageKey: key });
        const second = uploadReferencedCloudBlobs({ storageKey: key });
        await vi.waitFor(() => expect(mocks.uploadCloudBlob).toHaveBeenCalledTimes(1));
        release();

        await expect(first).resolves.toEqual({ uploaded: 1, skipped: 0 });
        await expect(second).resolves.toEqual({ uploaded: 0, skipped: 1 });
    });

    it("skips later sync passes after a successful upload", async () => {
        const key = "video:cached-test";
        await expect(uploadReferencedCloudBlobs({ storageKey: key })).resolves.toEqual({ uploaded: 1, skipped: 0 });
        await expect(uploadReferencedCloudBlobs({ storageKey: key })).resolves.toEqual({ uploaded: 0, skipped: 1 });
        expect(mocks.uploadCloudBlob).toHaveBeenCalledTimes(1);
    });

    it("does not cache a failed upload", async () => {
        const key = "audio:retry-test";
        mocks.uploadCloudBlob.mockRejectedValueOnce(new Error("temporary failure"));

        await expect(uploadReferencedCloudBlobs({ storageKey: key })).resolves.toEqual({ uploaded: 0, skipped: 1 });
        await expect(uploadReferencedCloudBlobs({ storageKey: key })).resolves.toEqual({ uploaded: 1, skipped: 0 });
        expect(mocks.uploadCloudBlob).toHaveBeenCalledTimes(2);
    });

    it("isolates the successful-upload cache by account", async () => {
        const key = "image:account-test";
        await uploadReferencedCloudBlobs({ storageKey: key });
        mocks.userId = "user-b";
        await uploadReferencedCloudBlobs({ storageKey: key });
        expect(mocks.uploadCloudBlob).toHaveBeenCalledTimes(2);
    });
});
