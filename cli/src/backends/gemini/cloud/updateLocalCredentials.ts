import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type GeminiOAuthTokens = Readonly<{
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function updateLocalGeminiCredentials(oauth: unknown): void {
  if (!isRecord(oauth) || typeof oauth.access_token !== 'string') {
    return;
  }

  const tokens = oauth as GeminiOAuthTokens;

  try {
    const geminiDir = join(homedir(), '.gemini');
    const credentialsPath = join(geminiDir, 'oauth_creds.json');

    if (!existsSync(geminiDir)) {
      mkdirSync(geminiDir, { recursive: true });
    }

    const credentials = {
      access_token: tokens.access_token,
      token_type: tokens.token_type || 'Bearer',
      scope: tokens.scope || 'https://www.googleapis.com/auth/cloud-platform',
      ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
      ...(tokens.id_token && { id_token: tokens.id_token }),
      ...(tokens.expires_in && { expires_in: tokens.expires_in }),
    };

    writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), 'utf-8');
    console.log(chalk.gray(`  Updated local credentials: ${credentialsPath}`));
  } catch (error) {
    console.log(chalk.yellow(`  ⚠️ Could not update local credentials: ${error}`));
  }
}

