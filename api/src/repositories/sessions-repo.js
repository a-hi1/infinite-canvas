/**
 * Sessions repository façade.
 * Keeps auth/session lifecycle independent from the concrete JSON storage shape.
 */
export function createSessionsRepo(db) {
    return {
        create(input) {
            return db.createSession(input);
        },
        findByToken(token) {
            return db.findSessionByToken(token);
        },
        revokeByToken(token) {
            return db.revokeSessionByToken(token);
        },
        pruneExpired(options) {
            return db.pruneSessions(options);
        },
    };
}
