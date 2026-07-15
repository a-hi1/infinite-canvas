import fs from "node:fs";
import path from "node:path";

import { ensureDir, randomId, sha256 } from "./util.js";

/**
 * Lightweight JSON-file database.
 * Good enough for single-node MVP; later can swap to Postgres without changing route contracts.
 */
export function createDb(dataDir) {
    ensureDir(dataDir);
    const dbPath = path.join(dataDir, "db.json");
    /** @type {{ users: any[], sessions: any[], jobs: any[], files: any[] }} */
    let state = { users: [], sessions: [], jobs: [], files: [] };

    if (fs.existsSync(dbPath)) {
        try {
            state = { ...state, ...JSON.parse(fs.readFileSync(dbPath, "utf8")) };
            state.users ||= [];
            state.sessions ||= [];
            state.jobs ||= [];
            state.files ||= [];
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
                status: "active",
                plan_code: "free",
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

        createFile(record) {
            const file = {
                id: randomId(),
                user_id: record.userId,
                job_id: record.jobId || null,
                kind: record.kind,
                storage_backend: "local",
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
                status: record.status || "success",
                prompt: record.prompt || "",
                model: record.model || "",
                params_json: record.params || {},
                error_message: record.errorMessage || "",
                result_file_id: record.resultFileId || null,
                cover_file_id: record.coverFileId || null,
                client_local_id: record.clientLocalId || "",
                source: record.source || "client_upload",
                provider: record.provider || "",
                upstream_task_id: record.upstreamTaskId || "",
                save_status: record.saveStatus || "stored",
                created_at: now(),
                finished_at: record.finishedAt || now(),
                expires_at: record.expiresAt || null,
            };
            state.jobs.unshift(job);
            schedulePersist();
            return job;
        },

        listJobsForUser(userId, { type, page = 1, pageSize = 20 } = {}) {
            let rows = state.jobs.filter((j) => j.user_id === userId && j.status !== "deleted");
            if (type) rows = rows.filter((j) => j.type === type);
            const total = rows.length;
            const start = Math.max(0, (page - 1) * pageSize);
            const items = rows.slice(start, start + pageSize);
            return { items, total, page, page_size: pageSize };
        },

        findJobForUser(jobId, userId) {
            return state.jobs.find((j) => j.id === jobId && j.user_id === userId && j.status !== "deleted") || null;
        },

        /** Idempotency for client re-upload / retry: same user + type + client_local_id. */
        findJobByClientLocalId(userId, type, clientLocalId) {
            const key = String(clientLocalId || "").trim();
            if (!key) return null;
            return (
                state.jobs.find(
                    (j) => j.user_id === userId && j.type === type && j.status !== "deleted" && String(j.client_local_id || "").trim() === key,
                ) || null
            );
        },

        updateJobResultFile(jobId, userId, resultFileId) {
            const job = this.findJobForUser(jobId, userId);
            if (!job) return null;
            job.result_file_id = resultFileId;
            job.save_status = "stored";
            job.finished_at = now();
            schedulePersist();
            return job;
        },

        deleteJobForUser(jobId, userId) {
            const job = this.findJobForUser(jobId, userId);
            if (!job) return null;
            job.status = "deleted";
            job.error_message = job.error_message || "deleted";
            if (job.result_file_id) this.softDeleteFile(job.result_file_id, userId);
            if (job.cover_file_id) this.softDeleteFile(job.cover_file_id, userId);
            schedulePersist();
            return job;
        },

        countUserBytes(userId) {
            return state.files.filter((f) => f.user_id === userId && !f.deleted_at).reduce((sum, f) => sum + (f.bytes || 0), 0);
        },

        countUserJobs(userId, type) {
            return state.jobs.filter((j) => j.user_id === userId && j.status !== "deleted" && (!type || j.type === type)).length;
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
        save_status: job.save_status || "stored",
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
