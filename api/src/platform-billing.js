/**
 * Shared helpers for platform generate paths (image / video).
 * Goal: one place for idempotent job lookup + success-only credit charge + rollback.
 */

import fs from "node:fs";

import { CLOUD_ERROR_REASON, CREDIT_LEDGER_TYPE, JOB_SOURCE, JOB_STATUS, SAVE_STATUS } from "./model/cloud-domain.js";

/**
 * Return existing successful server_generate job+file when client_local_id matches.
 */
export function findExistingPlatformJob({ jobsRepo, filesRepo, safeJoin, uploadsDir, userId, type, clientLocalId }) {
    const key = String(clientLocalId || "").trim();
    if (!key) return null;
    const existing = jobsRepo.findByClientLocalId(userId, type, key);
    if (!existing || existing.source !== JOB_SOURCE.SERVER_GENERATE || existing.status !== JOB_STATUS.SUCCESS) return null;
    const existingFile = existing.result_file_id ? filesRepo.findForUser(existing.result_file_id, userId) : null;
    if (!existingFile) return null;
    try {
        const absExisting = safeJoin(uploadsDir, ...String(existingFile.storage_key).split("/"));
        if (!fs.existsSync(absExisting)) return null;
    } catch {
        return null;
    }
    return { job: existing, file: existingFile };
}

/**
 * Persist file+job, then charge credits (idempotent). On charge failure, best-effort delete job/file.
 */
export function persistPlatformResultAndCharge({
    db,
    jobsRepo,
    filesRepo,
    creditsRepo,
    writeUserFile,
    safeJoin,
    uploadsDir,
    userId,
    type,
    prompt,
    model,
    params,
    clientLocalId,
    sniffed,
    bytes,
    width = 0,
    height = 0,
    durationMs = 0,
    filename,
    priceCents,
    chargeNote,
}) {
    const fileRow = writeUserFile({
        userId,
        type,
        sniffed,
        bytes,
        width,
        height,
        durationMs,
        filename,
    });

    const job = jobsRepo.create({
        userId,
        type,
        status: JOB_STATUS.SUCCESS,
        prompt,
        model,
        params,
        resultFileId: fileRow.id,
        clientLocalId,
        source: JOB_SOURCE.SERVER_GENERATE,
        provider: "platform",
        saveStatus: SAVE_STATUS.STORED,
    });
    fileRow.job_id = job.id;

    let chargedCents = 0;
    const price = Math.max(0, Math.trunc(Number(priceCents) || 0));
    if (price > 0) {
        const chargeKey = clientLocalId ? `charge:${type}:${clientLocalId}` : `charge:${type}:${job.id}`;
        try {
            const chargeResult = creditsRepo.append({
                userId,
                amountCents: -price,
                type: CREDIT_LEDGER_TYPE.CHARGE,
                note: chargeNote || `平台生成 ${model}`,
                operator: "system",
                idempotencyKey: chargeKey,
                refType: `platform_generate_${type}`,
                refId: job.id,
            });
            chargedCents = chargeResult.deduped ? 0 : price;
        } catch (error) {
            try {
                jobsRepo.deleteForUser(job.id, userId);
                const abs = safeJoin(uploadsDir, ...String(fileRow.storage_key).split("/"));
                if (fs.existsSync(abs)) fs.unlinkSync(abs);
            } catch {
                // best-effort rollback
            }
            db.flush();
            if (error?.reason === CLOUD_ERROR_REASON.CREDITS_INSUFFICIENT) {
                const err = new Error(error.message || "积分不足");
                err.status = 402;
                err.reason = CLOUD_ERROR_REASON.CREDITS_INSUFFICIENT;
                throw err;
            }
            throw error;
        }
    }
    db.flush();
    return { job, file: fileRow, chargedCents };
}
