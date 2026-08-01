import fs from "node:fs";
import path from "node:path";

import { ensureDir, randomId, sha256 } from "./util.js";
import {
        CLOUD_ERROR_REASON,
        CREDIT_CURRENCY,
        CREDIT_LEDGER_TYPE,
        FILE_STORAGE_BACKEND,
        JOB_STATUS,
        JOB_SOURCE,
        SAVE_STATUS,
        USER_STATUS,
        WORKSPACE_ITEM_RESOLUTION,
        WORKSPACE_ROLE,
        WORKSPACE_STATUS,
        WORKSPACE_TASK_STATUS,
    } from "./model/cloud-domain.js";

/**
 * Lightweight JSON-file database.
 * Good enough for single-node MVP; later can swap to Postgres without changing route contracts.
 */
export function createDb(dataDir) {
    ensureDir(dataDir);
    const dbPath = path.join(dataDir, "db.json");
    const projectsDir = path.join(dataDir, "projects");
    const assetsDir = path.join(dataDir, "assets");
    ensureDir(projectsDir);
    ensureDir(assetsDir);
    /** @type {{ users: any[], sessions: any[], jobs: any[], files: any[], credit_ledger: any[], projects: any[], asset_manifests: any[], workspaces: any[], workspace_members: any[], workspace_items: any[], workspace_tasks: any[] }} */
    let state = {
        users: [],
        sessions: [],
        jobs: [],
        files: [],
        credit_ledger: [],
        projects: [],
        asset_manifests: [],
        workspaces: [],
        workspace_members: [],
        workspace_items: [],
        workspace_tasks: [],
    };

    if (fs.existsSync(dbPath)) {
        try {
            state = { ...state, ...JSON.parse(fs.readFileSync(dbPath, "utf8")) };
            state.users ||= [];
            state.sessions ||= [];
            state.jobs ||= [];
            state.files ||= [];
            state.credit_ledger ||= [];
            state.projects ||= [];
            state.asset_manifests ||= [];
            state.workspaces ||= [];
            state.workspace_members ||= [];
            state.workspace_items ||= [];
            state.workspace_tasks ||= [];
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
                // Optional client-side key (e.g. image:xxx) for canvas media dedup across devices.
                client_key: String(record.clientKey || "").trim(),
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

        findFileByClientKey(userId, clientKey) {
            const key = String(clientKey || "").trim();
            if (!key) return null;
            return state.files.find((f) => f.user_id === userId && !f.deleted_at && String(f.client_key || "").trim() === key) || null;
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

        listProjectsForUser(userId) {
            return state.projects
                .filter((p) => p.user_id === userId && !p.deleted_at)
                .slice()
                .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
        },

        findProjectForUser(projectId, userId) {
            return state.projects.find((p) => p.id === projectId && p.user_id === userId && !p.deleted_at) || null;
        },

        projectDocPath(userId, projectId) {
            return path.join(projectsDir, userId, `${projectId}.json`);
        },

        readProjectDocument(projectId, userId) {
            const meta = this.findProjectForUser(projectId, userId);
            if (!meta) return null;
            const docPath = this.projectDocPath(userId, projectId);
            if (!fs.existsSync(docPath)) return null;
            try {
                return JSON.parse(fs.readFileSync(docPath, "utf8"));
            } catch {
                return null;
            }
        },

        /**
         * Upsert canvas project JSON. Conflict if cloud is newer and client does not force.
         * Document is written under data/projects/{userId}/{projectId}.json
         */
        upsertProject(userId, project, { force = false } = {}) {
            const id = String(project?.id || "").trim();
            if (!id) {
                const err = new Error("缺少项目 id");
                err.status = 400;
                err.reason = CLOUD_ERROR_REASON.BAD_REQUEST;
                throw err;
            }
            const title = String(project?.title || "未命名画布").trim() || "未命名画布";
            const updatedAt = String(project?.updatedAt || project?.updated_at || now());
            const createdAt = String(project?.createdAt || project?.created_at || updatedAt);
            const existing = state.projects.find((p) => p.id === id && p.user_id === userId);

            if (existing && !existing.deleted_at && !force) {
                const cloudTs = Date.parse(existing.updated_at || "") || 0;
                const clientTs = Date.parse(updatedAt) || 0;
                // Cloud is strictly newer → ask client to pull/merge.
                if (cloudTs > clientTs) {
                    const err = new Error("云端版本更新，请先拉取合并");
                    err.status = 409;
                    err.reason = CLOUD_ERROR_REASON.SYNC_CONFLICT;
                    err.cloudProject = existing;
                    throw err;
                }
            }

            const doc = {
                id,
                title,
                createdAt,
                updatedAt,
                nodes: Array.isArray(project?.nodes) ? project.nodes : [],
                connections: Array.isArray(project?.connections) ? project.connections : [],
                chatSessions: Array.isArray(project?.chatSessions) ? project.chatSessions : [],
                activeChatId: project?.activeChatId ?? null,
                backgroundMode: project?.backgroundMode || "lines",
                showImageInfo: Boolean(project?.showImageInfo),
                viewport: project?.viewport || { x: 0, y: 0, k: 1 },
            };

            const userDir = path.join(projectsDir, userId);
            ensureDir(userDir);
            const docPath = this.projectDocPath(userId, id);
            const tmp = `${docPath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(doc));
            fs.renameSync(tmp, docPath);

            const bytes = Buffer.byteLength(JSON.stringify(doc));
            const meta = {
                id,
                user_id: userId,
                title,
                created_at: existing?.created_at || createdAt,
                updated_at: updatedAt,
                bytes,
                deleted_at: null,
            };
            if (existing) {
                Object.assign(existing, meta);
            } else {
                state.projects.push(meta);
            }
            schedulePersist();
            return { meta, document: doc, created: !existing };
        },

        deleteProjectForUser(projectId, userId) {
            const existing = this.findProjectForUser(projectId, userId);
            if (!existing) return null;
            existing.deleted_at = now();
            existing.updated_at = existing.deleted_at;
            schedulePersist();
            try {
                const docPath = this.projectDocPath(userId, projectId);
                if (fs.existsSync(docPath)) fs.unlinkSync(docPath);
            } catch {
                // best-effort file delete
            }
            return existing;
        },

        assetManifestPath(userId) {
            return path.join(assetsDir, userId, "manifest.json");
        },

        readAssetManifest(userId) {
            const meta = state.asset_manifests.find((item) => item.user_id === userId) || null;
            const docPath = this.assetManifestPath(userId);
            if (!meta || !fs.existsSync(docPath)) {
                return {
                    meta: null,
                    manifest: { version: 1, updatedAt: "", assets: [], tombstones: [] },
                };
            }
            try {
                const manifest = JSON.parse(fs.readFileSync(docPath, "utf8"));
                return { meta, manifest };
            } catch {
                return {
                    meta,
                    manifest: { version: 1, updatedAt: meta.updated_at || "", assets: [], tombstones: [] },
                };
            }
        },

        /**
         * Upsert one user-level asset manifest. A strictly newer cloud revision conflicts unless forced.
         * Tombstones prevent deleted assets from being resurrected on another device.
         */
        upsertAssetManifest(userId, input, { force = false } = {}) {
            const updatedAt = String(input?.updatedAt || input?.updated_at || now());
            if (!Number.isFinite(Date.parse(updatedAt))) {
                const err = new Error("updatedAt 无效");
                err.status = 400;
                err.reason = CLOUD_ERROR_REASON.BAD_REQUEST;
                throw err;
            }
            const existing = state.asset_manifests.find((item) => item.user_id === userId) || null;
            if (existing && !force) {
                const cloudTs = Date.parse(existing.updated_at || "") || 0;
                const clientTs = Date.parse(updatedAt) || 0;
                if (cloudTs > clientTs) {
                    const err = new Error("云端素材清单更新，请先合并");
                    err.status = 409;
                    err.reason = CLOUD_ERROR_REASON.SYNC_CONFLICT;
                    err.cloudAssetManifest = this.readAssetManifest(userId).manifest;
                    throw err;
                }
            }

            const assets = Array.isArray(input?.assets) ? input.assets : [];
            const tombstones = Array.isArray(input?.tombstones) ? input.tombstones : [];
            const manifest = { version: 1, updatedAt, assets, tombstones };
            const raw = JSON.stringify(manifest);
            const userDir = path.join(assetsDir, userId);
            ensureDir(userDir);
            const docPath = this.assetManifestPath(userId);
            const tmp = `${docPath}.tmp`;
            fs.writeFileSync(tmp, raw);
            fs.renameSync(tmp, docPath);

            const meta = {
                user_id: userId,
                updated_at: updatedAt,
                bytes: Buffer.byteLength(raw),
                asset_count: assets.length,
                tombstone_count: tombstones.length,
            };
            if (existing) Object.assign(existing, meta);
            else state.asset_manifests.push(meta);
            schedulePersist();
            return { meta, manifest, created: !existing };
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

        // ── Collaborative workspaces (explicit share; not private assets/jobs) ──

        createWorkspace({ name, ownerId, inviteCode }) {
            const id = randomId();
            const ts = now();
            const workspace = {
                id,
                name: String(name || "未命名空间").trim().slice(0, 80) || "未命名空间",
                owner_id: ownerId,
                invite_code: String(inviteCode || "").trim(),
                status: WORKSPACE_STATUS.ACTIVE,
                created_at: ts,
                updated_at: ts,
            };
            state.workspaces.unshift(workspace);
            state.workspace_members.push({
                id: randomId(),
                workspace_id: id,
                user_id: ownerId,
                role: WORKSPACE_ROLE.OWNER,
                joined_at: ts,
            });
            schedulePersist();
            return workspace;
        },

        findWorkspaceById(workspaceId) {
            return state.workspaces.find((w) => w.id === workspaceId && w.status !== WORKSPACE_STATUS.ARCHIVED) || null;
        },

        findWorkspaceByInviteCode(inviteCode) {
            const code = String(inviteCode || "").trim().toLowerCase();
            if (!code) return null;
            return state.workspaces.find((w) => w.status === WORKSPACE_STATUS.ACTIVE && String(w.invite_code || "").toLowerCase() === code) || null;
        },

        listWorkspacesForUser(userId) {
            const memberships = state.workspace_members.filter((m) => m.user_id === userId);
            return memberships
                .map((m) => {
                    const ws = state.workspaces.find((w) => w.id === m.workspace_id && w.status !== WORKSPACE_STATUS.ARCHIVED);
                    if (!ws) return null;
                    return { workspace: ws, membership: m };
                })
                .filter(Boolean)
                .sort((a, b) => String(b.workspace.updated_at || "").localeCompare(String(a.workspace.updated_at || "")));
        },

        findMembership(workspaceId, userId) {
            return state.workspace_members.find((m) => m.workspace_id === workspaceId && m.user_id === userId) || null;
        },

        listMembers(workspaceId) {
            return state.workspace_members
                .filter((m) => m.workspace_id === workspaceId)
                .map((m) => {
                    const user = this.findUserById(m.user_id);
                    return {
                        id: m.id,
                        workspace_id: m.workspace_id,
                        user_id: m.user_id,
                        role: m.role,
                        joined_at: m.joined_at,
                        display_name: user?.display_name || "",
                        email: user?.email || "",
                    };
                });
        },

        addWorkspaceMember({ workspaceId, userId, role = WORKSPACE_ROLE.MEMBER }) {
            const existing = this.findMembership(workspaceId, userId);
            if (existing) return existing;
            const member = {
                id: randomId(),
                workspace_id: workspaceId,
                user_id: userId,
                role: role || WORKSPACE_ROLE.MEMBER,
                joined_at: now(),
            };
            state.workspace_members.push(member);
            const ws = this.findWorkspaceById(workspaceId);
            if (ws) ws.updated_at = now();
            schedulePersist();
            return member;
        },

        /**
         * Owner kick: remove membership row only. Does not delete shared items.
         * Optionally scrub kicked user from task assignees in the same workspace.
         */
        removeWorkspaceMember(workspaceId, userId) {
            const idx = state.workspace_members.findIndex(
                (m) => m.workspace_id === workspaceId && m.user_id === userId,
            );
            if (idx < 0) return null;
            const [removed] = state.workspace_members.splice(idx, 1);
            // Best-effort: drop kicked user from multi-assignee task lists.
            for (const task of state.workspace_tasks) {
                if (task.workspace_id !== workspaceId || task.deleted_at) continue;
                const ids = normalizeAssigneeUserIds(
                    Array.isArray(task.assignee_user_ids) && task.assignee_user_ids.length
                        ? task.assignee_user_ids
                        : task.assignee_user_id,
                );
                if (!ids.includes(userId)) continue;
                const next = ids.filter((id) => id !== userId);
                task.assignee_user_ids = next;
                task.assignee_user_id = next[0] || null;
                task.updated_at = now();
            }
            const ws = this.findWorkspaceById(workspaceId);
            if (ws) ws.updated_at = now();
            schedulePersist();
            return removed;
        },

        resetWorkspaceInviteCode(workspaceId, ownerId, inviteCode) {
            const ws = this.findWorkspaceById(workspaceId);
            if (!ws || ws.owner_id !== ownerId) return null;
            ws.invite_code = String(inviteCode || "").trim();
            ws.updated_at = now();
            schedulePersist();
            return ws;
        },

        archiveWorkspace(workspaceId, ownerId) {
            const ws = state.workspaces.find((w) => w.id === workspaceId && w.status !== WORKSPACE_STATUS.ARCHIVED);
            if (!ws || ws.owner_id !== ownerId) return null;
            ws.status = WORKSPACE_STATUS.ARCHIVED;
            ws.updated_at = now();
            schedulePersist();
            return ws;
        },

        createWorkspaceItem(record) {
            const item = {
                id: randomId(),
                workspace_id: record.workspaceId,
                kind: record.kind,
                title: String(record.title || "").slice(0, 200),
                note: String(record.note || "").slice(0, 1000),
                category: String(record.category || "").slice(0, 80),
                tags: Array.isArray(record.tags) ? record.tags.map((t) => String(t).slice(0, 40)).slice(0, 20) : [],
                prompt: String(record.prompt || "").slice(0, 4000),
                model: String(record.model || "").slice(0, 120),
                file_id: record.fileId || null,
                text_content: record.textContent != null ? String(record.textContent).slice(0, 20000) : "",
                width: Number(record.width || 0) || 0,
                height: Number(record.height || 0) || 0,
                bytes: Number(record.bytes || 0) || 0,
                mime: String(record.mime || "").slice(0, 120),
                source_type: String(record.sourceType || "").slice(0, 40),
                source_ref: String(record.sourceRef || "").slice(0, 200),
                // Optional revision metadata (material wall hygiene; no blob versions).
                version: String(record.version || "").slice(0, 40),
                replaces_item_id: String(record.replacesItemId || record.replaces_item_id || "").slice(0, 80),
                is_final: Boolean(record.isFinal ?? record.is_final),
                // Review reactions (用/弃/改); per-user one vote, array on item.
                reactions: [],
                created_by: record.createdBy,
                created_at: now(),
                updated_at: now(),
                deleted_at: null,
            };
            state.workspace_items.unshift(item);
            const ws = this.findWorkspaceById(record.workspaceId);
            if (ws) ws.updated_at = now();
            schedulePersist();
            return item;
        },

        listWorkspaceItems(workspaceId, { kind, category, page = 1, pageSize = 50 } = {}) {
            let rows = state.workspace_items.filter((i) => i.workspace_id === workspaceId && !i.deleted_at);
            if (kind) {
                const kinds = String(kind)
                    .split(",")
                    .map((k) => k.trim())
                    .filter(Boolean);
                if (kinds.length) rows = rows.filter((i) => kinds.includes(i.kind));
            }
            if (category) {
                const categories = String(category)
                    .split(",")
                    .map((c) => c.trim())
                    .filter(Boolean);
                if (categories.length) {
                    rows = rows.filter((i) => {
                        const value = String(i.category || "").trim();
                        // "__uncategorized__" matches empty category (client taxonomy sentinel).
                        return categories.some((c) => (c === "__uncategorized__" ? !value : value === c));
                    });
                }
            }
            const total = rows.length;
            const start = Math.max(0, (page - 1) * pageSize);
            return { items: rows.slice(start, start + pageSize), total, page, page_size: pageSize };
        },

        findWorkspaceItem(itemId, workspaceId) {
            return state.workspace_items.find((i) => i.id === itemId && i.workspace_id === workspaceId && !i.deleted_at) || null;
        },

        /**
         * Metadata-only patch for workspace items (no media re-upload).
         * Supports category/tags/title/note + version / replaces / is_final.
         */
        updateWorkspaceItem(itemId, workspaceId, patch = {}) {
            const item = this.findWorkspaceItem(itemId, workspaceId);
            if (!item) return null;
            if (patch.title !== undefined) item.title = String(patch.title || "").slice(0, 200);
            if (patch.note !== undefined) item.note = String(patch.note || "").slice(0, 1000);
            if (patch.category !== undefined) item.category = String(patch.category || "").slice(0, 80);
            if (patch.tags !== undefined) {
                item.tags = Array.isArray(patch.tags)
                    ? patch.tags.map((t) => String(t).slice(0, 40)).slice(0, 20)
                    : [];
            }
            if (patch.version !== undefined) item.version = String(patch.version || "").slice(0, 40);
            if (patch.replacesItemId !== undefined || patch.replaces_item_id !== undefined) {
                item.replaces_item_id = String(patch.replacesItemId ?? patch.replaces_item_id ?? "").slice(0, 80);
            }
            if (patch.isFinal !== undefined || patch.is_final !== undefined) {
                item.is_final = Boolean(patch.isFinal ?? patch.is_final);
            }
            // Ensure older rows still have the optional keys when first patched.
            if (item.version == null) item.version = "";
            if (item.replaces_item_id == null) item.replaces_item_id = "";
            if (item.is_final == null) item.is_final = false;
            if (!Array.isArray(item.reactions)) item.reactions = [];
            item.updated_at = now();
            const ws = this.findWorkspaceById(workspaceId);
            if (ws) ws.updated_at = now();
            schedulePersist();
            return item;
        },

        /**
         * Upsert caller's own reaction (use/discard/revise + optional comment).
         * One vote per user_id; does not require item ownership.
         */
        upsertWorkspaceItemReaction(itemId, workspaceId, { userId, resolution, comment = "" } = {}) {
            const item = this.findWorkspaceItem(itemId, workspaceId);
            if (!item) return null;
            const uid = String(userId || "").trim();
            if (!uid) return null;
            const res = String(resolution || "").trim();
            if (!Object.values(WORKSPACE_ITEM_RESOLUTION).includes(res)) return null;
            if (!Array.isArray(item.reactions)) item.reactions = [];
            const entry = {
                user_id: uid,
                resolution: res,
                comment: String(comment || "").slice(0, 200),
                updated_at: now(),
            };
            const idx = item.reactions.findIndex((r) => r && r.user_id === uid);
            if (idx >= 0) item.reactions[idx] = entry;
            else item.reactions.push(entry);
            // Cap by member count soft upper bound.
            if (item.reactions.length > 50) item.reactions = item.reactions.slice(-50);
            item.updated_at = now();
            const ws = this.findWorkspaceById(workspaceId);
            if (ws) ws.updated_at = now();
            schedulePersist();
            return item;
        },

        /** Clear caller's own reaction (or owner force-clear by userId). */
        clearWorkspaceItemReaction(itemId, workspaceId, userId) {
            const item = this.findWorkspaceItem(itemId, workspaceId);
            if (!item) return null;
            const uid = String(userId || "").trim();
            if (!uid) return null;
            if (!Array.isArray(item.reactions)) item.reactions = [];
            item.reactions = item.reactions.filter((r) => r && r.user_id !== uid);
            item.updated_at = now();
            const ws = this.findWorkspaceById(workspaceId);
            if (ws) ws.updated_at = now();
            schedulePersist();
            return item;
        },

        softDeleteWorkspaceItem(itemId, workspaceId) {
            const item = this.findWorkspaceItem(itemId, workspaceId);
            if (!item) return null;
            item.deleted_at = now();
            item.updated_at = now();
            const ws = this.findWorkspaceById(workspaceId);
            if (ws) ws.updated_at = now();
            schedulePersist();
            return item;
        },

        findFileById(fileId) {
            return state.files.find((f) => f.id === fileId && !f.deleted_at) || null;
        },

        /** File is readable by workspace members when linked from a workspace item or task deliverable. */
        findWorkspaceFileAccess(fileId, userId) {
            const file = this.findFileById(fileId);
            if (!file) return null;
            const item = state.workspace_items.find((i) => i.file_id === fileId && !i.deleted_at);
            if (item) {
                const ws = this.findWorkspaceById(item.workspace_id);
                if (!ws) return null;
                const membership = this.findMembership(ws.id, userId);
                if (!membership) return null;
                return { file, item, workspace: ws, membership };
            }
            const task = state.workspace_tasks.find((t) => {
                if (t.deleted_at) return false;
                if (t.deliverable_file_id === fileId) return true;
                return normalizeTaskDeliverables(t).some((d) => d.file_id === fileId);
            });
            if (!task) return null;
            const ws = this.findWorkspaceById(task.workspace_id);
            if (!ws) return null;
            const membership = this.findMembership(ws.id, userId);
            if (!membership) return null;
            return { file, task, workspace: ws, membership };
        },

        createWorkspaceTask(record) {
            const assigneeIds = normalizeAssigneeUserIds(record.assigneeUserIds ?? record.assigneeUserId);
            const deliverables = normalizeTaskDeliverables({
                deliverables: record.deliverables,
                deliverable_file_id: record.deliverableFileId || null,
                deliverable_name: record.deliverableName || "",
                deliverable_mime: record.deliverableMime || "",
                deliverable_bytes: record.deliverableBytes || 0,
            });
            const first = deliverables[0] || null;
            const task = {
                id: randomId(),
                workspace_id: record.workspaceId,
                title: String(record.title || "").trim().slice(0, 200) || "未命名任务",
                body: String(record.body || "").slice(0, 4000),
                status: record.status || WORKSPACE_TASK_STATUS.TODO,
                // Multi-assignee; keep legacy single field as first id for older clients.
                assignee_user_ids: assigneeIds,
                assignee_user_id: assigneeIds[0] || null,
                // Multi deliverables; keep legacy single fields as first item for older clients.
                deliverables,
                deliverable_file_id: first?.file_id || null,
                deliverable_name: first?.name || "",
                deliverable_mime: first?.mime || "",
                deliverable_bytes: first?.bytes || 0,
                created_by: record.createdBy,
                sort_order: Number(record.sortOrder || Date.now()) || Date.now(),
                created_at: now(),
                updated_at: now(),
                deleted_at: null,
            };
            state.workspace_tasks.unshift(task);
            const ws = this.findWorkspaceById(record.workspaceId);
            if (ws) ws.updated_at = now();
            schedulePersist();
            return task;
        },

        listWorkspaceTasks(workspaceId) {
            return state.workspace_tasks
                .filter((t) => t.workspace_id === workspaceId && !t.deleted_at)
                .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
        },

        findWorkspaceTask(taskId, workspaceId) {
            return state.workspace_tasks.find((t) => t.id === taskId && t.workspace_id === workspaceId && !t.deleted_at) || null;
        },

        updateWorkspaceTask(taskId, workspaceId, patch) {
            const task = this.findWorkspaceTask(taskId, workspaceId);
            if (!task) return null;
            if (patch.title != null) task.title = String(patch.title).trim().slice(0, 200) || task.title;
            if (patch.body != null) task.body = String(patch.body).slice(0, 4000);
            if (patch.status != null) task.status = String(patch.status);
            if (patch.assigneeUserIds !== undefined || patch.assigneeUserId !== undefined) {
                const assigneeIds = normalizeAssigneeUserIds(
                    patch.assigneeUserIds !== undefined ? patch.assigneeUserIds : patch.assigneeUserId,
                );
                task.assignee_user_ids = assigneeIds;
                task.assignee_user_id = assigneeIds[0] || null;
            }
            // Multi deliverables (preferred). Always re-sync legacy single fields from first item.
            if (Array.isArray(patch.deliverables)) {
                applyTaskDeliverables(task, patch.deliverables);
            } else if (patch.appendDeliverable && patch.appendDeliverable.file_id) {
                const current = normalizeTaskDeliverables(task);
                if (current.length >= MAX_TASK_DELIVERABLES) {
                    return { __error: "deliverable_limit", limit: MAX_TASK_DELIVERABLES };
                }
                const next = [...current, normalizeOneDeliverable(patch.appendDeliverable)].filter(Boolean);
                applyTaskDeliverables(task, next);
            } else if (patch.removeDeliverableFileId) {
                const removeId = String(patch.removeDeliverableFileId || "").trim();
                const next = normalizeTaskDeliverables(task).filter((d) => d.file_id !== removeId);
                applyTaskDeliverables(task, next);
            } else if (patch.clearDeliverable) {
                applyTaskDeliverables(task, []);
            } else if (patch.deliverableFileId !== undefined) {
                // Legacy single-file replace / clear.
                if (!patch.deliverableFileId) {
                    applyTaskDeliverables(task, []);
                } else {
                    applyTaskDeliverables(task, [
                        {
                            file_id: patch.deliverableFileId,
                            name: patch.deliverableName || "",
                            mime: patch.deliverableMime || "",
                            bytes: patch.deliverableBytes || 0,
                        },
                    ]);
                }
            }
            if (patch.sortOrder != null) task.sort_order = Number(patch.sortOrder) || task.sort_order;
            task.updated_at = now();
            const ws = this.findWorkspaceById(workspaceId);
            if (ws) ws.updated_at = now();
            schedulePersist();
            return task;
        },

        softDeleteWorkspaceTask(taskId, workspaceId) {
            const task = this.findWorkspaceTask(taskId, workspaceId);
            if (!task) return null;
            task.deleted_at = now();
            task.updated_at = now();
            const ws = this.findWorkspaceById(workspaceId);
            if (ws) ws.updated_at = now();
            schedulePersist();
            return task;
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

export function publicProjectMeta(meta) {
    if (!meta) return null;
    return {
        id: meta.id,
        title: meta.title,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        bytes: meta.bytes || 0,
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

export function publicWorkspace(workspace, membership = null, extra = {}) {
    if (!workspace) return null;
    return {
        id: workspace.id,
        name: workspace.name,
        owner_id: workspace.owner_id,
        // Invite code only returned to members (caller decides); owner sees it for sharing.
        invite_code: extra.includeInvite ? workspace.invite_code || "" : undefined,
        status: workspace.status,
        created_at: workspace.created_at,
        updated_at: workspace.updated_at,
        role: membership?.role || null,
        member_count: extra.memberCount,
        ...extra.publicFields,
    };
}

export function publicWorkspaceItem(item, extra = {}) {
    if (!item) return null;
    return {
        id: item.id,
        workspace_id: item.workspace_id,
        kind: item.kind,
        title: item.title,
        note: item.note || "",
        category: item.category || "",
        tags: Array.isArray(item.tags) ? item.tags : [],
        prompt: item.prompt || "",
        model: item.model || "",
        file_id: item.file_id || null,
        text_content: item.text_content || "",
        width: item.width || 0,
        height: item.height || 0,
        bytes: item.bytes || 0,
        mime: item.mime || "",
        source_type: item.source_type || "",
        source_ref: item.source_ref || "",
        version: item.version || "",
        replaces_item_id: item.replaces_item_id || "",
        is_final: Boolean(item.is_final),
        reactions: normalizeWorkspaceItemReactions(item.reactions),
        created_by: item.created_by,
        created_by_name: extra.created_by_name || "",
        created_by_email: extra.created_by_email || "",
        created_at: item.created_at,
        updated_at: item.updated_at,
        file_url: item.file_id ? `/api/workspace-files/${item.file_id}` : null,
        ...extra,
    };
}

/** Normalize reaction rows for public API (max 50, strip junk). */
export function normalizeWorkspaceItemReactions(input) {
    if (!Array.isArray(input)) return [];
    const allowed = new Set(Object.values(WORKSPACE_ITEM_RESOLUTION));
    const out = [];
    const seen = new Set();
    for (const raw of input) {
        if (!raw || typeof raw !== "object") continue;
        const userId = String(raw.user_id || raw.userId || "").trim();
        if (!userId || seen.has(userId)) continue;
        const resolution = String(raw.resolution || "").trim();
        if (!allowed.has(resolution)) continue;
        seen.add(userId);
        out.push({
            user_id: userId,
            resolution,
            comment: String(raw.comment || "").slice(0, 200),
            updated_at: raw.updated_at || raw.updatedAt || "",
            display_name: raw.display_name || raw.displayName || undefined,
            email: raw.email || undefined,
        });
        if (out.length >= 50) break;
    }
    return out;
}

/** Normalize single id / id[] into unique non-empty string ids (max 20). */
export function normalizeAssigneeUserIds(input) {
    const raw = Array.isArray(input) ? input : input ? [input] : [];
    const seen = new Set();
    const out = [];
    for (const value of raw) {
        const id = String(value || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        if (out.length >= 20) break;
    }
    return out;
}

/** Max image/video deliverables attached to one task. */
export const MAX_TASK_DELIVERABLES = 12;

function normalizeOneDeliverable(input) {
    if (!input || typeof input !== "object") return null;
    const fileId = String(input.file_id || input.fileId || "").trim();
    if (!fileId) return null;
    return {
        file_id: fileId,
        name: String(input.name || input.deliverable_name || "").slice(0, 200),
        mime: String(input.mime || input.deliverable_mime || "").slice(0, 120),
        bytes: Number(input.bytes || input.deliverable_bytes || 0) || 0,
        uploaded_by: String(input.uploaded_by || input.uploadedBy || "").slice(0, 80) || undefined,
        created_at: input.created_at || input.createdAt || undefined,
    };
}

/** Merge multi-deliverable array with legacy single fields; de-dupe by file_id. */
export function normalizeTaskDeliverables(task) {
    const seen = new Set();
    const out = [];
    const push = (raw) => {
        const item = normalizeOneDeliverable(raw);
        if (!item || seen.has(item.file_id)) return;
        seen.add(item.file_id);
        out.push(item);
    };
    if (Array.isArray(task?.deliverables)) {
        for (const d of task.deliverables) {
            push(d);
            if (out.length >= MAX_TASK_DELIVERABLES) break;
        }
    }
    if (out.length < MAX_TASK_DELIVERABLES && task?.deliverable_file_id) {
        push({
            file_id: task.deliverable_file_id,
            name: task.deliverable_name || "",
            mime: task.deliverable_mime || "",
            bytes: task.deliverable_bytes || 0,
        });
    }
    return out;
}

function applyTaskDeliverables(task, list) {
    const deliverables = normalizeTaskDeliverables({ deliverables: list });
    const first = deliverables[0] || null;
    task.deliverables = deliverables;
    task.deliverable_file_id = first?.file_id || null;
    task.deliverable_name = first?.name || "";
    task.deliverable_mime = first?.mime || "";
    task.deliverable_bytes = first?.bytes || 0;
    return deliverables;
}

export function publicWorkspaceTask(task, extra = {}) {
    if (!task) return null;
    const assigneeIds = normalizeAssigneeUserIds(
        Array.isArray(task.assignee_user_ids) && task.assignee_user_ids.length
            ? task.assignee_user_ids
            : task.assignee_user_id,
    );
    const deliverables = normalizeTaskDeliverables(task).map((d) => ({
        file_id: d.file_id,
        name: d.name || "",
        mime: d.mime || "",
        bytes: d.bytes || 0,
        url: `/api/workspace-files/${d.file_id}`,
        uploaded_by: d.uploaded_by || "",
        created_at: d.created_at || "",
    }));
    const first = deliverables[0] || null;
    return {
        id: task.id,
        workspace_id: task.workspace_id,
        title: task.title,
        body: task.body || "",
        status: task.status,
        assignee_user_ids: assigneeIds,
        // Legacy single field: first assignee (or null).
        assignee_user_id: assigneeIds[0] || null,
        assignees: Array.isArray(extra.assignees) ? extra.assignees : undefined,
        // Multi deliverables (preferred).
        deliverables,
        // Legacy single fields: first deliverable for older clients / UI fallbacks.
        deliverable_file_id: first?.file_id || null,
        deliverable_name: first?.name || "",
        deliverable_mime: first?.mime || "",
        deliverable_bytes: first?.bytes || 0,
        deliverable_url: first?.url || null,
        created_by: task.created_by,
        created_by_name: extra.created_by_name || "",
        created_by_email: extra.created_by_email || "",
        sort_order: task.sort_order,
        created_at: task.created_at,
        updated_at: task.updated_at,
    };
}
