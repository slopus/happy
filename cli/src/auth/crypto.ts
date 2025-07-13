/**
 * Crypto utilities for handy-cli
 * 
 * This module provides cryptographic functions for authentication with the handy server.
 * It handles base64 encoding/decoding and random byte generation for secret keys.
 * 
 * Key responsibilities:
 * - Base64 encoding/decoding for communication with server
 * - Base64URL encoding for handy:// URL generation
 * - Secure random byte generation for secret keys
 * - Conversion between different buffer formats
 */

import { randomBytes } from 'node:crypto'

/**
 * Encode a Uint8Array to base64 string
 */
export function encodeBase64(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString('base64')
}

/**
 * Encode a Uint8Array to base64url string (URL-safe base64)
 * Base64URL uses '-' instead of '+', '_' instead of '/', and removes padding
 */
export function encodeBase64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

/**
 * Generate secure random bytes
 */
export function getRandomBytes(size: number): Uint8Array {
  return new Uint8Array(randomBytes(size))
}