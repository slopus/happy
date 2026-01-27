import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';

import tmp from 'tmp';

import { getCodexAcpDepStatus } from '@/capabilities/deps/codexAcp';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';

export const codexDaemonSpawnHooks: DaemonSpawnHooks = {
  buildAuthEnv: async ({ token }) => {
    const codexHomeDir = tmp.dirSync();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        codexHomeDir.removeCallback();
      } catch {
        // best-effort
      }
    };

    try {
      await fs.writeFile(join(codexHomeDir.name, 'auth.json'), token);
    } catch (error) {
      cleanup();
      throw error;
    }

    return {
      env: { CODEX_HOME: codexHomeDir.name },
      cleanupOnFailure: cleanup,
      cleanupOnExit: cleanup,
    };
  },

  validateSpawn: async ({ experimentalCodexResume, experimentalCodexAcp }) => {
    if (experimentalCodexAcp !== true) return { ok: true };

    if (experimentalCodexResume === true) {
      return {
        ok: false,
        errorMessage: 'Invalid spawn options: Codex ACP and Codex resume MCP cannot both be enabled.',
      };
    }

    const envOverride = typeof process.env.HAPPY_CODEX_ACP_BIN === 'string' ? process.env.HAPPY_CODEX_ACP_BIN.trim() : '';
    if (envOverride) {
      if (!existsSync(envOverride)) {
        return {
          ok: false,
          errorMessage: `Codex ACP is enabled, but HAPPY_CODEX_ACP_BIN does not exist: ${envOverride}`,
        };
      }
      return { ok: true };
    }

    const status = await getCodexAcpDepStatus({ onlyIfInstalled: true });
    if (!status.installed || !status.binPath) {
      return {
        ok: false,
        errorMessage: 'Codex ACP is enabled, but codex-acp is not installed. Install it from the Happy app (Machine details → Codex ACP) or disable the experiment.',
      };
    }

    return { ok: true };
  },

  buildExtraEnvForChild: ({ experimentalCodexResume, experimentalCodexAcp }) => ({
    ...(experimentalCodexResume === true ? { HAPPY_EXPERIMENTAL_CODEX_RESUME: '1' } : {}),
    ...(experimentalCodexAcp === true ? { HAPPY_EXPERIMENTAL_CODEX_ACP: '1' } : {}),
  }),
};
