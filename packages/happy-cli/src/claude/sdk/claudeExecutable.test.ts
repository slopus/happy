import { describe, expect, it } from 'vitest'

import { resolveClaudeExecutableOverride } from './claudeExecutable'

describe('resolveClaudeExecutableOverride', () => {
    it('returns undefined when HAPPY_CLAUDE_PATH is not set', () => {
        expect(resolveClaudeExecutableOverride({})).toBeUndefined()
        expect(resolveClaudeExecutableOverride({ HAPPY_CLAUDE_PATH: '' })).toBeUndefined()
    })

    it('returns the override when it points to an existing file', () => {
        // process.execPath is the running node binary — guaranteed to exist.
        expect(resolveClaudeExecutableOverride({ HAPPY_CLAUDE_PATH: process.execPath })).toBe(process.execPath)
    })

    it('falls back to the bundled executable when the override is missing on disk', () => {
        expect(resolveClaudeExecutableOverride({ HAPPY_CLAUDE_PATH: '/nonexistent/claude-binary' })).toBeUndefined()
    })
})
