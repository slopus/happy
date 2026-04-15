/**
 * OpenClaw Device Identity & Authentication
 *
 * Manages Ed25519 device identity for secure gateway authentication.
 * Ported from expo-app/sources/clawdbot/deviceIdentity.ts for Node.js,
 * using filesystem storage instead of expo-secure-store.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

// @noble/ed25519 v3 requires explicit SHA-512 configuration via hashes object
ed.hashes.sha512 = (message: Uint8Array) => sha512(message);

const { getPublicKeyAsync, signAsync, utils } = ed;

const OPENCLAW_DIR_NAME = 'openclaw';
const DEVICE_IDENTITY_FILE = 'device-identity.json';
const DEVICE_AUTH_TOKEN_FILE = 'device-auth-token.json';

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: string;
}

interface StoredDeviceIdentity {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
}

export interface StoredDeviceAuthToken {
  token: string;
  role: string;
  scopes: string[];
  createdAtMs: number;
}

let identityCache: DeviceIdentity | null = null;
let authTokenCache: StoredDeviceAuthToken | null = null;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

export function base64UrlDecode(input: string): Uint8Array {
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

function getOpenClawDir(homeDir: string): string {
  return join(homeDir, OPENCLAW_DIR_NAME);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = join(filePath, '..');
  ensureDir(dir);
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function deleteFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function fingerprintPublicKey(publicKey: Uint8Array): string {
  const hash = createHash('sha256').update(publicKey).digest();
  return bytesToHex(new Uint8Array(hash));
}

async function generateDeviceIdentity(): Promise<DeviceIdentity> {
  const privateKey = utils.randomSecretKey();
  const publicKey = await getPublicKeyAsync(privateKey);
  const deviceId = fingerprintPublicKey(publicKey);
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  };
}

export async function loadOrCreateDeviceIdentity(homeDir: string): Promise<DeviceIdentity> {
  if (identityCache) return identityCache;

  const filePath = join(getOpenClawDir(homeDir), DEVICE_IDENTITY_FILE);
  const stored = readJsonFile<StoredDeviceIdentity>(filePath);

  if (stored?.version === 1 && typeof stored.publicKey === 'string' && typeof stored.privateKey === 'string') {
    const derivedId = fingerprintPublicKey(base64UrlDecode(stored.publicKey));
    if (derivedId !== stored.deviceId) {
      const updated: StoredDeviceIdentity = { ...stored, deviceId: derivedId };
      writeJsonFile(filePath, updated);
    }
    identityCache = {
      deviceId: derivedId,
      publicKey: stored.publicKey,
      privateKey: stored.privateKey,
    };
    return identityCache;
  }

  const identity = await generateDeviceIdentity();
  const toStore: StoredDeviceIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  };
  writeJsonFile(filePath, toStore);
  identityCache = identity;
  return identityCache;
}

export async function loadDeviceAuthToken(homeDir: string): Promise<StoredDeviceAuthToken | null> {
  if (authTokenCache) return authTokenCache;
  const filePath = join(getOpenClawDir(homeDir), DEVICE_AUTH_TOKEN_FILE);
  authTokenCache = readJsonFile<StoredDeviceAuthToken>(filePath);
  return authTokenCache;
}

export async function storeDeviceAuthToken(homeDir: string, params: { token: string; role: string; scopes: string[] }): Promise<void> {
  const stored: StoredDeviceAuthToken = {
    token: params.token,
    role: params.role,
    scopes: params.scopes,
    createdAtMs: Date.now(),
  };
  writeJsonFile(join(getOpenClawDir(homeDir), DEVICE_AUTH_TOKEN_FILE), stored);
  authTokenCache = stored;
}

export async function clearDeviceIdentity(homeDir: string): Promise<void> {
  identityCache = null;
  authTokenCache = null;
  deleteFile(join(getOpenClawDir(homeDir), DEVICE_IDENTITY_FILE));
  deleteFile(join(getOpenClawDir(homeDir), DEVICE_AUTH_TOKEN_FILE));
}

export function resetIdentityCache(): void {
  identityCache = null;
  authTokenCache = null;
}

export function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
}): string {
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  return ['v2', params.deviceId, params.clientId, params.clientMode, params.role, scopes, String(params.signedAtMs), token, params.nonce].join('|');
}

export async function signPayload(privateKeyBase64Url: string, payload: string): Promise<string> {
  const key = base64UrlDecode(privateKeyBase64Url);
  const data = new TextEncoder().encode(payload);
  const sig = await signAsync(data, key);
  return base64UrlEncode(sig);
}
