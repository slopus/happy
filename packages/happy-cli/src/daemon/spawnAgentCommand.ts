import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers'

type SpawnAgent = SpawnSessionOptions['agent']

export function resolveTmuxSpawnAgentCommand(agent: SpawnAgent): string | undefined {
  switch (agent) {
    case undefined:
    case 'claude':
      return 'claude'
    case 'codex':
      return 'codex'
    case 'gemini':
      return 'gemini'
    case 'openclaw':
      return 'openclaw'
    case 'opencode':
      return 'acp opencode'
  }
}

export function resolveRegularSpawnAgentArgs(agent: SpawnAgent): string[] | undefined {
  switch (agent) {
    case undefined:
    case 'claude':
      return ['claude']
    case 'codex':
      return ['codex']
    case 'gemini':
      return ['gemini']
    case 'openclaw':
      return ['openclaw']
    case 'opencode':
      return ['acp', 'opencode']
  }
}
