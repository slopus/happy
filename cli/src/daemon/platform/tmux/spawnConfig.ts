import { buildHappyCliSubprocessInvocation } from '@/utils/spawnHappyCLI';
import type { CatalogAgentId } from '@/backends/types';

export function buildTmuxWindowEnv(
  daemonEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
): Record<string, string> {
  const filteredDaemonEnv = Object.fromEntries(
    Object.entries(daemonEnv).filter(([, value]) => typeof value === 'string'),
  ) as Record<string, string>;

  return { ...filteredDaemonEnv, ...extraEnv };
}

export function buildTmuxSpawnConfig(params: {
  agent: CatalogAgentId;
  directory: string;
  extraEnv: Record<string, string>;
  tmuxCommandEnv?: Record<string, string>;
  extraArgs?: string[];
}): {
  commandTokens: string[];
  tmuxEnv: Record<string, string>;
  tmuxCommandEnv: Record<string, string>;
  directory: string;
} {
  const args = [
    params.agent,
    '--happy-starting-mode',
    'remote',
    '--started-by',
    'daemon',
    ...(params.extraArgs ?? []),
  ];

  const { runtime, argv } = buildHappyCliSubprocessInvocation(args);
  const commandTokens = [runtime, ...argv];

  const tmuxEnv = buildTmuxWindowEnv(process.env, params.extraEnv);

  const tmuxCommandEnv: Record<string, string> = { ...(params.tmuxCommandEnv ?? {}) };
  const tmuxTmpDir = tmuxCommandEnv.TMUX_TMPDIR;
  if (typeof tmuxTmpDir !== 'string' || tmuxTmpDir.length === 0) {
    delete tmuxCommandEnv.TMUX_TMPDIR;
  }

  return {
    commandTokens,
    tmuxEnv,
    tmuxCommandEnv,
    directory: params.directory,
  };
}
