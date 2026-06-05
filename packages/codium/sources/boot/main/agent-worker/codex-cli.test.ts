import { describe, expect, it } from 'vitest'
import { buildCodexExecArgs } from './codex-cli'

describe('buildCodexExecArgs', () => {
    it('uses the current codex exec approval wrapper', () => {
        const args = buildCodexExecArgs({
            prompt: 'Write a test',
            outputPath: '/tmp/codium-last-message.txt',
            cwd: '/repo/project',
            model: 'gpt-5.2',
        })

        expect(args).toEqual([
            'exec',
            '--json',
            '--color',
            'never',
            '-c',
            'approval_policy="never"',
            '--sandbox',
            'workspace-write',
            '--output-last-message',
            '/tmp/codium-last-message.txt',
            '--cd',
            '/repo/project',
            '--model',
            'gpt-5.2',
            '--',
            'Write a test',
        ])
        expect(args).not.toContain('--ask-for-approval')
    })

    it('passes prompt text after an option terminator', () => {
        const args = buildCodexExecArgs({
            prompt: '--this is prompt text, not an option',
            outputPath: '/tmp/out.txt',
        })

        expect(args.at(-1)).toBe('--this is prompt text, not an option')
        expect(args.at(-2)).toBe('--')
    })
})
