import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@/claude/sdk';
import { claudeProviderAuthErrorMessage, claudeProviderAuthMessage, CLAUDE_LOGIN_EXPIRED_MESSAGE } from './providerAuth';

const expired = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const assistant = (text: string, error: string | undefined = 'authentication_failed', parent_tool_use_id: string | null = null) => ({
    type: 'assistant', error, parent_tool_use_id,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
} as SDKMessage);

describe('Claude provider auth classification', () => {
    it('uses fixed host guidance without copying credentials, endpoints, or error detail', () => {
        const raw = `${expired}\nhttps://user:fixture-secret@example.invalid?token=fixture-secret`;
        expect(claudeProviderAuthMessage(assistant(raw))).toBe(CLAUDE_LOGIN_EXPIRED_MESSAGE);
        expect(claudeProviderAuthErrorMessage(new Error(raw))).toBe(CLAUDE_LOGIN_EXPIRED_MESSAGE);
        expect(CLAUDE_LOGIN_EXPIRED_MESSAGE).toContain('same OS user and Claude configuration');
        expect(CLAUDE_LOGIN_EXPIRED_MESSAGE).toContain('separate from Happy account login');
        expect(CLAUDE_LOGIN_EXPIRED_MESSAGE).toContain('review the conversation');
        expect(CLAUDE_LOGIN_EXPIRED_MESSAGE).toContain('Happy has not retried it');
        expect(CLAUDE_LOGIN_EXPIRED_MESSAGE).not.toContain('fixture-secret');
        expect(CLAUDE_LOGIN_EXPIRED_MESSAGE).not.toContain('example.invalid');
    });

    it('does not claim an API-key or custom-provider error means OAuth expired', () => {
        const notice = claudeProviderAuthMessage(assistant('Invalid API key: fixture-secret'));
        expect(notice).toContain('provider credentials/configuration');
        expect(notice).toContain('If you use Claude Code login');
        expect(notice).not.toContain('expired');
        expect(notice).not.toContain('fixture-secret');
    });

    it.each(['rate_limit', 'overloaded', 'billing_error', 'server_error', 'unknown', 'oauth_org_not_allowed'])('does not mistake %s for host login expiry', error => {
        expect(claudeProviderAuthMessage(assistant(expired, error))).toBeNull();
    });

    it.each([
        { type: 'user', message: { role: 'user', content: expired } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: expired, is_error: true }] } },
        { type: 'system', subtype: 'init', mcp_servers: [{ name: 'fixture', status: expired }] },
        assistant(expired, 'authentication_failed', 'child-tool'),
        { type: 'result', subtype: 'success', is_error: false, result: expired },
        { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`MCP server: ${expired}`] },
        { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 429 rate limit' },
    ])('ignores non-provider or non-error surfaces %#', message => {
        expect(claudeProviderAuthMessage(message as SDKMessage)).toBeNull();
    });

    it.each([
        new Error('401 Unauthorized'), new Error('fetch failed'), new Error('429 rate limit'),
        new Error('Happy authentication failed'), new Error(`MCP server: ${expired}`),
        new Error(`The user quoted: ${expired}`), expired, null,
    ])('does not classify unrelated or untyped exceptions %#', error => {
        expect(claudeProviderAuthErrorMessage(error)).toBeNull();
    });
});