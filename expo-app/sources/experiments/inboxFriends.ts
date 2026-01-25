export function isInboxFriendsEnabled(input: { experiments: boolean; expInboxFriends: boolean }): boolean {
    return input.experiments === true && input.expInboxFriends === true;
}

