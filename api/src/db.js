import fs from "node:fs";
import path from "node:path";

import { ensureDir, randomId, sha256 } from "./util.js";
import { CLOUD_ERROR_REASON, CREDIT_CURRENCY, CREDIT_LEDGER_TYPE, FILE_STORAGE_BACKEND, JOB_STATUS, JOB_SOURCE, SAVE_STATUS, USER_STATUS } from "./model/cloud-domain.js";

/**
 * Lightweight JSON-file database.
 * Good enough for single-node MVP; later can swap to Postgres without changing route contracts.
 */
export function createDb(dataDir) {
    ensureDir(dataDir);
    const dbPath = path.join(dataDir, "db.json");
    /** @type {{ users: any[], sessions: any[], jobs: any[], files: any[], credit_ledger: any[] }} */
    let state = { users: [], sessions: [], jobs: [], files: [], credit_ledger: [] };

    if (fs.existsSync(dbPath)) {
        try {
            state = { ...state, ...JSON.parse(fs.readFileSync(dbPath, "utf8")) };
            state.users ||= [];
            state.sessions ||= [];
            state.jobs ||= [];
            state.files ||= [];
            state.credit_ledger ||= [];
        } catch {
            // keep empty state if corrupt; operator can restore from backup
        }
    }

    let writeTimer = null;
    function persist() {
        const tmp = `${dbPath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state));
        fs.renameSync(tmp, dbPath);
    }

    function schedulePersist() {
        // Persist immediately so sessions survive container restarts / process reloads.
        if (writeTimer) clearTimeout(writeTimer);
        writeTimer = setTimeout(() => {
            writeTimer = null;
            try {
                persist();
            } catch (error) {
                console.error("db persist failed", error);
            }
        }, 10);
    }

    function now() {
        return new Date().toISOString();
    }

    return {
        path: dbPath,
        flush: persist,

        findUserByEmail(email) {
            const key = String(email || "").trim().toLowerCase();
            return state.users.find((u) => u.email === key) || null;
        },

        findUserById(id) {
            return state.users.find((u) => u.id === id) || null;
        },

        createUser({ email, passwordHash, displayName }) {
            const user = {
                id: randomId(),
                email: String(email).trim().toLowerCase(),
                password_hash: passwordHash,
                display_name: displayName || "",
                status: USER_STATUS.ACTIVE,
                plan_code: "free",
                // Denormalized credit cache; source of truth is credit_ledger.
                credit_balance_cents: 0,
                failed_login_count: 0,
                locked_until: null,
                created_at: now(),
                updated_at: now(),
            };
            state.users.push(user);
            schedulePersist();
            return user;
        },

        updateUser(user) {
            user.updated_at = now();
            schedulePersist();
            return user;
        },

        createSession({ userId, token, ip, userAgent, ttlSec }) {
            const session = {
                id: randomId(),
                user_id: userId,
                token_hash: sha256(token),
                expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
                revoked_at: null,
                ip: ip || "",
                user_agent: userAgent || "",
                created_at: now(),
            };
            state.sessions.push(session);
            schedulePersist();
            return session;
        },

        findSessionByToken(token) {
            const hash = sha256(token);
            const session = state.sessions.find((s) => s.token_hash === hash && !s.revoked_at);
            if (!session) return null;
            if (new Date(session.expires_at).getTime() <= Date.now()) return null;
            return session;
        },

        revokeSessionByToken(token) {
            const session = this.findSessionByToken(token);
            if (!session) return false;
            session.revoked_at = now();
            schedulePersist();
            return true;
        },

        /**
         * Drop expired / revoked sessions so JSON DB stays small before Postgres migration.
         * Safe to call periodically; does not touch active sessions.
         */
        pruneSessions({ keepRevokedMs = 24 * 3600 * 1000 } = {}) {
            const cutoff = Date.now();
            const before = state.sessions.length;
            state.sessions = state.sessions.filter((s) => {
                if (s.revoked_at) {
                    const revokedAt = new Date(s.revoked_at).getTime();
                    return Number.isFinite(revokedAt) && cutoff - revokedAt < keepRevokedMs;
                }
                const exp = new Date(s.expires_at).getTime();
                return Number.isFinite(exp) && exp > cutoff;
            });
            const removed = before - state.sessions.length;
            if (removed > 0) schedulePersist();
            return removed;
        },

        createFile(record) {
            const file = {
                id: randomId(),
                user_id: record.userId,
                job_id: record.jobId || null,
                kind: record.kind,
                storage_backend: FILE_STORAGE_BACKEND.LOCAL,
                storage_key: record.storageKey,
                mime: record.mime,
                bytes: record.bytes || 0,
                width: record.width || 0,
                height: record.height || 0,
                duration_ms: record.durationMs || 0,
                created_at: now(),
                deleted_at: null,
            };
            state.files.push(file);
            schedulePersist();
            return file;
        },

        findFileForUser(fileId, userId) {
            return state.files.find((f) => f.id === fileId && f.user_id === userId && !f.deleted_at) || null;
        },

        softDeleteFile(fileId, userId) {
            const file = this.findFileForUser(fileId, userId);
            if (!file) return null;
            file.deleted_at = now();
            schedulePersist();
            return file;
        },

        createJob(record) {
            const job = {
                id: randomId(),
                user_id: record.userId,
                type: record.type,
                status: record.status || JOB_STATUS.SUCCESS,
                prompt: record.prompt || "",
                model: record.model || "",
                params_json: record.params || {},
                error_message: record.errorMessage || "",
                result_file_id: record.resultFileId || null,
                cover_file_id: record.coverFileId || null,
                client_local_id: record.clientLocalId || "",
                source: record.source || JOB_SOURCE.CLIENT_UPLOAD,
                provider: record.provider || "",
                upstream_task_id: record.upstreamTaskId || "",
                save_status: record.saveStatus || SAVE_STATUS.STORED,
                created_at: now(),
                finished_at: record.finishedAt || now(),
                expires_at: record.expiresAt || null,
            };
            state.jobs.unshift(job);
            schedulePersist();
            return job;
        },

        listJobsForUser(userId, { type, page = 1, pageSize = 20 } = {}) {
            let rows = state.jobs.filter((j) => j.user_id === userId && j.status !== JOB_STATUS.DELETED);
            if (type) rows = rows.filter((j) => j.type === type);
            const total = rows.length;
            const start = Math.max(0, (page - 1) * pageSize);
            const items = rows.slice(start, start + pageSize);
            return { items, total, page, page_size: pageSize };
        },

        findJobForUser(jobId, userId) {
            return state.jobs.find((j) => j.id === jobId && j.user_id === userId && j.status !== JOB_STATUS.DELETED) || null;
        },

        /** Idempotency for client re-upload / retry: same user + type + client_local_id. */
        findJobByClientLocalId(userId, type, clientLocalId) {
            const key = String(clientLocalId || "").trim();
            if (!key) return null;
            return (
                state.jobs.find(
                    (j) => j.user_id === userId && j.type === type && j.status !== JOB_STATUS.DELETED && String(j.client_local_id || "").trim() === key,
                ) || null
            );
        },

        updateJobResultFile(jobId, userId, resultFileId) {
            const job = this.findJobForUser(jobId, userId);
            if (!job) return null;
            job.result_file_id = resultFileId;
            job.save_status = SAVE_STATUS.STORED;
            job.finished_at = now();
            schedulePersist();
            return job;
        },

        deleteJobForUser(jobId, userId) {
            const job = this.findJobForUser(jobId, userId);
            if (!job) return null;
            job.status = JOB_STATUS.DELETED;
            job.error_message = job.error_message || JOB_STATUS.DELETED;
            if (job.result_file_id) this.softDeleteFile(job.result_file_id, userId);
            if (job.cover_file_id) this.softDeleteFile(job.cover_file_id, userId);
            schedulePersist();
            return job;
        },

        countUserBytes(userId) {
            return state.files.filter((f) => f.user_id === userId && !f.deleted_at).reduce((sum, f) => sum + (f.bytes || 0), 0);
        },

        countUserJobs(userId, type) {
            return state.jobs.filter((j) => j.user_id === userId && j.status !== JOB_STATUS.DELETED && (!type || j.type === type)).length;
        },

        getUserCreditBalanceCents(userId) {
            const user = this.findUserById(userId);
            if (!user) return 0;
            if (typeof user.credit_balance_cents === "number" && Number.isFinite(user.credit_balance_cents)) {
                return Math.trunc(user.credit_balance_cents);
            }
            // Legacy users / missing cache: recompute once from ledger.
            const sum = state.credit_ledger
                .filter((row) => row.user_id === userId)
                .reduce((acc, row) => acc + (Number(row.amount_cents) || 0), 0);
            user.credit_balance_cents = Math.trunc(sum);
            schedulePersist();
            return user.credit_balance_cents;
        },

        findCreditLedgerByIdempotency(userId, key) {
            const idem = String(key || "").trim();
            if (!idem) return null;
            return (
                state.credit_ledger.find(
                    (row) => row.user_id === userId && String(row.idempotency_key || "").trim() === idem,
                ) || null
            );
        },

        listCreditLedgerForUser(userId, { page = 1, pageSize = 20 } = {}) {
            const rows = state.credit_ledger.filter((row) => row.user_id === userId);
            // newest first
            const sorted = [...rows].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
            const total = sorted.length;
            const start = Math.max(0, (page - 1) * pageSize);
            return { items: sorted.slice(start, start + pageSize), total, page, page_size: pageSize };
        },

        /**
         * Append-only credit movement. amountCents may be negative for future charges.
         * Rejects if resulting balance would go below zero (no silent debt).
         */
        appendCreditLedger({
            userId,
            amountCents,
            type = CREDIT_LEDGER_TYPE.GRANT,
            note = "",
            operator = "system",
            idempotencyKey = "",
            refType = "",
            refId = "",
            allowNegativeBalance = false,
        }) {
            const user = this.findUserById(userId);
            if (!user) return null;
            const amount = Math.trunc(Number(amountCents) || 0);
            if (!amount) {
                const err = new Error("amount_cents 不能为 0");
                err.status = 400;
                err.reason = CLOUD_ERROR_REASON.BAD_REQUEST;
                throw err;
            }
            const idem = String(idempotencyKey || "").trim();
            if (idem) {
                const existing = this.findCreditLedgerByIdempotency(userId, idem);
                if (existing) return { entry: existing, user, deduped: true };
            }
            const before = this.getUserCreditBalanceCents(userId);
            const after = before + amount;
            if (!allowNegativeBalance && after < 0) {
                const err = new Error("积分不足");
                err.status = 402;
                err.reason = CLOUD_ERROR_REASON.CREDITS_INSUFFICIENT;
                throw err;
            }
            const entry = {
                id: randomId(),
                user_id: userId,
                amount_cents: amount,
                balance_after_cents: after,
                currency: CREDIT_CURRENCY.CNY_CENTS,
                type: type || CREDIT_LEDGER_TYPE.GRANT,
                note: String(note || "").slice(0, 500),
                operator: String(operator || "system").slice(0, 120),
                idempotency_key: idem,
                ref_type: String(refType || "").slice(0, 64),
                ref_id: String(refId || "").slice(0, 128),
                created_at: now(),
            };
            state.credit_ledger.unshift(entry);
            user.credit_balance_cents = after;
            user.updated_at = now();
            schedulePersist();
            return { entry, user, deduped: false };
        },
    };
}

export function publicUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        plan_code: user.plan_code,
        status: user.status,
        created_at: user.created_at,
        credit_balance_cents: typeof user.credit_balance_cents === "number" ? Math.trunc(user.credit_balance_cents) : 0,
    };
}

export function publicCreditLedgerEntry(entry) {
    if (!entry) return null;
    return {
        id: entry.id,
        amount_cents: entry.amount_cents,
        balance_after_cents: entry.balance_after_cents,
        currency: entry.currency || CREDIT_CURRENCY.CNY_CENTS,
        type: entry.type,
        note: entry.note || "",
        operator: entry.operator || "",
        idempotency_key: entry.idempotency_key || "",
        ref_type: entry.ref_type || "",
        ref_id: entry.ref_id || "",
        created_at: entry.created_at,
    };
}

export function publicJob(job, file, extra = {}) {
    if (!job) return null;
    return {
        id: job.id,
        type: job.type,
        status: job.status,
        prompt: job.prompt,
        model: job.model,
        params: job.params_json || {},
        error_message: job.error_message || "",
        result_file_id: job.result_file_id,
        cover_file_id: job.cover_file_id,
        client_local_id: job.client_local_id || "",
        source: job.source,
        provider: job.provider || "",
        save_status: job.save_status || SAVE_STATUS.STORED,
        created_at: job.created_at,
        finished_at: job.finished_at,
        expires_at: job.expires_at,
        // ephemeral response flags (not necessarily persisted): e.g. deduped for billing later
        ...extra,
        file: file
            ? {
                  id: file.id,
                  kind: file.kind,
                  mime: file.mime,
                  bytes: file.bytes,
                  width: file.width,
                  height: file.height,
                  duration_ms: file.duration_ms,
                  url: `/api/files/${file.id}`,
              }
            : null,
    };
}
