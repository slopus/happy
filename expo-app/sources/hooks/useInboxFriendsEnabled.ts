import { useSetting } from '@/sync/storage';
import { isInboxFriendsEnabled } from '@/experiments/inboxFriends';

export function useInboxFriendsEnabled(): boolean {
    const experiments = useSetting('experiments');
    const expInboxFriends = useSetting('expInboxFriends');

    return isInboxFriendsEnabled({ experiments, expInboxFriends });
}

