// Kept in a leaf module so bot-secrets.ts can share it without importing domain.ts,
// which imports events.ts, which imports bot-secrets.ts.
export const AGENT_SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
