/**
 * Tests for the authentication module
 * 
 * These tests use the real handy server API to verify authentication works correctly.
 * No mocking is used as per project requirements.
 */

import { getConfig } from '#utils/config'
import { getSecretKeyPath } from '#utils/paths'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync } from 'node:fs'

import { authChallenge, authGetToken, generateHandyUrl, getOrCreateSecretKey } from './auth.js'
import { encodeBase64 } from './crypto.js'

describe('Authentication', () => {
  const keyPath = getSecretKeyPath()
  
  // Clean up any existing key before tests
  beforeEach(() => {
    if (existsSync(keyPath)) {
      unlinkSync(keyPath)
    }
  })
  
  // Clean up after tests
  afterEach(() => {
    if (existsSync(keyPath)) {
      unlinkSync(keyPath)
    }
  })
  
  describe('getOrCreateSecretKey', () => {
    it('should create a new secret key if none exists', async () => {
      const secret = await getOrCreateSecretKey()
      
      expect(secret).toBeInstanceOf(Uint8Array)
      expect(secret.length).toBe(32)
      expect(existsSync(keyPath)).toBe(true)
    })
    
    it('should return the same key on subsequent calls', async () => {
      const secret1 = await getOrCreateSecretKey()
      const secret2 = await getOrCreateSecretKey()
      
      expect(encodeBase64(secret1)).toBe(encodeBase64(secret2))
    })
  })
  
  describe('authChallenge', () => {
    it('should generate valid challenge response', async () => {
      const secret = await getOrCreateSecretKey()
      const { challenge, publicKey, signature } = authChallenge(secret)
      
      expect(challenge).toBeInstanceOf(Uint8Array)
      expect(challenge.length).toBe(32)
      
      expect(signature).toBeInstanceOf(Uint8Array)
      expect(signature.length).toBe(64)
      
      expect(publicKey).toBeInstanceOf(Uint8Array)
      expect(publicKey.length).toBe(32)
    })
  })
  
  describe('authGetToken', () => {
    it('should authenticate with the server and get a token', async () => {
      const config = getConfig()
      const secret = await getOrCreateSecretKey()
      
      const token = await authGetToken(config.serverUrl, secret)
      
      expect(token).toBeTypeOf('string')
      expect(token.length).toBeGreaterThan(0)
    })
    
    it('should get valid tokens for the same public key', async () => {
      const config = getConfig()
      const secret = await getOrCreateSecretKey()
      
      const token1 = await authGetToken(config.serverUrl, secret)
      const token2 = await authGetToken(config.serverUrl, secret)
      
      // Both should be valid JWT tokens (format: header.payload.signature)
      expect(token1.split('.')).toHaveLength(3)
      expect(token2.split('.')).toHaveLength(3)
    })
  })
  
  describe('generateHandyUrl', () => {
    it('should generate a valid handy:// URL with base64url encoded secret', async () => {
      const secret = await getOrCreateSecretKey()
      const url = generateHandyUrl(secret)
      
      expect(url).toBeTypeOf('string')
      expect(url).toMatch(/^handy:\/\/[A-Za-z0-9_-]+$/)
    })
    
    it('should generate URLs that do not contain base64 padding or unsafe characters', async () => {
      const secret = await getOrCreateSecretKey()
      const url = generateHandyUrl(secret)
      
      // Extract just the base64url part (after handy://)
      const base64urlPart = url.slice('handy://'.length)
      
      // Base64url should not contain +, /, or = characters
      expect(base64urlPart).not.toContain('+')
      expect(base64urlPart).not.toContain('/')
      expect(base64urlPart).not.toContain('=')
      
      // Should be base64url safe characters only
      expect(base64urlPart).toMatch(/^[A-Za-z0-9_-]+$/)
    })
    
    it('should generate consistent URLs for the same secret', async () => {
      const secret = await getOrCreateSecretKey()
      const url1 = generateHandyUrl(secret)
      const url2 = generateHandyUrl(secret)
      
      expect(url1).toBe(url2)
    })
  })
})