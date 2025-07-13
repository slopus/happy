/**
 * Authentication module for handy-cli
 * 
 * This module handles authentication with the handy server using public key cryptography.
 * It manages secret key generation, storage, and the authentication flow.
 * 
 * Key responsibilities:
 * - Generate and persist secret keys
 * - Implement challenge-response authentication
 * - Obtain and manage auth tokens
 * 
 * Design decisions:
 * - Secret keys are stored in the user's home directory for persistence
 * - Uses tweetnacl for cryptographic operations
 * - Auth tokens are kept in memory only (not persisted)
 */

import { getSecretKeyPath } from '#utils/paths'
import axios from 'axios'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import nacl from 'tweetnacl'

import { encodeBase64, encodeBase64Url, getRandomBytes } from './crypto.js'

/**
 * Generate or load a secret key for authentication
 * Creates a new key if one doesn't exist, otherwise loads the existing key
 */
export async function getOrCreateSecretKey(): Promise<Uint8Array> {
  const keyPath = getSecretKeyPath()
  
  if (existsSync(keyPath)) {
    const keyBase64 = readFileSync(keyPath, 'utf8').trim()
    return new Uint8Array(Buffer.from(keyBase64, 'base64'))
  }
  
  // Generate a new 32-byte secret key (256 bits)
  const secret = getRandomBytes(32)
  const keyBase64 = encodeBase64(secret)
  
  // Write to file with restricted permissions
  writeFileSync(keyPath, keyBase64)
  await chmod(keyPath, 0o600) // Read/write for owner only
  
  return secret
}

/**
 * Generate authentication challenge response
 */
export function authChallenge(secret: Uint8Array): {
  challenge: Uint8Array
  publicKey: Uint8Array
  signature: Uint8Array
} {
  const keypair = nacl.sign.keyPair.fromSeed(secret)
  const challenge = getRandomBytes(32)
  const signature = nacl.sign.detached(challenge, keypair.secretKey)
  
  return {
    challenge,
    publicKey: keypair.publicKey,
    signature
  }
}

/**
 * Authenticate with the server and obtain an auth token
 */
export async function authGetToken(serverUrl: string, secret: Uint8Array): Promise<string> {
  const { challenge, publicKey, signature } = authChallenge(secret)
  
  const response = await axios.post(`${serverUrl}/v1/auth`, {
    challenge: encodeBase64(challenge),
    publicKey: encodeBase64(publicKey),
    signature: encodeBase64(signature)
  })
  
  if (!response.data.success || !response.data.token) {
    throw new Error('Authentication failed')
  }
  
  return response.data.token
}

/**
 * Generate handy:// URL with the secret key encoded in base64url format
 * This URL is used for QR code generation to allow mobile clients to connect
 */
export function generateHandyUrl(secret: Uint8Array): string {
  const secretBase64Url = encodeBase64Url(secret)
  return `handy://${secretBase64Url}`
}