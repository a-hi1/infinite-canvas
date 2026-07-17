/**
 * Credits / ledger repository façade.
 * Append-only ledger; user.credit_balance_cents is a denormalized cache for /auth/me.
 */
export function createCreditsRepo(db) {
    return {
        getBalanceCents(userId) {
            return db.getUserCreditBalanceCents(userId);
        },
        listForUser(userId, options) {
            return db.listCreditLedgerForUser(userId, options);
        },
        findByIdempotency(userId, key) {
            return db.findCreditLedgerByIdempotency(userId, key);
        },
        /**
         * Append ledger row and update user balance cache.
         * amountCents: positive = credit, negative = debit (future charge).
         */
        append(input) {
            return db.appendCreditLedger(input);
        },
    };
}
