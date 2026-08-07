import { describe, expect, it } from "vitest";

import {
  describeGrokMultiImagePublicCapability,
  hostGrokCreatePaths,
  hostSeedanceRelayCreatePath,
  isNewApiStyleVideoHost,
  isPrivateNewApiBaseUrl,
  resolveVideoHostKind,
  resolveVideoHostProfile,
} from "@/lib/video-host-profile";

describe("video-host-profile", () => {
  it("classifies openai2api / codex2api / private New API hosts", () => {
    expect(resolveVideoHostKind("http://openai2api.com:3000")).toBe("openai2api");
    expect(resolveVideoHostKind("https://www.codex2api.com/v1")).toBe("codex2api");
    expect(resolveVideoHostKind("https://api.x.ai/v1")).toBe("xai");
    expect(resolveVideoHostKind("http://192.168.1.8:3000")).toBe("private-new-api");
    expect(isPrivateNewApiBaseUrl("http://openai2api.com:3000")).toBe(false);
    expect(isNewApiStyleVideoHost("http://openai2api.com:3000")).toBe(true);
    expect(isNewApiStyleVideoHost("http://192.168.1.8:3000")).toBe(true);
    expect(isNewApiStyleVideoHost("https://www.codex2api.com/v1")).toBe(false);
  });

  it("openai2api Grok paths never include /videos; Seedance relay is /video/generations", () => {
    const base = "http://openai2api.com:3000";
    const profile = resolveVideoHostProfile(base);
    expect(profile.kind).toBe("openai2api");
    expect(profile.allowGrokOpenAiVideosFallback).toBe(false);
    expect(profile.compressLikeRelay).toBe(true);
    expect(hostGrokCreatePaths(base, "grok-imagine-video-1.5")).toEqual(["/video/generations"]);
    expect(hostGrokCreatePaths(base, "grok-imagine-video")).not.toContain("/videos");
    expect(hostGrokCreatePaths(base, "grok-imagine-video")).not.toContain("/videos/generations");
    expect(hostSeedanceRelayCreatePath(base)).toBe("/video/generations");
  });

  it("codex2api Grok only /videos/generations; multi-image capability is fragile", () => {
    const base = "https://www.codex2api.com/v1";
    expect(hostGrokCreatePaths(base, "grok-imagine-video")).toEqual(["/videos/generations"]);
    expect(resolveVideoHostProfile(base).grokMultiImageCapability).toBe("fragile");
    const cap = describeGrokMultiImagePublicCapability(base);
    expect(cap.capability).toBe("fragile");
    expect(cap.summary).toMatch(/完整多图/);
  });

  it("describes openai2api public multi-image as local full-ref send + channel-gated", () => {
    const cap = describeGrokMultiImagePublicCapability("http://openai2api.com:3000");
    expect(cap.capability).toBe("supported");
    expect(cap.summary).toMatch(/不静默只发第一张/);
    expect(cap.summary).toMatch(/渠道类型|multi-reference/i);
  });

  it("private New API Grok is single /video/generations", () => {
    expect(hostGrokCreatePaths("http://192.168.1.20:3000", "home::grok-imagine-video")).toEqual(["/video/generations"]);
  });
});
