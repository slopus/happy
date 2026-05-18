export interface CodexExecArgsInput {
    prompt: string
    outputPath: string
    cwd?: string
    model?: string
}

export function buildCodexExecArgs(input: CodexExecArgsInput): string[] {
    return [
        'exec',
        '--json',
        '--color',
        'never',
        '-c',
        'approval_policy="never"',
        '--sandbox',
        'workspace-write',
        '--output-last-message',
        input.outputPath,
        ...(input.cwd ? ['--cd', input.cwd] : []),
        ...(input.model ? ['--model', input.model] : []),
        '--',
        input.prompt,
    ]
}
