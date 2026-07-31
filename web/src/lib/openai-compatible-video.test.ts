import { describe, expect, it } from "vitest";

import {
    buildSoraVeoFormFieldCandidates,
    isInvalidVideoRequestBodyError,
    isMissingSoraVeoCreatePathError,
    isMultiImageSoraVeoReferenceField,
    isSoraOrVeoVideoModel,
    isSoraVideoModel,
    isUnavailableVideoChannelError,
    isUnsupportedVideoModelError,
    isVeoI2vModel,
    isVeoVideoModel,
    normalizeSoraSeconds,
    normalizeSoraSize,
    normalizeVeoSeconds,
    normalizeVeoSize,
    parseSupportedVideoModelsFromError,
    preferSoraRelayModelName,
    preferVeoI2vModelName,
    shouldSkipToNextVideoModelName,
    shouldTryNextSoraVeoCreatePath,
    soraRequestModelCandidates,
    soraSizeOptionsForModel,
    soraVeoCreatePathCandidates,
    soraVeoReferenceImageLimit,
    VEO_REFERENCE_LIMITS,
    withSoraRelayModelAliases,
} from "@/lib/openai-compatible-video";

describe("Sora / Veo model detection", () => {
    it("detects sora and veo names including channel-qualified values", () => {
        expect(isSoraVideoModel("sora-2")).toBe(true);
        expect(isSoraVideoModel("sora::sora-2")).toBe(true);
        expect(isVeoVideoModel("veo-3.1")).toBe(true);
        expect(isVeoVideoModel("sora::veo-3.1-fast")).toBe(true);
        expect(isVeoVideoModel("veo-3.1-i2v")).toBe(true);
        expect(isVeoI2vModel("veo-3.1-i2v")).toBe(true);
        expect(isVeoI2vModel("veo-3.1")).toBe(false);
        expect(isSoraOrVeoVideoModel("gpt-4o")).toBe(false);
        expect(isSoraOrVeoVideoModel("grok-imagine-video")).toBe(false);
    });

    it("prefers matching veo i2v variants from channel inventory", () => {
        expect(preferVeoI2vModelName("veo-3.1", ["veo-3.1", "veo-3.1-i2v", "sora-2"])).toBe("veo-3.1-i2v");
        expect(preferVeoI2vModelName("veo-3.1-fast", ["veo-3.1-fast", "veo-3.1-i2v"])).toBe("veo-3.1-i2v");
        expect(preferVeoI2vModelName("veo-3.1-fast", ["veo-3.1-fast", "veo-3.1-fast-i2v"])).toBe("veo-3.1-fast-i2v");
        expect(preferVeoI2vModelName("veo-3.1-i2v", ["veo-3.1", "veo-3.1-i2v"])).toBe("veo-3.1-i2v");
        expect(preferVeoI2vModelName("sora-2", ["sora-2", "veo-3.1-i2v"])).toBe("sora-2");
        expect(preferVeoI2vModelName("veo-3.1", ["veo-3.1", "sora-2"])).toBe("veo-3.1");
    });

    it("maps sora-2 to azure-sora when inventory only has azure alias", () => {
        expect(preferSoraRelayModelName("sora-2", ["azure-sora", "kling", "firefly-video"])).toBe("azure-sora");
        expect(preferSoraRelayModelName("sora-2-pro", ["azure-sora", "azure-sora-pro"])).toBe("azure-sora-pro");
        // 清单已有原名则不改
        expect(preferSoraRelayModelName("sora-2", ["sora-2", "azure-sora"])).toBe("sora-2");
        expect(preferSoraRelayModelName("azure-sora", ["azure-sora"])).toBe("azure-sora");
    });

    it("builds sora request model candidates with user selection first, azure as fallback", () => {
        // 上游就叫 sora-2：首包必须是 sora-2，azure 仅作后续回退
        const candidates = soraRequestModelCandidates("sora-2", ["kling", "firefly-video"]);
        expect(candidates[0]).toBe("sora-2");
        expect(candidates).toContain("azure-sora");
        expect(soraRequestModelCandidates("sora-2", ["azure-sora"])[0]).toBe("sora-2");
        expect(soraRequestModelCandidates("sora-2", ["sora-2", "kling"])[0]).toBe("sora-2");
        expect(soraRequestModelCandidates("sora-2", ["sora-2", "azure-sora"])[0]).toBe("sora-2");
        expect(soraRequestModelCandidates("sora-2", ["sora-2", "azure-sora"])).toContain("azure-sora");
        // 用户直接选 azure-sora 时保持优先
        expect(soraRequestModelCandidates("azure-sora", ["sora-2", "azure-sora"])[0]).toBe("azure-sora");
        expect(soraRequestModelCandidates("sora-2-pro", ["sora-2-pro"])[0]).toBe("sora-2-pro");
    });

    it("parses Supported models from 422 validation errors", () => {
        const text =
            'video submit failed: 422 {"error_code":"validation_error","message":"sora sora-2 is not supported for ModelModality.VIDEO endpoint. Supported models: [\'azure-sora\', \'firefly-video\', \'kling\']"} (status=422)';
        expect(isUnsupportedVideoModelError(new Error(text))).toBe(true);
        expect(shouldSkipToNextVideoModelName(new Error(text))).toBe(true);
        expect(parseSupportedVideoModelsFromError(text)).toEqual(["azure-sora", "firefly-video", "kling"]);
        // 用户粘贴的截断括号版本
        const truncated =
            "video submit failed: 422 {\"error_code\":\"validation_error\",\"message\":\"sora sora-2 is not supported for ModelModality.VIDEO endpoint. Supported models: ['azure-sora', 'firefly-video', 'kling', 'kling', 'kling', 'kling', 'kling' (status=422)";
        expect(parseSupportedVideoModelsFromError(truncated)).toContain("azure-sora");
        expect(isUnsupportedVideoModelError(new Error(truncated))).toBe(true);
        expect(shouldSkipToNextVideoModelName(new Error(truncated))).toBe(true);
        // 只剩外层 submit failed + 422 也应换名，不能当最终错误
        expect(isUnsupportedVideoModelError(new Error("video submit failed: 422 (status=422)"))).toBe(true);
        expect(shouldSkipToNextVideoModelName(new Error("video submit failed: 422 (status=422)"))).toBe(true);
    });

    it("treats 503 no-distributor as channel-unavailable and skips to next model name", () => {
        const text =
            "分组 veo-sora 下模型 azure-sora 无可用渠道（distributor） (request id: 202607300153496698207868268d9d6444QAJ7G) (status=503)";
        expect(isUnavailableVideoChannelError(new Error(text))).toBe(true);
        expect(shouldSkipToNextVideoModelName(new Error(text))).toBe(true);
        expect(isUnsupportedVideoModelError(new Error(text))).toBe(false);
        expect(isUnavailableVideoChannelError(new Error("no available channel for model azure-sora"))).toBe(true);
        expect(isUnavailableVideoChannelError(new Error("401 unauthorized"))).toBe(false);
        expect(shouldSkipToNextVideoModelName(new Error("401 unauthorized"))).toBe(false);
    });

    it("limits reference images: Sora 1, Veo 3", () => {
        expect(soraVeoReferenceImageLimit("sora-2")).toBe(1);
        expect(soraVeoReferenceImageLimit("azure-sora")).toBe(1);
        expect(soraVeoReferenceImageLimit("veo-3.1")).toBe(3);
        expect(soraVeoReferenceImageLimit("veo-3.1-i2v")).toBe(3);
        expect(soraVeoReferenceImageLimit("channel::veo-3.1-fast")).toBe(VEO_REFERENCE_LIMITS.images);
        expect(isMultiImageSoraVeoReferenceField("images")).toBe(true);
        expect(isMultiImageSoraVeoReferenceField("reference_images")).toBe(true);
        expect(isMultiImageSoraVeoReferenceField("input_reference")).toBe(false);
        expect(isMultiImageSoraVeoReferenceField("file")).toBe(false);
    });

    it("injects azure-sora alias into channel model lists that only have sora-2", () => {
        expect(withSoraRelayModelAliases(["sora-2", "veo-3.1", "veo-3.1-fast", "veo-3.1-i2v"])).toEqual([
            "sora-2",
            "veo-3.1",
            "veo-3.1-fast",
            "veo-3.1-i2v",
            "azure-sora",
        ]);
        expect(withSoraRelayModelAliases(["sora-2", "azure-sora"])).toEqual(["sora-2", "azure-sora"]);
        expect(withSoraRelayModelAliases(["veo-3.1"])).toEqual(["veo-3.1"]);
        expect(withSoraRelayModelAliases(["sora-2-pro"])).toEqual(["sora-2-pro", "azure-sora", "azure-sora-pro"]);
    });
});

describe("Sora / Veo normalize helpers", () => {
    it("clamps Sora seconds to 4/8/12", () => {
        expect(normalizeSoraSeconds("")).toBe("8");
        expect(normalizeSoraSeconds("4")).toBe("4");
        expect(normalizeSoraSeconds("6")).toBe("8");
        expect(normalizeSoraSeconds("10")).toBe("8");
        expect(normalizeSoraSeconds("16")).toBe("12");
        expect(normalizeSoraSeconds("20")).toBe("12");
    });

    it("clamps Veo seconds to 4/6/8", () => {
        expect(normalizeVeoSeconds("")).toBe("6");
        expect(normalizeVeoSeconds("6")).toBe("6");
        expect(normalizeVeoSeconds("5")).toBe("4");
        expect(normalizeVeoSeconds("12")).toBe("8");
        expect(normalizeVeoSeconds("20")).toBe("8");
    });

    it("maps sora-2 sizes only to 720p landscape/portrait (New API hard check)", () => {
        expect(normalizeSoraSize("1280x720", "sora-2")).toBe("1280x720");
        expect(normalizeSoraSize("720x1280", "sora-2")).toBe("720x1280");
        expect(normalizeSoraSize("9:16", "sora-2")).toBe("720x1280");
        expect(normalizeSoraSize("auto", "sora-2")).toBe("1280x720");
        // 高清档在 sora-2 上必须降级，否则 New API 本地校验 invalid_size 或上游 invalid body
        expect(normalizeSoraSize("1792x1024", "sora-2")).toBe("1280x720");
        expect(normalizeSoraSize("1024x1792", "sora-2")).toBe("720x1280");
        expect(normalizeSoraSize("1024x1024", "sora-2")).toBe("1280x720");
    });

    it("allows pro sizes for sora-2-pro", () => {
        expect(normalizeSoraSize("1792x1024", "sora-2-pro")).toBe("1792x1024");
        expect(normalizeSoraSize("1024x1792", "sora::sora-2-pro")).toBe("1024x1792");
        expect(soraSizeOptionsForModel("sora-2").map((item) => item.value)).toEqual(["1280x720", "720x1280"]);
        expect(soraSizeOptionsForModel("sora-2-pro").length).toBe(4);
    });

    it("maps veo sizes", () => {
        expect(normalizeVeoSize("1:1")).toBe("1024x1024");
        expect(normalizeVeoSize("9:16")).toBe("720x1280");
        expect(normalizeVeoSize("1920x1080")).toBe("1280x720");
    });
});

describe("buildSoraVeoFormFieldCandidates", () => {
    it("prefers JSON text candidates without resolution_name/preset", () => {
        const candidates = buildSoraVeoFormFieldCandidates({
            model: "sora::sora-2",
            prompt: "a cat walks",
            size: "1792x1024", // 非法于 sora-2 → 应被夹到 1280x720
            videoSeconds: "10",
            hasReferences: false,
        });
        expect(candidates.length).toBeGreaterThanOrEqual(6);
        // 对齐可用脚本：首包仅 model+prompt+seconds，不先塞 size
        expect(candidates[0].encoding).toBe("json");
        expect(candidates[0].label).toBe("json:seconds-only");
        expect(candidates[0].seconds).toBe("8");
        expect(candidates[0].size).toBeUndefined();
        expect(candidates[0].model).toBe("sora-2");
        expect(candidates.some((item) => item.size === "1280x720")).toBe(true);
        expect(candidates.some((item) => item.encoding === "multipart")).toBe(true);
        expect(candidates.some((item) => item.secondsAsNumber)).toBe(true);
        expect(candidates.some((item) => item.durationField === "duration")).toBe(true);
        expect(candidates.some((item) => item.label === "json:model+prompt")).toBe(true);
        for (const item of candidates) {
            expect(JSON.stringify(item)).not.toMatch(/resolution_name|preset/);
            expect(item.withReferences).toBe(false);
        }
    });

    it("puts multipart reference candidates first for Sora I2V", () => {
        const candidates = buildSoraVeoFormFieldCandidates({
            model: "sora-2",
            prompt: "follow this image",
            size: "1280x720",
            videoSeconds: "8",
            hasReferences: true,
            hasBinaryReference: true,
        });
        expect(candidates.length).toBeGreaterThanOrEqual(4);
        expect(candidates[0].encoding).toBe("multipart");
        expect(candidates[0].withReferences).toBe(true);
        expect(candidates[0].referenceField).toBe("file");
        expect(candidates[0].multipartFileField || "input_reference").toBe("input_reference");
        expect(candidates.some((item) => item.multipartFileField === "image")).toBe(true);
        for (const item of candidates) {
            expect(item.withReferences).toBe(true);
            expect(item.referenceField).toBeTruthy();
        }
    });

    it("puts JSON reference candidates first for Veo I2V and never text-only", () => {
        const candidates = buildSoraVeoFormFieldCandidates({
            model: "veo-3.1-i2v",
            prompt: "animate",
            size: "9:16",
            videoSeconds: "6",
            hasReferences: true,
            hasBinaryReference: true,
            hasUrlReference: true,
        });
        expect(candidates[0].encoding).toBe("json");
        expect(candidates[0].withReferences).toBe(true);
        expect(candidates[0].referenceField).toBe("images");
        expect(candidates[0].size).toBe("720x1280");
        expect(candidates[0].seconds).toBe("6");
        expect(candidates.every((item) => item.withReferences)).toBe(true);
        expect(candidates.some((item) => item.encoding === "json" && item.referenceField === "input_reference")).toBe(true);
        expect(candidates.some((item) => item.encoding === "json" && item.referenceField === "image_url")).toBe(true);
        expect(candidates.some((item) => item.encoding === "json" && item.referenceField === "first_frame")).toBe(true);
        expect(candidates.some((item) => item.encoding === "multipart")).toBe(true);
        expect(candidates.some((item) => !item.withReferences)).toBe(false);
    });

    it("prioritizes images/reference_images for Veo multi-reference", () => {
        const candidates = buildSoraVeoFormFieldCandidates({
            model: "veo-3.1",
            prompt: "multi refs",
            size: "1280x720",
            videoSeconds: "6",
            hasReferences: true,
            hasBinaryReference: true,
            referenceCount: 3,
        });
        expect(candidates[0].encoding).toBe("json");
        expect(candidates[0].referenceField).toBe("images");
        expect(candidates[1].referenceField).toBe("reference_images");
        expect(candidates.every((item) => item.withReferences)).toBe(true);
        // 多图时仍可有 multipart 首帧兜底，但 JSON 数组必须更靠前
        const firstMultipart = candidates.findIndex((item) => item.encoding === "multipart");
        const firstImages = candidates.findIndex((item) => item.referenceField === "images");
        expect(firstImages).toBeGreaterThanOrEqual(0);
        expect(firstMultipart).toBeGreaterThan(firstImages);
    });

    it("drops multipart when only public URL reference is available", () => {
        const candidates = buildSoraVeoFormFieldCandidates({
            model: "sora-2",
            prompt: "from url",
            size: "1280x720",
            videoSeconds: "8",
            hasReferences: true,
            hasBinaryReference: false,
            hasUrlReference: true,
        });
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates.every((item) => item.encoding === "json")).toBe(true);
        expect(candidates.every((item) => item.withReferences)).toBe(true);
        expect(candidates.every((item) => item.referenceSource === "url")).toBe(true);
    });

    it("returns empty runnable set when hasReferences but neither binary nor url", () => {
        const candidates = buildSoraVeoFormFieldCandidates({
            model: "veo-3.1",
            prompt: "broken ref",
            size: "1280x720",
            videoSeconds: "6",
            hasReferences: true,
            hasBinaryReference: false,
            hasUrlReference: false,
        });
        expect(candidates).toEqual([]);
    });
});

describe("isInvalidVideoRequestBodyError", () => {
    it("matches New API wrapped invalid body errors", () => {
        expect(isInvalidVideoRequestBodyError(new Error('fail_to_fetch_task: {"error":{"message":"invalid request body","type":"invalid_request_error"}}'))).toBe(true);
        expect(isInvalidVideoRequestBodyError(new Error("invalid request body"))).toBe(true);
        expect(isInvalidVideoRequestBodyError(new Error("sora-2 size is invalid"))).toBe(true);
        // 用户粘贴的嵌套 envelope：code 在外层，message 里再包一层 fail_to_fetch_task
        expect(
            isInvalidVideoRequestBodyError(
                new Error(
                    '{"code":"fail_to_fetch_task","message":"{\\"code\\":\\"fail_to_fetch_task\\",\\"message\\":\\"{\\\\\\"error\\\\\\":{\\\\\\"message\\\\\\":\\\\\\"invalid request body\\\\\\",\\\\\\"type\\\\\\":\\\\\\"invalid_request_error\\\\\\"}}\\",\\"data\\":null}"}',
                ),
            ),
        ).toBe(true);
        expect(isInvalidVideoRequestBodyError(new Error("fail_to_fetch_task"))).toBe(true);
        expect(isInvalidVideoRequestBodyError(new Error("No eligible Grok media accounts"))).toBe(false);
        expect(isInvalidVideoRequestBodyError(new Error("401 unauthorized"))).toBe(false);
    });
});

describe("soraVeo create path candidates", () => {
    it("lists relay /video/generations first (veo-sora script), then official /videos", () => {
        expect(soraVeoCreatePathCandidates()).toEqual(["/video/generations", "/videos", "/videos/generations"]);
    });

    it("detects missing create paths without treating task-level 404 as path-missing", () => {
        expect(isMissingSoraVeoCreatePathError(new Error("404 page not found"))).toBe(true);
        expect(isMissingSoraVeoCreatePathError(new Error("Invalid URL"))).toBe(true);
        expect(isMissingSoraVeoCreatePathError(new Error("Method Not Allowed"))).toBe(true);
        expect(isMissingSoraVeoCreatePathError({ response: { status: 404, data: "not found" }, message: "Request failed" })).toBe(true);
        expect(isMissingSoraVeoCreatePathError({ response: { status: 405 }, message: "Request failed" })).toBe(true);
        // 任务查询 404 / 上游 body 拒收不能负缓存整条 create path
        expect(isMissingSoraVeoCreatePathError(new Error("video not found for request_id xyz"))).toBe(false);
        expect(isMissingSoraVeoCreatePathError(new Error("fail_to_fetch_task: invalid request body"))).toBe(false);
        expect(isMissingSoraVeoCreatePathError(new Error("401 unauthorized"))).toBe(false);
    });

    it("retries next create path on missing route or invalid body", () => {
        expect(shouldTryNextSoraVeoCreatePath(new Error("404 page not found"))).toBe(true);
        expect(shouldTryNextSoraVeoCreatePath(new Error("fail_to_fetch_task: invalid request body"))).toBe(true);
        expect(shouldTryNextSoraVeoCreatePath(new Error("401 unauthorized"))).toBe(false);
        expect(shouldTryNextSoraVeoCreatePath(new Error("No eligible Grok media accounts"))).toBe(false);
    });
});
