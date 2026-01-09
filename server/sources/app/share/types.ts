/**
 * Common select for user profile information
 */
export const PROFILE_SELECT = {
    id: true,
    firstName: true,
    lastName: true,
    username: true,
    avatar: true
} as const;

/**
 * User profile type (inferred from PROFILE_SELECT)
 */
export type UserProfile = {
    id: string;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    avatar: any | null; // JSON field
};
