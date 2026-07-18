/**
 * Canvas projects repository façade.
 * Stores project document JSON on disk; metadata in db.json for list/query.
 */
export function createProjectsRepo(db) {
    return {
        listForUser(userId) {
            return db.listProjectsForUser(userId);
        },
        findForUser(projectId, userId) {
            return db.findProjectForUser(projectId, userId);
        },
        readDocument(projectId, userId) {
            return db.readProjectDocument(projectId, userId);
        },
        upsert(userId, project, options) {
            return db.upsertProject(userId, project, options);
        },
        deleteForUser(projectId, userId) {
            return db.deleteProjectForUser(projectId, userId);
        },
    };
}
