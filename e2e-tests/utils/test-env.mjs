/**
 * Test Environment Manager
 *
 * Spins up a complete test environment with isolated ports
 * for running E2E tests in parallel.
 */

import { spawn, exec } from 'child_process';
import { mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { allocateTestPorts } from './ports.mjs';
import { promisify } from 'util';
import { randomUUID, createHmac } from 'crypto';
import axios from 'axios';
import tweetnacl from 'tweetnacl';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');

/**
 * Wait for a URL to become responsive
 */
async function waitForUrl(url, maxAttempts = 60, delayMs = 1000) {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            await axios.get(url, { timeout: 1000 });
            return true;
        } catch {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    return false;
}

/**
 * Helper functions for auth
 */
function encodeBase64(data) {
    return Buffer.from(data).toString('base64');
}

function decodeBase64(str) {
    return new Uint8Array(Buffer.from(str, 'base64'));
}

function hmac_sha512(key, data) {
    const hmac = createHmac('sha512', Buffer.from(key));
    hmac.update(Buffer.from(data));
    return new Uint8Array(hmac.digest());
}

function deriveSecretKeyTreeRoot(seed, usage) {
    const I = hmac_sha512(
        new TextEncoder().encode(usage + ' Master Seed'),
        seed
    );
    return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function deriveSecretKeyTreeChild(chainCode, index) {
    const data = new Uint8Array([0x00, ...new TextEncoder().encode(index)]);
    const I = hmac_sha512(chainCode, data);
    return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function deriveKey(master, usage, path) {
    let state = deriveSecretKeyTreeRoot(master, usage);
    for (const index of path) {
        state = deriveSecretKeyTreeChild(state.chainCode, index);
    }
    return state.key;
}

function deriveContentEncryptionPublicKey(accountSecretKey) {
    const seed = accountSecretKey.slice(0, 32);
    return deriveKey(seed, 'Happy EnCoder', ['content']);
}

function bytesToBase32(bytes) {
    const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let result = '';
    let buffer = 0;
    let bufferLength = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bufferLength += 8;
        while (bufferLength >= 5) {
            bufferLength -= 5;
            result += base32Alphabet[(buffer >> bufferLength) & 0x1f];
        }
    }
    if (bufferLength > 0) {
        result += base32Alphabet[(buffer << (5 - bufferLength)) & 0x1f];
    }
    return result;
}

function formatSecretKeyForBackup(secretKeyBase64url) {
    const bytes = Buffer.from(secretKeyBase64url, 'base64url');
    const base32 = bytesToBase32(bytes);
    const groups = [];
    for (let i = 0; i < base32.length; i += 5) {
        groups.push(base32.slice(i, i + 5));
    }
    return groups.join('-');
}

export class TestEnvironment {
    constructor() {
        this.ports = null;
        this.processes = [];
        this.homeDir = null;
        this.credentials = null;
        this.webSecretKey = null;
    }

    async setup() {
        console.log('🔧 Setting up test environment...');

        // Allocate random ports
        this.ports = await allocateTestPorts();
        console.log(`  Server port: ${this.ports.serverPort}`);
        console.log(`  Webapp port: ${this.ports.webappPort}`);
        console.log(`  MinIO port: ${this.ports.minioPort}`);

        // Create isolated home directory
        this.homeDir = `/tmp/happy-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await mkdir(this.homeDir, { recursive: true });
        console.log(`  Home dir: ${this.homeDir}`);

        // Start services
        await this.startMinIO();
        await this.startServer();

        // Setup auth credentials
        await this.setupCredentials();

        console.log('✅ Test environment ready');

        return {
            ports: this.ports,
            homeDir: this.homeDir,
            serverUrl: `http://localhost:${this.ports.serverPort}`,
            webappUrl: `http://localhost:${this.ports.webappPort}`,
            credentials: this.credentials,
            webSecretKey: this.webSecretKey
        };
    }

    async startMinIO() {
        console.log('  Starting MinIO...');
        const minioDataDir = join(this.homeDir, 'minio-data');
        await mkdir(minioDataDir, { recursive: true });

        const proc = spawn('minio', [
            'server',
            minioDataDir,
            '--address', `:${this.ports.minioPort}`,
            '--console-address', `:${this.ports.minioConsolePort}`
        ], {
            env: {
                ...process.env,
                MINIO_ROOT_USER: 'minioadmin',
                MINIO_ROOT_PASSWORD: 'minioadmin'
            },
            stdio: 'pipe'
        });

        this.processes.push(proc);

        // Wait for MinIO to be ready
        const ready = await waitForUrl(`http://localhost:${this.ports.minioPort}/minio/health/live`, 30, 500);
        if (!ready) {
            throw new Error('MinIO failed to start');
        }
        console.log('  ✓ MinIO ready');
    }

    async startServer() {
        console.log('  Starting happy-server...');

        const serverDir = join(ROOT_DIR, 'happy-server');

        // Create .env file for this test instance
        const envContent = `
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/handy
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:${this.ports.minioPort}
S3_BUCKET=happy-test-${Date.now()}
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_REGION=us-east-1
PORT=${this.ports.serverPort}
NODE_ENV=test
`;
        const envFile = join(this.homeDir, 'server.env');
        await writeFile(envFile, envContent);

        // Build and start server
        const proc = spawn('yarn', ['start'], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT: String(this.ports.serverPort),
                DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/handy',
                REDIS_URL: 'redis://localhost:6379',
                S3_ENDPOINT: `http://localhost:${this.ports.minioPort}`,
                S3_BUCKET: `happy-test-${Date.now()}`,
                S3_ACCESS_KEY: 'minioadmin',
                S3_SECRET_KEY: 'minioadmin',
                S3_REGION: 'us-east-1',
                NODE_ENV: 'test'
            },
            stdio: 'pipe'
        });

        this.processes.push(proc);

        // Wait for server to be ready
        const ready = await waitForUrl(`http://localhost:${this.ports.serverPort}/health`, 60, 1000);
        if (!ready) {
            throw new Error('Server failed to start');
        }
        console.log('  ✓ Server ready');
    }

    async setupCredentials() {
        console.log('  Setting up test credentials...');
        const serverUrl = `http://localhost:${this.ports.serverPort}`;

        // Create test account
        const accountKeypair = tweetnacl.sign.keyPair();
        const challenge = tweetnacl.randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, accountKeypair.secretKey);

        const authResponse = await axios.post(`${serverUrl}/v1/auth`, {
            publicKey: encodeBase64(accountKeypair.publicKey),
            challenge: encodeBase64(challenge),
            signature: encodeBase64(signature)
        });

        const accountToken = authResponse.data.token;

        // Create CLI auth request
        const cliSecret = tweetnacl.randomBytes(32);
        const cliKeypair = tweetnacl.box.keyPair.fromSecretKey(cliSecret);

        await axios.post(`${serverUrl}/v1/auth/request`, {
            publicKey: encodeBase64(cliKeypair.publicKey),
            supportsV2: true
        });

        // Approve the auth request
        const ephemeralKeypair = tweetnacl.box.keyPair();
        const contentEncryptionPublicKey = deriveContentEncryptionPublicKey(accountKeypair.secretKey);

        const responseData = new Uint8Array(33);
        responseData[0] = 0x00;
        responseData.set(contentEncryptionPublicKey, 1);

        const nonce = tweetnacl.randomBytes(24);
        const encrypted = tweetnacl.box(
            responseData,
            nonce,
            cliKeypair.publicKey,
            ephemeralKeypair.secretKey
        );

        const bundle = new Uint8Array(32 + 24 + encrypted.length);
        bundle.set(ephemeralKeypair.publicKey, 0);
        bundle.set(nonce, 32);
        bundle.set(encrypted, 32 + 24);

        await axios.post(
            `${serverUrl}/v1/auth/response`,
            {
                publicKey: encodeBase64(cliKeypair.publicKey),
                response: encodeBase64(bundle)
            },
            { headers: { 'Authorization': `Bearer ${accountToken}` } }
        );

        // Fetch approved credentials
        const credsResponse = await axios.post(`${serverUrl}/v1/auth/request`, {
            publicKey: encodeBase64(cliKeypair.publicKey),
            supportsV2: true
        });

        const encryptedBundle = decodeBase64(credsResponse.data.response);
        const ephemeralPubKey = encryptedBundle.slice(0, 32);
        const credsNonce = encryptedBundle.slice(32, 56);
        const credsEncrypted = encryptedBundle.slice(56);

        const decrypted = tweetnacl.box.open(
            credsEncrypted,
            credsNonce,
            ephemeralPubKey,
            cliKeypair.secretKey
        );

        const publicKey = decrypted.slice(1, 33);
        const machineKey = tweetnacl.randomBytes(32);

        this.credentials = {
            type: 'dataKey',
            encryption: {
                publicKey: encodeBase64(publicKey),
                machineKey: encodeBase64(machineKey)
            },
            token: credsResponse.data.token
        };

        // Write credentials to home dir
        await writeFile(join(this.homeDir, 'access.key'), JSON.stringify(this.credentials, null, 2));
        await writeFile(join(this.homeDir, 'settings.json'), JSON.stringify({
            onboardingCompleted: true,
            machineId: randomUUID()
        }, null, 2));

        // Generate web secret key for browser auth
        const secretSeed = accountKeypair.secretKey.slice(0, 32);
        const secretKeyBase64url = Buffer.from(secretSeed).toString('base64url');
        this.webSecretKey = formatSecretKeyForBackup(secretKeyBase64url);

        console.log('  ✓ Credentials ready');
    }

    async teardown() {
        console.log('🧹 Cleaning up test environment...');

        // Kill all processes
        for (const proc of this.processes) {
            try {
                proc.kill('SIGTERM');
            } catch {}
        }

        // Wait a bit for processes to terminate
        await new Promise(r => setTimeout(r, 1000));

        // Force kill if needed
        for (const proc of this.processes) {
            try {
                proc.kill('SIGKILL');
            } catch {}
        }

        // Clean up home dir
        if (this.homeDir && existsSync(this.homeDir)) {
            try {
                await rm(this.homeDir, { recursive: true, force: true });
            } catch {}
        }

        console.log('✅ Cleanup complete');
    }
}

// Allow running standalone for testing
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const env = new TestEnvironment();
    try {
        const config = await env.setup();
        console.log('\nTest environment configuration:');
        console.log(JSON.stringify(config, null, 2));
        console.log('\nPress Ctrl+C to stop...');

        // Keep running until interrupted
        await new Promise(() => {});
    } catch (error) {
        console.error('Setup failed:', error);
        await env.teardown();
        process.exit(1);
    }
}
