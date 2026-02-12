import axios, { AxiosError } from 'axios';
import tweetnacl from 'tweetnacl';
import qrcode from 'qrcode-terminal';
import { encodeBase64, encodeBase64Url, decodeBase64, decryptBoxBundle, getRandomBytes } from './encryption';
import { writeCredentials, clearCredentials, readCredentials } from './credentials';
import type { Config } from './config';

const POLL_INTERVAL_MS = 1000;
const AUTH_TIMEOUT_MS = 120_000; // 2 minutes

export type AuthRequestResponse = {
    state: 'requested' | 'authorized';
    token?: string;
    response?: string; // base64-encoded encrypted account secret
};

export async function authLogin(config: Config): Promise<void> {
    // 1. Generate ephemeral box keypair
    const seed = getRandomBytes(32);
    const keypair = tweetnacl.box.keyPair.fromSecretKey(seed);

    // 2. POST /v1/auth/account/request with publicKey
    const publicKeyBase64 = encodeBase64(keypair.publicKey);
    try {
        await axios.post(`${config.serverUrl}/v1/auth/account/request`, {
            publicKey: publicKeyBase64,
        });
    } catch (err) {
        if (err instanceof AxiosError) {
            throw new Error(`Failed to initiate auth: ${err.message}`);
        }
        throw err;
    }

    // 3. Generate and display QR code
    const qrData = `happy:///account?${encodeBase64Url(keypair.publicKey)}`;
    console.log('');
    qrcode.generate(qrData, { small: true }, (code: string) => {
        console.log(code);
    });
    console.log('## Authentication');
    console.log('- Action: Scan this QR code with the Happy app');
    console.log('- Path: Settings -> Account -> Link New Device');
    console.log('');

    // 4. Poll until authorized or timeout
    const startTime = Date.now();
    while (Date.now() - startTime < AUTH_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);

        let result: AuthRequestResponse;
        try {
            const resp = await axios.post(`${config.serverUrl}/v1/auth/account/request`, {
                publicKey: publicKeyBase64,
            });
            result = resp.data as AuthRequestResponse;
        } catch (err) {
            if (err instanceof AxiosError) {
                throw new Error(`Auth polling failed: ${err.message}`);
            }
            throw err;
        }

        if (result.state === 'authorized' && result.token && result.response) {
            // 5. Decrypt the response to get account secret
            const encryptedResponse = decodeBase64(result.response);
            const secret = decryptBoxBundle(encryptedResponse, keypair.secretKey);
            if (!secret) {
                throw new Error('Failed to decrypt auth response');
            }

            // 6. Save credentials
            writeCredentials(config, result.token, secret);

            console.log('## Authentication');
            console.log('- Status: Authenticated');
            return;
        }
    }

    throw new Error('Authentication timed out. Please try again.');
}

export async function authLogout(config: Config): Promise<void> {
    clearCredentials(config);
    console.log('## Authentication');
    console.log('- Status: Logged out');
    console.log('- Credentials: Cleared');
}

export async function authStatus(config: Config): Promise<void> {
    const creds = readCredentials(config);
    console.log('## Authentication');
    if (creds) {
        console.log('- Status: Authenticated');
        console.log(`- Public Key: \`${encodeBase64(creds.contentKeyPair.publicKey)}\``);
    } else {
        console.log('- Status: Not authenticated');
        console.log('- Action: Run `happy-agent auth login` to authenticate.');
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
