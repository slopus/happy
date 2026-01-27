import type { CloudConnectTarget } from '@/cloud/connect/types';
import { authenticateCodex } from './authenticate';

export const codexCloudConnect: CloudConnectTarget = {
  id: 'codex',
  displayName: 'Codex',
  vendorDisplayName: 'OpenAI Codex',
  vendorKey: 'openai',
  authenticate: authenticateCodex,
};

