/**
 * Users repository façade.
 * Current implementation delegates to the JSON DB; future storage swaps should happen here.
 */
export function createUsersRepo(db) {
    return {
        findByEmail(email) {
            return db.findUserByEmail(email);
        },
        /** All rows with the same normalized email (for login password match / diagnostics). */
        findAllByEmail(email) {
            if (typeof db.findUsersByEmail === "function") return db.findUsersByEmail(email);
            const one = db.findUserByEmail(email);
            return one ? [one] : [];
        },
        findById(id) {
            return db.findUserById(id);
        },
        create(input) {
            return db.createUser(input);
        },
        update(user) {
            return db.updateUser(user);
        },
    };
}
