export function handleRelationshipUpdatedSocketUpdate(params: {
    relationshipUpdate: any;
    applyRelationshipUpdate: (update: any) => void;
    invalidateFriends: () => void;
    invalidateFriendRequests: () => void;
    invalidateFeed: () => void;
}): void {
    const { relationshipUpdate, applyRelationshipUpdate, invalidateFriends, invalidateFriendRequests, invalidateFeed } = params;

    // Apply the relationship update to storage
    applyRelationshipUpdate({
        fromUserId: relationshipUpdate.fromUserId,
        toUserId: relationshipUpdate.toUserId,
        status: relationshipUpdate.status,
        action: relationshipUpdate.action,
        fromUser: relationshipUpdate.fromUser,
        toUser: relationshipUpdate.toUser,
        timestamp: relationshipUpdate.timestamp,
    });

    // Invalidate friends data to refresh with latest changes
    invalidateFriends();
    invalidateFriendRequests();
    invalidateFeed();
}
