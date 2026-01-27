import type { CloudConnectTarget } from '@/cloud/connect/types';
import { authenticateClaude } from './authenticate';

export const claudeCloudConnect: CloudConnectTarget = {
  id: 'claude',
  displayName: 'Claude',
  vendorDisplayName: 'Anthropic Claude',
  vendorKey: 'anthropic',
  status: 'experimental',
  authenticate: authenticateClaude,
};
