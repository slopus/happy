import type { RelationshipUpdatedEvent, UserProfile } from '../../friendTypes';
import type { StoreGet, StoreSet } from './_shared';

export type FriendsDomain = {
  friends: Record<string, UserProfile>;
  users: Record<string, UserProfile | null>;
  friendsLoaded: boolean;
  applyFriends: (friends: UserProfile[]) => void;
  applyRelationshipUpdate: (event: RelationshipUpdatedEvent) => void;
  getFriend: (userId: string) => UserProfile | undefined;
  getAcceptedFriends: () => UserProfile[];
  applyUsers: (users: Record<string, UserProfile | null>) => void;
  getUser: (userId: string) => UserProfile | null | undefined;
  assumeUsers: (userIds: string[]) => Promise<void>;
};

export function createFriendsDomain<
  S extends FriendsDomain & { profile: { id: string } },
>({ set, get }: { set: StoreSet<S>; get: StoreGet<S> }): FriendsDomain {
  return {
    friends: {},
    users: {},
    friendsLoaded: false,
    applyFriends: (friends) =>
      set((state) => {
        const mergedFriends = { ...state.friends };
        friends.forEach((friend) => {
          mergedFriends[friend.id] = friend;
        });
        return {
          ...state,
          friends: mergedFriends,
          friendsLoaded: true, // Mark as loaded after first fetch
        };
      }),
    applyRelationshipUpdate: (event) =>
      set((state) => {
        const { fromUserId, toUserId, status, action, fromUser, toUser } = event;
        const currentUserId = state.profile.id;

        // Update friends cache
        const updatedFriends = { ...state.friends };

        // Determine which user profile to update based on perspective
        const otherUserId = fromUserId === currentUserId ? toUserId : fromUserId;
        const otherUser = fromUserId === currentUserId ? toUser : fromUser;

        if (action === 'deleted' || status === 'none') {
          // Remove from friends if deleted or status is none
          delete updatedFriends[otherUserId];
        } else if (otherUser) {
          // Update or add the user profile with current status
          updatedFriends[otherUserId] = otherUser;
        }

        return {
          ...state,
          friends: updatedFriends,
        };
      }),
    getFriend: (userId) => get().friends[userId],
    getAcceptedFriends: () => {
      const friends = get().friends;
      return Object.values(friends).filter((friend) => friend.status === 'friend');
    },
    applyUsers: (users) =>
      set((state) => ({
        ...state,
        users: { ...state.users, ...users },
      })),
    getUser: (userId) => get().users[userId], // Returns UserProfile | null | undefined
    assumeUsers: async (userIds) => {
      // This will be implemented in sync.ts as it needs access to credentials
      // Just a placeholder here for the interface
      const { sync } = await import('../../sync');
      return sync.assumeUsers(userIds);
    },
  };
}

