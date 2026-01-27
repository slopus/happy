/**
 * Test script to verify Clawdbot device auth implementation
 * Run with: npx tsx sources/trash/test-clawdbot-auth.ts
 */

import WebSocket from 'ws';

// Base64URL encoding/decoding (same as our implementation)
function base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Uint8Array {
    const normalized = input.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', publicKey);
    return bytesToHex(new Uint8Array(hash));
}

// Use @noble/ed25519 like the official UI
async function testWithNoble() {
    const { getPublicKeyAsync, signAsync, utils } = await import('@noble/ed25519');

    // Generate identity (same as official UI)
    const privateKey = utils.randomSecretKey();
    const publicKey = await getPublicKeyAsync(privateKey);
    const deviceId = await fingerprintPublicKey(publicKey);

    console.log('Device ID:', deviceId.slice(0, 16) + '...');
    console.log('Public key (base64url):', base64UrlEncode(publicKey));
    console.log('Private key length:', privateKey.length, 'bytes');

    // Build payload
    const signedAtMs = Date.now();
    const token = 'df0a80a5ce3933ba8ce96963d06b302559ef46bea2119788'; // From clawdbot dashboard
    const payload = [
        'v1',
        deviceId,
        'webchat-ui',
        'ui',
        'operator',
        'operator.admin,operator.approvals,operator.pairing',
        String(signedAtMs),
        token,
    ].join('|');

    console.log('Payload:', payload.slice(0, 100) + '...');

    // Sign with noble
    const data = new TextEncoder().encode(payload);
    const sig = await signAsync(data, privateKey);
    const signatureBase64Url = base64UrlEncode(sig);

    console.log('Signature length:', sig.length, 'bytes');
    console.log('Signature (base64url):', signatureBase64Url.slice(0, 32) + '...');

    // Test connection
    const ws = new WebSocket('ws://127.0.0.1:18789');

    ws.on('open', () => {
        console.log('\nWebSocket opened, waiting for challenge...');
    });

    let connectSent = false;

    ws.on('message', async (data) => {
        const msg = JSON.parse(data.toString());
        console.log('Received:', msg.type, msg.event || msg.method || '');

        if (msg.type === 'event' && msg.event === 'connect.challenge') {
            const nonce = msg.payload?.nonce;
            console.log('Got nonce:', nonce);

            if (!connectSent) {
                connectSent = true;

                // Rebuild payload with nonce for v2
                const payloadV2 = [
                    'v2',
                    deviceId,
                    'webchat-ui',
                    'ui',
                    'operator',
                    'operator.admin,operator.approvals,operator.pairing',
                    String(signedAtMs),
                    token,
                    nonce,
                ].join('|');

                const dataV2 = new TextEncoder().encode(payloadV2);
                const sigV2 = await signAsync(dataV2, privateKey);
                const signatureV2 = base64UrlEncode(sigV2);

                const connectParams = {
                    minProtocol: 3,
                    maxProtocol: 3,
                    client: {
                        id: 'webchat-ui',
                        displayName: 'Happy Test',
                        version: '1.0.0',
                        platform: 'test',
                        mode: 'ui',
                    },
                    role: 'operator',
                    scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
                    device: {
                        id: deviceId,
                        publicKey: base64UrlEncode(publicKey),
                        signature: signatureV2,
                        signedAt: signedAtMs,
                        nonce,
                    },
                    auth: { token },
                };

                console.log('\nSending connect request...');
                ws.send(JSON.stringify({
                    type: 'req',
                    id: 'connect-1',
                    method: 'connect',
                    params: connectParams,
                }));
            }
        }

        if (msg.type === 'res' && msg.id === 'connect-1') {
            if (msg.ok) {
                console.log('\n✅ CONNECTION SUCCESSFUL!');
                console.log('Auth:', msg.payload?.auth);
            } else {
                console.log('\n❌ CONNECTION FAILED:', msg.error?.message);
            }
            ws.close();
            process.exit(msg.ok ? 0 : 1);
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
        process.exit(1);
    });

    ws.on('close', () => {
        console.log('WebSocket closed');
    });
}

testWithNoble().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
