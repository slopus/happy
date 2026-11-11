import { describe, expect, it } from 'vitest'

import { resolveClaudeCodeExecutable } from './query'

describe('which Claude Code binary a session spawns', () => {
    it('is the SDK default when the environment names none', () => {
        expect(resolveClaudeCodeExecutable({})).toBeUndefined()
    })

    it('is the one the environment names', () => {
        expect(resolveClaudeCodeExecutable({ HAPPY_CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude' }))
            .toBe('/usr/local/bin/claude')
    })

    it('ignores surrounding whitespace rather than spawning a path that does not exist', () => {
        expect(resolveClaudeCodeExecutable({ HAPPY_CLAUDE_CODE_EXECUTABLE: '  /opt/claude  ' }))
            .toBe('/opt/claude')
    })

    it('is the SDK default when the variable is exported but empty', () => {
        expect(resolveClaudeCodeExecutable({ HAPPY_CLAUDE_CODE_EXECUTABLE: '   ' })).toBeUndefined()
    })
})
