/**
 * Jobs repository façade.
 * Owns user-scoped generation history queries and idempotent re-upload lookups.
 */
export function createJobsRepo(db) {
    return {
        create(input) {
            return db.createJob(input);
        },
        listForUser(userId, input) {
            return db.listJobsForUser(userId, input);
        },
        findForUser(jobId, userId) {
            return db.findJobForUser(jobId, userId);
        },
        findByClientLocalId(userId, type, clientLocalId) {
            return db.findJobByClientLocalId(userId, type, clientLocalId);
        },
        updateResultFile(jobId, userId, resultFileId) {
            return db.updateJobResultFile(jobId, userId, resultFileId);
        },
        deleteForUser(jobId, userId) {
            return db.deleteJobForUser(jobId, userId);
        },
        countForUser(userId, type) {
            return db.countUserJobs(userId, type);
        },
    };
}
