import type { CloudCredits, CloudUser } from "@/services/cloud-api";

/** Shared helpers for platform billing UI — keep image/video workbenches consistent. */

export function formatYuanFromCents(cents: number | undefined | null) {
    if (!Number.isFinite(Number(cents))) return "¥0.00";
    return `¥${(Number(cents) / 100).toFixed(2)}`;
}

export function isPlatformImageReady(user: CloudUser | null | undefined, credits: CloudCredits | null | undefined) {
    if (!user) return false;
    if (typeof credits?.platform_image_enabled === "boolean") return credits.platform_image_enabled;
    // Backward compatible with older api that only set platform_billing_enabled for image.
    return Boolean(credits?.platform_billing_enabled);
}

export function isPlatformVideoReady(user: CloudUser | null | undefined, credits: CloudCredits | null | undefined) {
    if (!user) return false;
    return Boolean(credits?.platform_video_enabled);
}

export function platformImagePriceCents(credits: CloudCredits | null | undefined) {
    return Math.max(0, Math.trunc(Number(credits?.image_price_cents) || 0));
}

export function platformVideoPriceCents(credits: CloudCredits | null | undefined) {
    return Math.max(0, Math.trunc(Number(credits?.video_price_cents) || 0));
}

export function hasEnoughCredits(balanceCents: number | undefined | null, unitPriceCents: number, count = 1) {
    const price = Math.max(0, Math.trunc(unitPriceCents) || 0) * Math.max(1, Math.trunc(count) || 1);
    if (price <= 0) return true;
    return Math.max(0, Math.trunc(Number(balanceCents) || 0)) >= price;
}

export function platformCapabilitySummary(user: CloudUser | null | undefined, credits: CloudCredits | null | undefined) {
    const parts: string[] = [];
    if (isPlatformImageReady(user, credits)) {
        const price = platformImagePriceCents(credits);
        parts.push(`图片${price > 0 ? `约 ${formatYuanFromCents(price)}/张` : "可代生成"}`);
    }
    if (isPlatformVideoReady(user, credits)) {
        const price = platformVideoPriceCents(credits);
        parts.push(`视频${price > 0 ? `约 ${formatYuanFromCents(price)}/条` : "可代生成"}`);
    }
    return parts;
}
