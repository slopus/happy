import { describe, expect, it } from 'vitest'
import { resolveRegularSpawnAgentArgs, resolveTmuxSpawnAgentCommand } from './spawnAgentCommand'

describe('spawnAgentCommand', () => {
  it('routes opencode through the ACP subcommand for regular process spawn', () => {
    expect(resolveRegularSpawnAgentArgs('opencode')).toEqual(['acp', 'opencode'])
  })

  it('routes opencode through the ACP subcommand for tmux spawn', () => {
    expect(resolveTmuxSpawnAgentCommand('opencode')).toBe('acp opencode')
  })

  it('keeps existing agents on their direct commands', () => {
    expect(resolveRegularSpawnAgentArgs('claude')).toEqual(['claude'])
    expect(resolveRegularSpawnAgentArgs('codex')).toEqual(['codex'])
    expect(resolveRegularSpawnAgentArgs('gemini')).toEqual(['gemini'])
    expect(resolveRegularSpawnAgentArgs('openclaw')).toEqual(['openclaw'])

    expect(resolveTmuxSpawnAgentCommand('claude')).toBe('claude')
    expect(resolveTmuxSpawnAgentCommand('codex')).toBe('codex')
    expect(resolveTmuxSpawnAgentCommand('gemini')).toBe('gemini')
    expect(resolveTmuxSpawnAgentCommand('openclaw')).toBe('openclaw')
  })
})
