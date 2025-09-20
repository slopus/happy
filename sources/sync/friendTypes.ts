import * as z from 'zod';
import { ImageRefSchema } from './profile';

//
// Relationship Status
//

export const RelationshipStatusSchema = z.enum(['none', 'requested', 'pending', 'friend', 'rejected']);
export type RelationshipStatus = z.infer<typeof RelationshipStatusSchema>;

//
// User Profile (Friend)
//

export const UserProfileSchema = z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    avatar: z.object({
        path: z.string(),
        url: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        thumbhash: z.string().optional()
    }).nullable(),
    username: z.string(),
    status: RelationshipStatusSchema
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

// Friend Request type no longer used in new API

//
// Relationship Updated Event
//

export const RelationshipUpdatedEventSchema = z.object({
    fromUserId: z.string(),
    toUserId: z.string(),
    status: RelationshipStatusSchema,
    action: z.enum(['created', 'updated', 'deleted']),
    fromUser: UserProfileSchema.optional(),
    toUser: UserProfileSchema.optional(),
    timestamp: z.number()
});

export type RelationshipUpdatedEvent = z.infer<typeof RelationshipUpdatedEventSchema>;

//
// API Response Types
//

export const UserResponseSchema = z.object({
    user: UserProfileSchema
});

export type UserResponse = z.infer<typeof UserResponseSchema>;

export const FriendsResponseSchema = z.object({
    friends: z.array(UserProfileSchema)
});

export type FriendsResponse = z.infer<typeof FriendsResponseSchema>;

export const UsersSearchResponseSchema = z.object({
    users: z.array(UserProfileSchema)
});

export type UsersSearchResponse = z.infer<typeof UsersSearchResponseSchema>;

//
// Utility functions
//

export function getDisplayName(profile: UserProfile): string {
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    return fullName || profile.username;
}

export function isFriend(status: RelationshipStatus): boolean {
    return status === 'friend';
}

export function isPendingRequest(status: RelationshipStatus): boolean {
    return status === 'pending';
}

export function isRequested(status: RelationshipStatus): boolean {
    return status === 'requested';
}