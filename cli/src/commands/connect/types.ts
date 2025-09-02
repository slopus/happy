/**
 * Type definitions for Codex authentication
 */

export interface CodexAuthTokens {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
}

export interface PKCECodes {
    verifier: string;
    challenge: string;
}

export interface ClaudeAuthTokens {
    raw: any;
    token: string;
    expires: number;
}