/**
 * Asset manifest repository façade.
 * One manifest document per user; media bytes remain in files via /api/blobs.
 */
export function createAssetsRepo(db) {
    return {
        getForUser(userId) {
            return db.readAssetManifest(userId);
        },
        putForUser(userId, manifest, options) {
            return db.upsertAssetManifest(userId, manifest, options);
        },
    };
}
