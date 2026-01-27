/**
 * Clawdbot Device Identity
 *
 * Manages device identity for secure gateway authentication.
 * Uses Ed25519 for signing, matching the official Clawdbot UI implementation.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';

const DEVICE_IDENTITY_KEY = 'clawdbot-device-identity-v1';
const DEVICE_AUTH_TOKEN_KEY = 'clawdbot_device_auth_token';

export interface DeviceIdentity {
    deviceId: string;
    publicKey: string; // base64url encoded
    privateKey: string; // base64url encoded (32-byte seed)
}

interface StoredDeviceIdentity {
    version: 1;
    deviceId: string;
    publicKey: string;
    privateKey: string;
    createdAtMs: number;
}

interface StoredDeviceAuthToken {
    token: string;
    role: string;
    scopes: string[];
    createdAtMs: number;
}

// In-memory cache
let identityCache: DeviceIdentity | null = null;
let authTokenCache: StoredDeviceAuthToken | null = null;

// Base64URL encoding/decoding (matching official implementation)
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

// Storage helpers (web uses localStorage, native uses SecureStore)
async function getStorageItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
        return localStorage.getItem(key);
    }
    return SecureStore.getItemAsync(key);
}

async function setStorageItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
        localStorage.setItem(key, value);
        return;
    }
    await SecureStore.setItemAsync(key, value);
}

async function deleteStorageItem(key: string): Promise<void> {
    if (Platform.OS === 'web') {
        localStorage.removeItem(key);
        return;
    }
    await SecureStore.deleteItemAsync(key);
}

/**
 * Derive device ID from public key (SHA-256 hash, hex encoded)
 */
async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', publicKey.buffer as ArrayBuffer);
    return bytesToHex(new Uint8Array(hash));
}

/**
 * Generate a new device identity (Ed25519 key pair using @noble/ed25519)
 */
async function generateDeviceIdentity(): Promise<DeviceIdentity> {
    const privateKey = utils.randomSecretKey(); // 32-byte seed
    const publicKey = await getPublicKeyAsync(privateKey);
    const deviceId = await fingerprintPublicKey(publicKey);
    return {
        deviceId,
        publicKey: base64UrlEncode(publicKey),
        privateKey: base64UrlEncode(privateKey),
    };
}

/**
 * Load or create device identity
 */
export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
    // Return cached if available
    if (identityCache) {
        return identityCache;
    }

    // Try to load from storage
    const stored = await getStorageItem(DEVICE_IDENTITY_KEY);
    if (stored) {
        try {
            const parsed = JSON.parse(stored) as StoredDeviceIdentity;
            if (
                parsed?.version === 1 &&
                typeof parsed.deviceId === 'string' &&
                typeof parsed.publicKey === 'string' &&
                typeof parsed.privateKey === 'string'
            ) {
                // Verify device ID matches
                const derivedId = await fingerprintPublicKey(base64UrlDecode(parsed.publicKey));
                if (derivedId !== parsed.deviceId) {
                    // Update stored identity with correct device ID
                    const updated: StoredDeviceIdentity = {
                        ...parsed,
                        deviceId: derivedId,
                    };
                    await setStorageItem(DEVICE_IDENTITY_KEY, JSON.stringify(updated));
                    identityCache = {
                        deviceId: derivedId,
                        publicKey: parsed.publicKey,
                        privateKey: parsed.privateKey,
                    };
                    return identityCache;
                }
                identityCache = {
                    deviceId: parsed.deviceId,
                    publicKey: parsed.publicKey,
                    privateKey: parsed.privateKey,
                };
                return identityCache;
            }
        } catch (e) {
            console.warn('[Clawdbot] Failed to parse stored device identity, regenerating:', e);
        }
    }

    // Generate new identity
    console.log('[Clawdbot] Generating new device identity...');
    const identity = await generateDeviceIdentity();

    // Store it
    const toStore: StoredDeviceIdentity = {
        version: 1,
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
        createdAtMs: Date.now(),
    };
    await setStorageItem(DEVICE_IDENTITY_KEY, JSON.stringify(toStore));

    identityCache = identity;
    return identity;
}

/**
 * Get device identity if it exists (doesn't create new one)
 */
export async function getDeviceIdentity(): Promise<DeviceIdentity | null> {
    if (identityCache) return identityCache;

    const stored = await getStorageItem(DEVICE_IDENTITY_KEY);
    if (!stored) return null;

    try {
        const parsed = JSON.parse(stored) as StoredDeviceIdentity;
        if (
            parsed?.version === 1 &&
            typeof parsed.publicKey === 'string' &&
            typeof parsed.privateKey === 'string'
        ) {
            const derivedId = await fingerprintPublicKey(base64UrlDecode(parsed.publicKey));
            identityCache = {
                deviceId: derivedId === parsed.deviceId ? parsed.deviceId : derivedId,
                publicKey: parsed.publicKey,
                privateKey: parsed.privateKey,
            };
            return identityCache;
        }
    } catch {
        // Ignore
    }
    return null;
}

/**
 * Clear device identity (for testing/reset)
 */
export async function clearDeviceIdentity(): Promise<void> {
    identityCache = null;
    authTokenCache = null;
    await deleteStorageItem(DEVICE_IDENTITY_KEY);
    await deleteStorageItem(DEVICE_AUTH_TOKEN_KEY);
}

/**
 * Build the device auth payload string (to be signed)
 */
export function buildDeviceAuthPayload(params: {
    deviceId: string;
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    signedAtMs: number;
    token?: string | null;
    nonce?: string | null;
}): string {
    const version = params.nonce ? 'v2' : 'v1';
    const scopes = params.scopes.join(',');
    const token = params.token ?? '';
    const base = [
        version,
        params.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopes,
        String(params.signedAtMs),
        token,
    ];
    if (version === 'v2') {
        base.push(params.nonce ?? '');
    }
    return base.join('|');
}

/**
 * Sign a payload with the device's private key
 */
export async function signPayload(privateKeyBase64Url: string, payload: string): Promise<string> {
    const key = base64UrlDecode(privateKeyBase64Url);
    const data = new TextEncoder().encode(payload);
    const sig = await signAsync(data, key);
    return base64UrlEncode(sig);
}

/**
 * Get the public key in base64url format (for sending to gateway)
 */
export function getPublicKeyBase64Url(publicKeyBase64Url: string): string {
    // Already in base64url format
    return publicKeyBase64Url;
}

/**
 * Store device auth token (received after successful pairing)
 */
export async function storeDeviceAuthToken(params: {
    token: string;
    role: string;
    scopes: string[];
}): Promise<void> {
    const stored: StoredDeviceAuthToken = {
        token: params.token,
        role: params.role,
        scopes: params.scopes,
        createdAtMs: Date.now(),
    };
    await setStorageItem(DEVICE_AUTH_TOKEN_KEY, JSON.stringify(stored));
    authTokenCache = stored;
}

/**
 * Load device auth token
 */
export async function loadDeviceAuthToken(): Promise<StoredDeviceAuthToken | null> {
    if (authTokenCache) return authTokenCache;

    const stored = await getStorageItem(DEVICE_AUTH_TOKEN_KEY);
    if (!stored) return null;

    try {
        authTokenCache = JSON.parse(stored) as StoredDeviceAuthToken;
        return authTokenCache;
    } catch {
        return null;
    }
}

/**
 * Clear device auth token
 */
export async function clearDeviceAuthToken(): Promise<void> {
    authTokenCache = null;
    await deleteStorageItem(DEVICE_AUTH_TOKEN_KEY);
}
