import { describe, expect, it } from 'vitest'

import { HAPPY_DEFAULT_ENTRYPOINT, resolveHappyEntrypoint } from './happyEntrypoint'

describe('resolveHappyEntrypoint', () => {
    it('falls back to the Happy default when no value is set', () => {
        expect(resolveHappyEntrypoint(undefined)).toBe(HAPPY_DEFAULT_ENTRYPOINT)
        expect(resolveHappyEntrypoint('')).toBe(HAPPY_DEFAULT_ENTRYPOINT)
    })

    it('keeps a value the operator already exported', () => {
        expect(resolveHappyEntrypoint('cli')).toBe('cli')
        expect(resolveHappyEntrypoint('claude-vscode')).toBe('claude-vscode')
        expect(resolveHappyEntrypoint('sdk-ts')).toBe('sdk-ts')
    })

    it('uses a default that is NOT in the SDK picker-filter set', () => {
        // Claude Code's `--resume` picker hides sessions whose recorded
        // entrypoint is one of these. The Happy default must avoid that set
        // so Happy-touched sessions stay visible in the picker.
        const sdkPickerFilterSet = new Set(['sdk-cli', 'sdk-ts', 'sdk-py'])
        expect(sdkPickerFilterSet.has(HAPPY_DEFAULT_ENTRYPOINT)).toBe(false)
    })

    it('uses a default Claude Code recognises as a valid entrypoint', () => {
        // Mirrors `zO9` allowlist in the Claude Code binary (v2.1.x). If the
        // value falls outside this set, several internal helpers drop it.
        const claudeKnownEntrypoints = new Set([
            'cli',
            'mcp',
            'sdk-cli',
            'sdk-ts',
            'sdk-py',
            'bench',
            'claude-vscode',
            'claude-code-github-action',
            'local-agent',
            'claude-desktop',
            'remote',
            'remote_baku',
            'remote_desktop',
            'remote_mobile',
            'claude_in_slack',
            'claude-desktop-3p',
            'ssh-remote',
        ])
        expect(claudeKnownEntrypoints.has(HAPPY_DEFAULT_ENTRYPOINT)).toBe(true)
    })
})
