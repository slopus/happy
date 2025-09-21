import { useUpdates } from './useUpdates';
import { useFriendRequests } from '@/sync/storage';
import { useChangelog } from './useChangelog';

// Hook to check if inbox has content to show
export function useInboxHasContent(): boolean {
    const { updateAvailable } = useUpdates();
    const friendRequests = useFriendRequests();
    const changelog = useChangelog();
    return updateAvailable || friendRequests.length > 0 || changelog.hasUnread;
}