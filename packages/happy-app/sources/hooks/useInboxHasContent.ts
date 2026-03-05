import { useUpdates } from './useUpdates';
import { useFriendRequests, useRequestedFriends } from '@/sync/storage';
import { useChangelog } from './useChangelog';
import { useNativeUpdate } from './useNativeUpdate';

// Hook to check if inbox has content to show
export function useInboxHasContent(): boolean {
    const { updateAvailable } = useUpdates();
    const nativeUpdateUrl = useNativeUpdate();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const changelog = useChangelog();

    // Show dot if there's any actionable content:
    // - Native app update available (App Store / Play Store)
    // - OTA update available
    // - Incoming friend requests (also shown as badge number)
    // - Outgoing friend requests pending
    // - Unread changelog entries
    return !!nativeUpdateUrl || updateAvailable || friendRequests.length > 0 || requestedFriends.length > 0 || (changelog.hasUnread === true);
}