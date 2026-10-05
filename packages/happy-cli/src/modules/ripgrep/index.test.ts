/**
 * Tests for low-level ripgrep wrapper
 */

import { describe, it, expect } from 'vitest'
import { run, DEFAULT_MAX_OUTPUT_BYTES } from './index'

describe('ripgrep low-level wrapper', () => {
    it('should get version', async () => {
        const result = await run(['--version'])
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('ripgrep')
    })
    
    it('should search for pattern', async () => {
        const result = await run(['describe', 'src/modules/ripgrep/index.test.ts'])
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('describe')
    })
    
    it('should return exit code 1 for no matches', async () => {
        const result = await run(['ThisPatternShouldNeverMatch999', 'package.json'])
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe('')
    })
    
    it('should handle JSON output', async () => {
        const result = await run(['--json', 'describe', 'src/modules/ripgrep/index.test.ts'])
        expect(result.exitCode).toBe(0)
        
        // Parse first line to check it's valid JSON
        const lines = result.stdout.trim().split('\n')
        const firstLine = JSON.parse(lines[0])
        expect(firstLine).toHaveProperty('type')
    })
    
    it('should respect custom working directory', async () => {
        const result = await run(['describe', 'index.test.ts'], { cwd: 'src/modules/ripgrep' })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('describe')
    })

    it('should exposes a sane default output cap', () => {
        // 32 MiB — well below V8's ~512 MiB string-length limit, more than
        // enough for any LLM-facing grep result. Regression guard for #1195.
        expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(32 * 1024 * 1024)
    })

    it('reports truncation on stderr without appending a marker to stdout', async () => {
        // Search a regex that matches every line in node_modules — guaranteed
        // many matches — but cap at 4 KiB so we hit the truncation branch
        // quickly. The match pattern `.` matches any non-empty character.
        const result = await run([
            '--no-heading',
            '--no-line-number',
            '.', // match-anything regex
            'src',
        ], { cwd: '.', maxBufferBytes: 4096 })

        expect(result.truncated).toBe(true)
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout.length).toBeLessThanOrEqual(4096)
        expect(result.stdout).not.toMatch(/output truncated at \d+ MiB cap/)
        expect(result.stderr).toMatch(/output truncated at \d+ MiB cap/)
    })

    it('forces a non-zero exit code when output is truncated even if ripgrep exits cleanly', async () => {
        const result = await run(['--version'], { maxBufferBytes: 1 })

        expect(result.truncated).toBe(true)
        expect(result.exitCode).not.toBe(0)
    })
})
