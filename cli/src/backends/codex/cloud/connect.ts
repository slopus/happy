import type { CloudConnectTarget } from '@/cloud/connectTypes';
import { AGENTS_CORE } from '@happy/agents';
import { authenticateCodex } from './authenticate';

export const codexCloudConnect: CloudConnectTarget = {
  id: 'codex',
  displayName: 'Codex',
  vendorDisplayName: 'OpenAI Codex',
  vendorKey: AGENTS_CORE.codex.cloudConnect!.vendorKey,
  status: AGENTS_CORE.codex.cloudConnect!.status,
  authenticate: authenticateCodex,
};
