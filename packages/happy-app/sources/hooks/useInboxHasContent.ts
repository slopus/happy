import { useUpdates } from './useUpdates';
import { useFriendRequests, useRequestedFriends, useFeedItems } from '@/sync/storage';
import { useChangelog } from './useChangelog';
import { useCodexAttachCandidateInbox } from './useCodexAttachCandidateInbox';

// Hook to check if inbox has content to show
export function useInboxHasContent(): boolean {
    const { updateAvailable } = useUpdates();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const changelog = useChangelog();
    const codexCandidates = useCodexAttachCandidateInbox();

    // Show dot if there's any actionable content:
    // - App updates available
    // - Incoming friend requests (also shown as badge)
    // - Outgoing friend requests pending
    // - Feed items (activity updates)
    // - Unread changelog entries
    return updateAvailable
        || codexCandidates.candidates.length > 0
        || friendRequests.length > 0
        || requestedFriends.length > 0
        || (changelog.hasUnread === true);
}
