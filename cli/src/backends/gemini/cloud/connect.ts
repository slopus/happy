import type { CloudConnectTarget } from '@/cloud/connectTypes';
import { AGENTS_CORE } from '@happy/agents';
import { authenticateGemini } from './authenticate';
import { updateLocalGeminiCredentials } from './updateLocalCredentials';

export const geminiCloudConnect: CloudConnectTarget = {
  id: 'gemini',
  displayName: 'Gemini',
  vendorDisplayName: 'Google Gemini',
  vendorKey: AGENTS_CORE.gemini.cloudConnect!.vendorKey,
  status: AGENTS_CORE.gemini.cloudConnect!.status,
  authenticate: authenticateGemini,
  postConnect: updateLocalGeminiCredentials,
};
