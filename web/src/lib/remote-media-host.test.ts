import { describe, expect, it } from "vitest";
import { isAllowedRemoteMediaHost, isLikelyCorsBlockedMediaHost, hostnameFromMediaUrl } from "./remote-media-host";

describe("remote-media-host", () => {
    it("allows xAI and Seedance/Volcengine CDN hosts", () => {
        expect(isAllowedRemoteMediaHost("vidgen.x.ai")).toBe(true);
        expect(isAllowedRemoteMediaHost("https://vidgen.x.ai/v/abc.mp4")).toBe(true);
        expect(isAllowedRemoteMediaHost("foo.volces.com")).toBe(true);
        expect(isAllowedRemoteMediaHost("https://vedit-xxx.tos-cn-beijing.volces.com/path/a.mp4")).toBe(true);
        expect(isAllowedRemoteMediaHost("cdn.byteimg.com")).toBe(true);
        expect(isAllowedRemoteMediaHost("ark.cn-beijing.volces.com")).toBe(true);
        expect(isAllowedRemoteMediaHost("bucket.s3.amazonaws.com")).toBe(true);
        expect(isAllowedRemoteMediaHost("media.r2.dev")).toBe(true);
    });

    it("rejects empty, private-looking bare hosts not on list", () => {
        expect(isAllowedRemoteMediaHost("")).toBe(false);
        expect(isAllowedRemoteMediaHost("evil.example.com")).toBe(false);
        expect(isAllowedRemoteMediaHost("localhost")).toBe(false);
        expect(isAllowedRemoteMediaHost("https://127.0.0.1/a.mp4")).toBe(false);
    });

    it("marks Seedance CDN as likely CORS-blocked for download-via-proxy", () => {
        expect(isLikelyCorsBlockedMediaHost("https://vidgen.x.ai/a.mp4")).toBe(true);
        expect(isLikelyCorsBlockedMediaHost("https://xx.tos-cn-beijing.volces.com/a.mp4")).toBe(true);
        expect(isLikelyCorsBlockedMediaHost("https://cdn.byteimg.com/a.mp4")).toBe(true);
        expect(isLikelyCorsBlockedMediaHost("https://bucket.s3.amazonaws.com/a.mp4")).toBe(false);
    });

    it("parses hostname from url", () => {
        expect(hostnameFromMediaUrl("https://cdn.byteimg.com/x.mp4?sig=1")).toBe("cdn.byteimg.com");
        expect(hostnameFromMediaUrl("not-a-url")).toBe("");
    });
});
