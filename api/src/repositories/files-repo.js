/**
 * Files repository façade.
 * Keeps media metadata / byte accounting separate from route handlers.
 */
export function createFilesRepo(db) {
    return {
        create(input) {
            return db.createFile(input);
        },
        findForUser(fileId, userId) {
            return db.findFileForUser(fileId, userId);
        },
        softDeleteForUser(fileId, userId) {
            return db.softDeleteFile(fileId, userId);
        },
        countUserBytes(userId) {
            return db.countUserBytes(userId);
        },
    };
}
