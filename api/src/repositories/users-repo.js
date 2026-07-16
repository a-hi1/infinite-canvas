/**
 * Users repository façade.
 * Current implementation delegates to the JSON DB; future storage swaps should happen here.
 */
export function createUsersRepo(db) {
    return {
        findByEmail(email) {
            return db.findUserByEmail(email);
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
