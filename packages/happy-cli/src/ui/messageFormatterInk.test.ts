/**
 * Tests for the Ink message formatter — specifically the hook_response branch
 * that surfaces a hook's `systemMessage` to the terminal UI.
 */

import { describe, it, expect } from 'vitest'

import { formatClaudeMessageForInk } from './messageFormatterInk.js'
import { MessageBuffer } from './ink/messageBuffer.js'

function makeHookResponse(opts: {
    output?: string
    stdout?: string
    stderr?: string
    exit_code?: number
    outcome?: 'success' | 'error' | 'cancelled'
}): any {
    return {
        type: 'system',
        subtype: 'hook_response',
        hook_id: 'h1',
        hook_name: 'UserPromptSubmit:test',
        hook_event: 'UserPromptSubmit',
        output: opts.output ?? '',
        stdout: opts.stdout ?? '',
        stderr: opts.stderr ?? '',
        exit_code: opts.exit_code ?? 0,
        outcome: opts.outcome ?? 'success',
        uuid: 'u1',
        session_id: 's1',
    }
}

describe('formatClaudeMessageForInk — hook_response systemMessage', () => {

    it('renders systemMessage from a blocking hook (stderr + exit_code 2)', () => {
        const buf = new MessageBuffer()
        const stderrJson = JSON.stringify({
            hookSpecificOutput: { decision: 'BLOCK' },
            systemMessage: '⏰ Workout time! All sessions blocked until 06:40.',
        })
        formatClaudeMessageForInk(
            makeHookResponse({ output: stderrJson, stderr: stderrJson, exit_code: 2, outcome: 'error' }),
            buf,
        )
        const messages = buf.getMessages()
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({
            content: '⏺ ⏰ Workout time! All sessions blocked until 06:40.',
            type: 'system',
        })
    })

    it('renders systemMessage from a passing hook (stdout + exit_code 0)', () => {
        const buf = new MessageBuffer()
        const stdoutJson = JSON.stringify({ continue: true, systemMessage: '🚀 Session started' })
        formatClaudeMessageForInk(
            makeHookResponse({ output: stdoutJson, stdout: stdoutJson }),
            buf,
        )
        const messages = buf.getMessages()
        expect(messages).toHaveLength(1)
        expect(messages[0].content).toBe('⏺ 🚀 Session started')
    })

    it('drops hook_response with no systemMessage (e.g. plain logging hooks)', () => {
        const buf = new MessageBuffer()
        formatClaudeMessageForInk(
            makeHookResponse({ output: 'Sync started\n', stdout: 'Sync started\n' }),
            buf,
        )
        expect(buf.getMessages()).toHaveLength(0)
    })

    it('drops hook_response with non-JSON stderr', () => {
        const buf = new MessageBuffer()
        formatClaudeMessageForInk(
            makeHookResponse({ output: 'cmd not found', stderr: 'cmd not found', exit_code: 127, outcome: 'error' }),
            buf,
        )
        expect(buf.getMessages()).toHaveLength(0)
    })

    it('handles malformed JSON without throwing', () => {
        const buf = new MessageBuffer()
        expect(() => formatClaudeMessageForInk(
            makeHookResponse({ output: '{not valid', stdout: '{not valid' }),
            buf,
        )).not.toThrow()
        expect(buf.getMessages()).toHaveLength(0)
    })
})
