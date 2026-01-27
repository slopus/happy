import type { CloudConnectTarget } from '@/cloud/connectTypes';
import { AGENTS_CORE } from '@happy/agents';
import { authenticateClaude } from './authenticate';

export const claudeCloudConnect: CloudConnectTarget = {
  id: 'claude',
  displayName: 'Claude',
  vendorDisplayName: 'Anthropic Claude',
  vendorKey: AGENTS_CORE.claude.cloudConnect!.vendorKey,
  status: AGENTS_CORE.claude.cloudConnect!.status,
  authenticate: authenticateClaude,
};
