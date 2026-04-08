import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveContentKeyPair, encodeBase64, getRandomBytes } from 'happy-agent/encryption';
import { afterEach, describe, expect, it } from 'vitest';

import { loadCredentials, parseCredentials } from '../credentials';

describe('loadCredentials', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('loads legacy happy-cli credentials from ~/.happy/access.key and derives the content key pair', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'pi-happy-creds-legacy-'));
    tempDirs.push(happyHomeDir);

    const secret = getRandomBytes(32);
    const expectedKeyPair = deriveContentKeyPair(secret);

    writeFileSync(join(happyHomeDir, 'access.key'), JSON.stringify({
      token: 'legacy-token',
      secret: encodeBase64(secret),
    }));

    const credentials = await loadCredentials(happyHomeDir);

    expect(credentials).not.toBeNull();
    expect(credentials?.token).toBe('legacy-token');
    expect(credentials?.encryption).toMatchObject({
      type: 'legacy',
      secret,
    });
    expect(credentials?.contentKeyPair).toEqual(expectedKeyPair);
  });

  it('loads data-key happy-cli credentials from ~/.happy/access.key', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'pi-happy-creds-datakey-'));
    tempDirs.push(happyHomeDir);

    const publicKey = getRandomBytes(32);
    const machineKey = getRandomBytes(32);

    writeFileSync(join(happyHomeDir, 'access.key'), JSON.stringify({
      token: 'data-key-token',
      encryption: {
        publicKey: encodeBase64(publicKey),
        machineKey: encodeBase64(machineKey),
      },
    }));

    const credentials = await loadCredentials(happyHomeDir);

    expect(credentials).not.toBeNull();
    expect(credentials?.token).toBe('data-key-token');
    expect(credentials?.encryption).toMatchObject({
      type: 'dataKey',
      publicKey,
      machineKey,
    });
    expect(credentials?.contentKeyPair).toBeUndefined();
  });

  it('returns null when access.key does not exist', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'pi-happy-creds-missing-'));
    tempDirs.push(happyHomeDir);

    await expect(loadCredentials(happyHomeDir)).resolves.toBeNull();
  });

  it('returns null when access.key contains malformed json', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'pi-happy-creds-malformed-'));
    tempDirs.push(happyHomeDir);

    writeFileSync(join(happyHomeDir, 'access.key'), '{not-json');

    await expect(loadCredentials(happyHomeDir)).resolves.toBeNull();
  });

  it('returns null when credentials do not contain a supported encryption shape', () => {
    expect(parseCredentials(JSON.stringify({ token: 'token-without-secret' }))).toBeNull();
    expect(parseCredentials(JSON.stringify({ token: '', secret: 'abc' }))).toBeNull();
  });

  it('returns null when the legacy secret is not valid base64', () => {
    expect(parseCredentials(JSON.stringify({
      token: 'bad-secret',
      secret: '!!!',
    }))).toBeNull();
  });

  it('supports nested happy home directories', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'pi-happy-creds-nested-'));
    tempDirs.push(rootDir);

    const happyHomeDir = join(rootDir, '.happy');
    mkdirSync(happyHomeDir, { recursive: true });
    const secret = getRandomBytes(32);

    writeFileSync(join(happyHomeDir, 'access.key'), JSON.stringify({
      token: 'nested-token',
      secret: encodeBase64(secret),
    }));

    const credentials = await loadCredentials(happyHomeDir);

    expect(credentials?.token).toBe('nested-token');
    expect(credentials?.encryption).toMatchObject({
      type: 'legacy',
      secret,
    });
  });
});
