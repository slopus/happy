import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCredentials, writeCredentials, clearCredentials, requireCredentials } from './credentials';
import { getRandomBytes, deriveContentKeyPair, encodeBase64 } from './encryption';
import type { Config } from './config';

function makeTestConfig(): Config {
    const homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-test-'));
    return {
        serverUrl: 'https://api.cluster-fluster.com',
        homeDir,
        credentialPath: join(homeDir, 'agent.key'),
    };
}

describe('credentials', () => {
    let config: Config;

    beforeEach(() => {
        config = makeTestConfig();
    });

    afterEach(() => {
        rmSync(config.homeDir, { recursive: true, force: true });
    });

    describe('readCredentials / writeCredentials round-trip', () => {
        it('writes and reads back credentials', () => {
            const token = 'test-jwt-token';
            const secret = getRandomBytes(32);

            writeCredentials(config, token, secret);
            const creds = readCredentials(config);

            expect(creds).not.toBeNull();
            expect(creds!.token).toBe(token);
            expect(creds!.secret).toEqual(secret);
        });

        it('derives contentKeyPair correctly on read', () => {
            const token = 'test-token';
            const secret = getRandomBytes(32);
            const expectedKeyPair = deriveContentKeyPair(secret);

            writeCredentials(config, token, secret);
            const creds = readCredentials(config);

            expect(creds!.contentKeyPair.publicKey).toEqual(expectedKeyPair.publicKey);
            expect(creds!.contentKeyPair.secretKey).toEqual(expectedKeyPair.secretKey);
        });

        it('stores secret as base64 in the file', () => {
            const token = 'test-token';
            const secret = getRandomBytes(32);

            writeCredentials(config, token, secret);
            const raw = JSON.parse(readFileSync(config.credentialPath, 'utf-8'));

            expect(raw.token).toBe(token);
            expect(raw.secret).toBe(encodeBase64(secret));
        });

        it('creates parent directory if missing', () => {
            const deepConfig: Config = {
                ...config,
                credentialPath: join(config.homeDir, 'nested', 'dir', 'agent.key'),
            };

            writeCredentials(deepConfig, 'token', getRandomBytes(32));
            expect(existsSync(deepConfig.credentialPath)).toBe(true);
        });
    });

    describe('readCredentials with missing file', () => {
        it('returns null when credential file does not exist', () => {
            const creds = readCredentials(config);
            expect(creds).toBeNull();
        });
    });

    describe('clearCredentials', () => {
        it('removes the credential file', () => {
            writeCredentials(config, 'token', getRandomBytes(32));
            expect(existsSync(config.credentialPath)).toBe(true);

            clearCredentials(config);
            expect(existsSync(config.credentialPath)).toBe(false);
        });

        it('does not throw when file does not exist', () => {
            expect(() => clearCredentials(config)).not.toThrow();
        });
    });

    describe('requireCredentials', () => {
        it('returns credentials when file exists', () => {
            const token = 'test-token';
            const secret = getRandomBytes(32);
            writeCredentials(config, token, secret);

            const creds = requireCredentials(config);
            expect(creds.token).toBe(token);
            expect(creds.secret).toEqual(secret);
        });

        it('throws when credentials are missing', () => {
            expect(() => requireCredentials(config)).toThrow(
                'Not authenticated. Run `happy-agent auth login` first.'
            );
        });
    });

    describe('contentKeyPair derivation from secret', () => {
        it('produces 32-byte public and secret keys', () => {
            const secret = getRandomBytes(32);
            writeCredentials(config, 'token', secret);
            const creds = readCredentials(config);

            expect(creds!.contentKeyPair.publicKey.length).toBe(32);
            expect(creds!.contentKeyPair.secretKey.length).toBe(32);
        });

        it('is deterministic — same secret produces same keypair', () => {
            const secret = getRandomBytes(32);

            writeCredentials(config, 'token1', secret);
            const creds1 = readCredentials(config);

            writeCredentials(config, 'token2', secret);
            const creds2 = readCredentials(config);

            expect(creds1!.contentKeyPair.publicKey).toEqual(creds2!.contentKeyPair.publicKey);
            expect(creds1!.contentKeyPair.secretKey).toEqual(creds2!.contentKeyPair.secretKey);
        });

        it('different secrets produce different keypairs', () => {
            const secret1 = getRandomBytes(32);
            const secret2 = getRandomBytes(32);

            writeCredentials(config, 'token', secret1);
            const creds1 = readCredentials(config);

            writeCredentials(config, 'token', secret2);
            const creds2 = readCredentials(config);

            expect(creds1!.contentKeyPair.publicKey).not.toEqual(creds2!.contentKeyPair.publicKey);
        });
    });
});
