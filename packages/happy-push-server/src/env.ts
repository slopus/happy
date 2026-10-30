export interface Env {
    DB: D1Database;
    /** APNs token-auth key id (the 10-char id of the .p8 key). */
    APNS_KEY_ID?: string;
    /** Apple developer team id. */
    APNS_TEAM_ID?: string;
    /** Contents of the AuthKey_<id>.p8 file (PKCS#8 PEM). */
    APNS_PRIVATE_KEY?: string;
    /** Firebase service-account JSON with firebase.messaging permission. */
    FCM_SERVICE_ACCOUNT?: string;
    /** Comma-separated app ids allowed to register. Empty or unset allows any. */
    ALLOWED_APP_IDS?: string;
    /**
     * Per-recipient send limit, keyed by push token. Optional so tests and
     * local dev run without the binding; absent means unlimited.
     */
    SEND_RATE_LIMITER?: RateLimit;
    /** Per-client-IP limit on register/unregister. Optional like the above. */
    REGISTER_RATE_LIMITER?: RateLimit;
}
