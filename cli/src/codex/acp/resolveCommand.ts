import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { configuration } from '@/configuration';

/**
 * Resolve the Codex ACP binary.
 *
 * Codex ACP is provided by the optional `codex-acp` capability install.
 */
export function resolveCodexAcpCommand(): string {
  const envOverride = typeof process.env.HAPPY_CODEX_ACP_BIN === 'string'
    ? process.env.HAPPY_CODEX_ACP_BIN.trim()
    : '';
  if (envOverride) {
    if (!existsSync(envOverride)) {
      throw new Error(`Codex ACP is enabled but HAPPY_CODEX_ACP_BIN does not exist: ${envOverride}`);
    }
    return envOverride;
  }

  const binName = process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp';
  const defaultPath = join(configuration.happyHomeDir, 'tools', 'codex-acp', 'node_modules', '.bin', binName);
  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  // Last-resort: rely on PATH (useful for local installs while developing).
  return 'codex-acp';
}

