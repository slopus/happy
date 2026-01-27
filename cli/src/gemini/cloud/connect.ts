import type { CloudConnectTarget } from '@/cloud/connect/types';
import { authenticateGemini } from './authenticate';
import { updateLocalGeminiCredentials } from './updateLocalCredentials';

export const geminiCloudConnect: CloudConnectTarget = {
  id: 'gemini',
  displayName: 'Gemini',
  vendorDisplayName: 'Google Gemini',
  vendorKey: 'gemini',
  authenticate: authenticateGemini,
  postConnect: updateLocalGeminiCredentials,
};

