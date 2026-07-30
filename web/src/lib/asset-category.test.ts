import { describe, expect, it } from "vitest";

import {
    ALL_CATEGORIES_VALUE,
    STANDARD_ASSET_CATEGORIES,
    UNCATEGORIZED_LABEL,
    UNCATEGORIZED_VALUE,
    assetCategoryFilterKey,
    assetCategoryLabel,
    buildAssetCategoryFilterOptions,
    canonicalizeAssetCategory,
    collectAssetCategories,
    isUncategorizedAsset,
    matchesAssetCategoryFilter,
    normalizeAssetCategory,
    resolveAssetCategoryForSave,
    resolveCategoryOrSuggest,
    suggestAssetCategory,
} from "@/lib/asset-category";

describe("asset category helpers", () => {
    it("normalizes blank category as empty", () => {
        expect(normalizeAssetCategory(undefined)).toBe("");
        expect(normalizeAssetCategory(null)).toBe("");
        expect(normalizeAssetCategory("  ")).toBe("");
        expect(normalizeAssetCategory(" 人物 ")).toBe("人物");
    });

    it("maps legacy aliases to standard categories", () => {
        expect(canonicalizeAssetCategory("角色")).toBe("人物");
        expect(canonicalizeAssetCategory("背景")).toBe("场景");
        expect(canonicalizeAssetCategory("人物")).toBe("人物");
        expect(canonicalizeAssetCategory("自定义分组")).toBe("自定义分组");
    });

    it("labels missing category as 未分类", () => {
        expect(assetCategoryLabel("")).toBe(UNCATEGORIZED_LABEL);
        expect(assetCategoryLabel("场景")).toBe("场景");
        expect(assetCategoryLabel("角色")).toBe("人物");
    });

    it("filters all / uncategorized / named categories with alias awareness", () => {
        expect(matchesAssetCategoryFilter(undefined, ALL_CATEGORIES_VALUE)).toBe(true);
        expect(matchesAssetCategoryFilter("人物", ALL_CATEGORIES_VALUE)).toBe(true);
        expect(matchesAssetCategoryFilter("", UNCATEGORIZED_VALUE)).toBe(true);
        expect(matchesAssetCategoryFilter("人物", UNCATEGORIZED_VALUE)).toBe(false);
        expect(matchesAssetCategoryFilter("人物", "人物")).toBe(true);
        expect(matchesAssetCategoryFilter("角色", "人物")).toBe(true);
        expect(matchesAssetCategoryFilter("场景", "人物")).toBe(false);
        expect(assetCategoryFilterKey("角色")).toBe("人物");
    });

    it("always lists standard categories 人物/场景/道具 first", () => {
        const names = collectAssetCategories([{ category: "自定义A" }, { category: "角色" }, {}]);
        expect(names.slice(0, STANDARD_ASSET_CATEGORIES.length)).toEqual([...STANDARD_ASSET_CATEGORIES]);
        expect(names).toContain("自定义A");
        expect(names[0]).toBe("人物");
        expect(names[1]).toBe("场景");
        expect(names[2]).toBe("道具");
    });

    it("builds filter options with 全部分类 and 未分类", () => {
        const options = buildAssetCategoryFilterOptions([{ category: "场景" }]);
        expect(options[0]).toEqual({ label: "全部分类", value: ALL_CATEGORIES_VALUE });
        expect(options.some((item) => item.value === "人物")).toBe(true);
        expect(options.some((item) => item.value === "道具")).toBe(true);
        expect(options.some((item) => item.value === UNCATEGORIZED_VALUE)).toBe(true);
    });

    it("saves form values as canonical categories", () => {
        expect(resolveAssetCategoryForSave("角色")).toBe("人物");
        expect(resolveAssetCategoryForSave(["场景"])).toBe("场景");
        expect(resolveAssetCategoryForSave("")).toBeUndefined();
        expect(resolveAssetCategoryForSave(["  "])).toBeUndefined();
    });

    it("suggests 人物/场景/道具 from title tags prompt and filename", () => {
        expect(suggestAssetCategory({ title: "女主半身肖像", tags: ["角色设定"] })).toBe("人物");
        expect(suggestAssetCategory({ title: "海边夜景", prompt: "wide landscape scenery" })).toBe("场景");
        expect(suggestAssetCategory({ fileName: "sword-prop.png", tags: ["武器"] })).toBe("道具");
        expect(suggestAssetCategory({ title: "分镜图 03", note: "storyboard panel" })).toBe("分镜");
        expect(suggestAssetCategory({ title: "提示词草稿", content: "一段脚本台词" })).toBe("其他");
        expect(suggestAssetCategory({ title: "untitled" })).toBeUndefined();
    });

    it("keeps existing category and only suggests when uncategorized", () => {
        expect(isUncategorizedAsset(undefined)).toBe(true);
        expect(isUncategorizedAsset("人物")).toBe(false);
        expect(resolveCategoryOrSuggest("角色", { title: "海边风景" })).toBe("人物");
        expect(resolveCategoryOrSuggest("", { title: "海边风景 landscape" })).toBe("场景");
        expect(resolveCategoryOrSuggest(undefined, { title: "random" })).toBeUndefined();
    });
});
