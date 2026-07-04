const HAPPY_RECONNECT_ENV_PREFIX = 'HAPPY_RECONNECT_';

export const HAPPY_RECONNECT_ENV_KEYS = [
  'HAPPY_RECONNECT_SESSION_ID',
  'HAPPY_RECONNECT_ENCRYPTION_KEY',
  'HAPPY_RECONNECT_ENCRYPTION_VARIANT',
  'HAPPY_RECONNECT_SEQ',
  'HAPPY_RECONNECT_METADATA_VERSION',
  'HAPPY_RECONNECT_AGENT_STATE_VERSION',
] as const;

export function createHappyChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const childEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || key.startsWith(HAPPY_RECONNECT_ENV_PREFIX)) {
      continue;
    }
    childEnv[key] = value;
  }

  return childEnv;
}

export function createHappyTmuxChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const childEnv = createHappyChildEnv(baseEnv);

  for (const key of HAPPY_RECONNECT_ENV_KEYS) {
    childEnv[key] = '';
  }

  return childEnv;
}
