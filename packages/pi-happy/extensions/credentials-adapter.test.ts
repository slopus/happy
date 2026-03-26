import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { deriveContentKeyPair, encodeBase64, getRandomBytes } from 'happy-agent/encryption';

import { loadHappyCliCredentials, parseHappyCliCredentials } from './credentials-adapter';

describe('credentials adapter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('parses legacy happy-cli credentials and derives the content key pair', () => {
    const secret = getRandomBytes(32);
    const expectedKeyPair = deriveContentKeyPair(secret);

    const credentials = parseHappyCliCredentials(JSON.stringify({
      token: 'token-123',
      secret: encodeBase64(secret),
    }));

    expect(credentials).not.toBeNull();
    expect(credentials?.token).toBe('token-123');
    expect(credentials?.encryption).toMatchObject({ type: 'legacy', secret });
    expect(credentials?.contentKeyPair?.publicKey).toEqual(expectedKeyPair.publicKey);
    expect(credentials?.contentKeyPair?.secretKey).toEqual(expectedKeyPair.secretKey);
  });

  it('parses data-key happy-cli credentials', () => {
    const publicKey = getRandomBytes(32);
    const machineKey = getRandomBytes(32);

    const credentials = parseHappyCliCredentials(JSON.stringify({
      token: 'token-456',
      encryption: {
        publicKey: encodeBase64(publicKey),
        machineKey: encodeBase64(machineKey),
      },
    }));

    expect(credentials).not.toBeNull();
    expect(credentials?.token).toBe('token-456');
    expect(credentials?.encryption).toMatchObject({
      type: 'dataKey',
      publicKey,
      machineKey,
    });
    expect(credentials?.contentKeyPair).toBeUndefined();
  });

  it('returns null for malformed credentials', () => {
    expect(parseHappyCliCredentials('{not-json')).toBeNull();
    expect(parseHappyCliCredentials(JSON.stringify({ token: '', secret: 'bad' }))).toBeNull();
    expect(parseHappyCliCredentials(JSON.stringify({ token: 'ok' }))).toBeNull();
  });

  it('loads credentials from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-happy-creds-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'access.key');
    const secret = getRandomBytes(32);

    writeFileSync(filePath, JSON.stringify({
      token: 'token-on-disk',
      secret: encodeBase64(secret),
    }));

    const credentials = await loadHappyCliCredentials(filePath);

    expect(credentials).not.toBeNull();
    expect(credentials?.token).toBe('token-on-disk');
    expect(credentials?.encryption).toMatchObject({ type: 'legacy', secret });
  });

  it('returns null when the credentials file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-happy-creds-missing-'));
    tempDirs.push(dir);

    await expect(loadHappyCliCredentials(join(dir, 'missing.key'))).resolves.toBeNull();
  });
});
