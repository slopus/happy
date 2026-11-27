/**
 * Fetch available models from the Claude-compatible API gateway.
 *
 * Reads ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the environment
 * and fetches the /v1/models listing so the Happy app can display
 * all gateway models — including provider models, 1M-context variants,
 * and discoverable models — alongside standard Claude aliases.
 *
 * Falls back to hardcoded defaults on any error.
 */

import axios from 'axios';

const HARDCODED_CLAUDE_MODELS: Array<{
  code: string;
  value: string;
  description: string | null;
}> = [
  { code: 'default', value: 'default model', description: null },
  { code: 'opus', value: 'opus 4.7', description: null },
  { code: 'sonnet', value: 'sonnet 4.6', description: null },
  { code: 'haiku', value: 'haiku 4.5', description: null },
];

interface GatewayModel {
  id: string;
  display_name: string;
  created_at: string;
}

export async function fetchAvailableModels(): Promise<
  Array<{ code: string; value: string; description: string | null }> | null
> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl) return null;

  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (!authToken) return null;

  try {
    const response = await axios.get<{ data: GatewayModel[] }>(
      `${baseUrl.replace(/\/+$/, '')}/v1/models`,
      {
        headers: { 'x-api-key': authToken },
        timeout: 10_000,
        validateStatus: (status) => status < 500,
      },
    );

    if (response.status !== 200 || !Array.isArray(response.data?.data)) {
      return null;
    }

    const gatewayModels = response.data.data.map((m) => ({
      code: m.id,
      value: m.display_name,
      description: null as string | null,
    }));

    const seen = new Set(HARDCODED_CLAUDE_MODELS.map((m) => m.code));
    const deduped = gatewayModels.filter((m) => !seen.has(m.code));

    return [...HARDCODED_CLAUDE_MODELS, ...deduped];
  } catch {
    return null;
  }
}

export function getHardcodedModels(): Array<{
  code: string;
  value: string;
  description: string | null;
}> {
  return HARDCODED_CLAUDE_MODELS;
}
