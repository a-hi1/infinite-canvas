/**
 * Collaborative workspaces repository façade.
 * Keeps share/ACL data separate from private assets/jobs/projects.
 */
export function createWorkspacesRepo(db) {
    return {
        create(input) {
            return db.createWorkspace(input);
        },
        findById(workspaceId) {
            return db.findWorkspaceById(workspaceId);
        },
        findByInviteCode(inviteCode) {
            return db.findWorkspaceByInviteCode(inviteCode);
        },
        listForUser(userId) {
            return db.listWorkspacesForUser(userId);
        },
        findMembership(workspaceId, userId) {
            return db.findMembership(workspaceId, userId);
        },
        listMembers(workspaceId) {
            return db.listMembers(workspaceId);
        },
        addMember(input) {
            return db.addWorkspaceMember(input);
        },
        removeMember(workspaceId, userId) {
            return db.removeWorkspaceMember(workspaceId, userId);
        },
        resetInviteCode(workspaceId, ownerId, inviteCode) {
            return db.resetWorkspaceInviteCode(workspaceId, ownerId, inviteCode);
        },
        archive(workspaceId, ownerId) {
            return db.archiveWorkspace(workspaceId, ownerId);
        },
        createItem(input) {
            return db.createWorkspaceItem(input);
        },
        listItems(workspaceId, options) {
            return db.listWorkspaceItems(workspaceId, options);
        },
        findItem(itemId, workspaceId) {
            return db.findWorkspaceItem(itemId, workspaceId);
        },
        updateItem(itemId, workspaceId, patch) {
            return db.updateWorkspaceItem(itemId, workspaceId, patch);
        },
        upsertItemReaction(itemId, workspaceId, input) {
            return db.upsertWorkspaceItemReaction(itemId, workspaceId, input);
        },
        clearItemReaction(itemId, workspaceId, userId) {
            return db.clearWorkspaceItemReaction(itemId, workspaceId, userId);
        },
        softDeleteItem(itemId, workspaceId) {
            return db.softDeleteWorkspaceItem(itemId, workspaceId);
        },
        findFileAccess(fileId, userId) {
            return db.findWorkspaceFileAccess(fileId, userId);
        },
        createTask(input) {
            return db.createWorkspaceTask(input);
        },
        listTasks(workspaceId) {
            return db.listWorkspaceTasks(workspaceId);
        },
        findTask(taskId, workspaceId) {
            return db.findWorkspaceTask(taskId, workspaceId);
        },
        updateTask(taskId, workspaceId, patch) {
            return db.updateWorkspaceTask(taskId, workspaceId, patch);
        },
        softDeleteTask(taskId, workspaceId) {
            return db.softDeleteWorkspaceTask(taskId, workspaceId);
        },
    };
}
