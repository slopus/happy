import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeBase64, deriveContentKeyPair } from 'happy-agent/encryption';
import { z } from 'zod';

const credentialSchema = z.object({
  token: z.string().min(1),
  secret: z.string().base64().nullish(),
  encryption: z.object({
    publicKey: z.string().base64(),
    machineKey: z.string().base64(),
  }).nullish(),
}).refine((value) => Boolean(value.secret || value.encryption), {
  message: 'Credentials must contain either a legacy secret or data-key encryption block.',
});

export type PiHappyLegacyCredentials = {
  token: string;
  encryption: {
    type: 'legacy';
    secret: Uint8Array;
  };
  contentKeyPair: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
};

export type PiHappyDataKeyCredentials = {
  token: string;
  encryption: {
    type: 'dataKey';
    publicKey: Uint8Array;
    machineKey: Uint8Array;
  };
  contentKeyPair?: undefined;
};

export type PiHappyCredentials = PiHappyLegacyCredentials | PiHappyDataKeyCredentials;

export function parseCredentials(raw: string): PiHappyCredentials | null {
  try {
    const parsed = credentialSchema.parse(JSON.parse(raw));

    if (parsed.secret) {
      const secret = decodeBase64(parsed.secret);
      return {
        token: parsed.token,
        encryption: {
          type: 'legacy',
          secret,
        },
        contentKeyPair: deriveContentKeyPair(secret),
      };
    }

    if (parsed.encryption) {
      return {
        token: parsed.token,
        encryption: {
          type: 'dataKey',
          publicKey: decodeBase64(parsed.encryption.publicKey),
          machineKey: decodeBase64(parsed.encryption.machineKey),
        },
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function loadCredentialsFromFile(filePath: string): Promise<PiHappyCredentials | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return parseCredentials(raw);
  } catch {
    return null;
  }
}

export async function loadCredentials(happyHomeDir: string): Promise<PiHappyCredentials | null> {
  return loadCredentialsFromFile(join(happyHomeDir, 'access.key'));
}

// Backwards-compatible aliases for the package bootstrap work already landed in Task 2.
export const parseHappyCliCredentials = parseCredentials;
export const loadHappyCliCredentials = loadCredentialsFromFile;
