import { z } from "zod";

//
// Session Sharing Types
//

/**
 * Access level for session sharing
 *
 * @remarks
 * Defines the permission level a user has when accessing a shared session:
 * - `view`: Read-only access to session messages and metadata
 * - `edit`: Can send messages but cannot manage sharing settings
 * - `admin`: Full access including sharing management
 */
export type ShareAccessLevel = 'view' | 'edit' | 'admin';

/**
 * User profile information included in share responses
 *
 * @remarks
 * This is a subset of the full user profile, containing only the information
 * necessary for displaying who has access to a session.
 */
export interface ShareUserProfile {
    /** Unique user identifier */
    id: string;
    /** User's unique username */
    username: string | null;
    /** User's first name, if set */
    firstName: string | null;
    /** User's last name, if set */
    lastName: string | null;
    /** URL to user's avatar image, if set */
    avatar: string | null;
}

/**
 * Session share (direct user-to-user sharing)
 *
 * @remarks
 * Represents a direct share of a session between two users. The session owner
 * can share with specific users who must be friends. Each share has an access
 * level that determines what the shared user can do.
 *
 * The `encryptedDataKey` is only present when the current user is the recipient
 * of the share, allowing them to decrypt the session data.
 */
export interface SessionShare {
    /** Unique identifier for this share */
    id: string;
    /** ID of the session being shared */
    sessionId: string;
    /** User who receives access to the session */
    sharedWithUser: ShareUserProfile;
    /** User who created the share (optional, only in some contexts) */
    sharedBy?: ShareUserProfile;
    /** Access level granted to the shared user */
    accessLevel: ShareAccessLevel;
    /**
     * Session data encryption key, encrypted with the recipient's public key
     *
     * @remarks
     * Base64 encoded. Only present when accessing as the shared user.
     * Used to decrypt the session's messages and data.
     */
    encryptedDataKey?: string;
    /** Timestamp when the share was created (milliseconds since epoch) */
    createdAt: number;
    /** Timestamp when the share was last updated (milliseconds since epoch) */
    updatedAt: number;
}

/**
 * Public session share (link-based sharing)
 *
 * @remarks
 * Represents a public link that allows anyone with the token to access a session.
 * Public shares are always read-only for security reasons. They can have optional
 * expiration dates and usage limits.
 *
 * When `isConsentRequired` is true, users must explicitly consent to logging of
 * their IP address and user agent before accessing the session.
 */
export interface PublicSessionShare {
    /** Unique identifier for this public share */
    id: string;
    /** ID of the session being shared (optional in some contexts) */
    sessionId?: string;
    /**
     * Random token used in the public URL
     *
     * @remarks
     * Public-share tokens are stored hashed on the server and cannot be recovered.
     * The server returns the token only at creation/rotation time.
     */
    token: string | null;
    /**
     * Expiration timestamp (milliseconds since epoch), or null if never expires
     *
     * @remarks
     * After this time, the link will no longer be accessible.
     */
    expiresAt: number | null;
    /**
     * Maximum number of times the link can be accessed, or null for unlimited
     *
     * @remarks
     * Once `useCount` reaches this value, the link becomes inaccessible.
     */
    maxUses: number | null;
    /** Number of times the link has been accessed */
    useCount: number;
    /**
     * Whether users must consent to access logging
     *
     * @remarks
     * If true, the user must explicitly consent before their IP address and
     * user agent are logged. If false, access is not logged.
     */
    isConsentRequired: boolean;
    /** Timestamp when the share was created (milliseconds since epoch) */
    createdAt: number;
    /** Timestamp when the share was last updated (milliseconds since epoch) */
    updatedAt: number;
}

/**
 * Access log entry for public shares
 *
 * @remarks
 * Records when and by whom a public share was accessed. IP address and user
 * agent are only logged if the user gave consent or consent was not required.
 */
export interface PublicShareAccessLog {
    /** Unique identifier for this log entry */
    id: string;
    /**
     * User who accessed the share, if authenticated
     *
     * @remarks
     * Null if the user accessed anonymously without authentication.
     */
    user: ShareUserProfile | null;
    /** Timestamp of access (milliseconds since epoch) */
    accessedAt: number;
    /**
     * IP address of the accessor
     *
     * @remarks
     * Only logged if user gave consent (when `isConsentRequired` is true)
     * or if consent was not required.
     */
    ipAddress: string | null;
    /**
     * User agent string of the accessor's browser
     *
     * @remarks
     * Only logged if user gave consent (when `isConsentRequired` is true)
     * or if consent was not required.
     */
    userAgent: string | null;
}

/**
 * Blocked user for public shares
 *
 * @remarks
 * Represents a user who has been blocked from accessing a specific public share.
 * Even if they have the token, blocked users will receive a 404 error.
 */
export interface PublicShareBlockedUser {
    /** Unique identifier for this block entry */
    id: string;
    /** User who is blocked */
    user: ShareUserProfile;
    /** Optional reason for blocking (displayed to owner) */
    reason: string | null;
    /** Timestamp when user was blocked (milliseconds since epoch) */
    blockedAt: number;
}

//
// API Request/Response Types
//

/**
 * Request to create or update a session share
 *
 * @remarks
 * Used when sharing a session with a specific user. The user must be a friend
 * of the session owner. The server will handle encryption of the data key with
 * the recipient's public key.
 */
export interface CreateSessionShareRequest {
    /** ID of the user to share with */
    userId: string;
    /** Access level to grant */
    accessLevel: ShareAccessLevel;
    /** Base64 encoded (v0 + box bundle) */
    encryptedDataKey: string;
}

/** Response containing a single session share */
export interface SessionShareResponse {
    /** The created or updated share */
    share: SessionShare;
}

/** Response containing multiple session shares */
export interface SessionSharesResponse {
    /** List of shares for a session */
    shares: SessionShare[];
}

/**
 * Request to create or update a public share
 *
 * @remarks
 * Creates a public link for a session. The link can optionally have an
 * expiration date, usage limit, and consent requirement for access logging.
 */
export interface CreatePublicShareRequest {
    /**
     * Session data encryption key, encrypted for public access
     *
     * @remarks
     * Base64 encoded. Typically encrypted with a key derived from the token.
     */
    encryptedDataKey: string;
    /**
     * Optional expiration timestamp (milliseconds since epoch)
     *
     * @remarks
     * After this time, the link will no longer be accessible.
     */
    expiresAt?: number;
    /**
     * Optional maximum number of accesses
     *
     * @remarks
     * Once this limit is reached, the link becomes inaccessible.
     */
    maxUses?: number;
    /**
     * Whether to require user consent for access logging
     *
     * @remarks
     * If true, users must explicitly consent before their IP and user agent
     * are logged. Defaults to false.
     */
    isConsentRequired?: boolean;
}

/** Response containing a public share */
export interface PublicShareResponse {
    /** The created, updated, or retrieved public share */
    publicShare: PublicSessionShare;
}

/**
 * Response when accessing a session via public share
 *
 * @remarks
 * Returns the session data and encrypted key needed to decrypt it.
 * Public shares always have view-only access.
 */
export interface AccessPublicShareResponse {
    /** Session information */
    session: {
        /** Session ID */
        id: string;
        /** Session sequence number */
        seq: number;
        /** Creation timestamp (milliseconds since epoch) */
        createdAt: number;
        /** Last update timestamp (milliseconds since epoch) */
        updatedAt: number;
        /** Whether session is active */
        active: boolean;
        /** Last activity timestamp (milliseconds since epoch) */
        activeAt: number;
        /** Session metadata */
        metadata: any;
        /** Metadata version number */
        metadataVersion: number;
        /** Agent state */
        agentState: any;
        /** Agent state version number */
        agentStateVersion: number;
    };
    /** Access level (always 'view' for public shares) */
    accessLevel: 'view';
    /** Encrypted data key for decrypting session (base64) */
    encryptedDataKey: string;
    /** Session owner profile */
    owner: ShareUserProfile;
    /** Whether consent is required (echoed) */
    isConsentRequired: boolean;
}

/** Response containing access logs for a public share */
export interface PublicShareAccessLogsResponse {
    /** List of access log entries */
    logs: PublicShareAccessLog[];
}

/** Response containing blocked users for a public share */
export interface PublicShareBlockedUsersResponse {
    /** List of blocked users */
    blockedUsers: PublicShareBlockedUser[];
}

/**
 * Request to block a user from a public share
 *
 * @remarks
 * Prevents a specific user from accessing a public share, even if they
 * have the token. Useful for dealing with abuse.
 */
export interface BlockPublicShareUserRequest {
    /** ID of the user to block */
    userId: string;
    /**
     * Optional reason for blocking
     *
     * @remarks
     * This is only visible to the session owner and helps track why
     * users were blocked.
     */
    reason?: string;
}

//
// Error Types
//

/**
 * Base error class for session sharing operations
 *
 * @remarks
 * All session sharing errors extend from this class for easy error handling.
 */
export class SessionSharingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SessionSharingError';
    }
}

/**
 * Error thrown when a requested share does not exist
 *
 * @remarks
 * This can occur when trying to access, update, or delete a share that
 * has already been deleted or never existed.
 */
export class ShareNotFoundError extends SessionSharingError {
    constructor() {
        super('Share not found');
        this.name = 'ShareNotFoundError';
    }
}

/**
 * Error thrown when a public share token is invalid or expired
 *
 * @remarks
 * This can occur if:
 * - The token doesn't exist
 * - The share has expired (past `expiresAt`)
 * - The maximum uses have been reached
 * - The current user is blocked
 */
export class PublicShareNotFoundError extends SessionSharingError {
    constructor() {
        super('Public share not found or expired');
        this.name = 'PublicShareNotFoundError';
    }
}

/**
 * Error thrown when accessing a public share that requires consent
 *
 * @remarks
 * When `isConsentRequired` is true, users must explicitly consent to
 * access logging by passing `consent=true` in the request. This error
 * indicates the consent parameter was missing or false.
 */
export class ConsentRequiredError extends SessionSharingError {
    constructor() {
        super('Consent required for access');
        this.name = 'ConsentRequiredError';
    }
}

/**
 * Error thrown when a public share has reached its maximum usage limit
 *
 * @remarks
 * When a public share has a `maxUses` limit and that limit has been
 * reached, further access attempts will fail with this error.
 */
export class MaxUsesReachedError extends SessionSharingError {
    constructor() {
        super('Maximum uses reached');
        this.name = 'MaxUsesReachedError';
    }
}
