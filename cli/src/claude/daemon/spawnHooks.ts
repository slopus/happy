import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';

export const claudeDaemonSpawnHooks: DaemonSpawnHooks = {
  buildAuthEnv: async ({ token }) => ({
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    cleanupOnFailure: null,
    cleanupOnExit: null,
  }),
};

