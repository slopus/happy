/**
 * Tests for the socket client module
 * 
 * These tests verify socket connection and authentication with the real server.
 * No mocking is used as per project requirements.
 */

import { authGetToken, getOrCreateSecretKey } from '#auth/auth'
import { getConfig } from '#utils/config'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'

import { SocketClient } from './client.js'

describe('SocketClient', () => {
  let client: null | SocketClient = null
  let authToken: string
  
  beforeAll(async () => {
    // Get auth token for tests
    const config = getConfig()
    const secret = await getOrCreateSecretKey()
    authToken = await authGetToken(config.serverUrl, secret)
  })
  
  afterEach(() => {
    // Clean up socket connection
    if (client) {
      client.disconnect()
      client = null
    }
  })
  
  describe('connection', () => {
    it('should connect to the server with valid auth token', async () => {
      const config = getConfig()
      
      client = new SocketClient({
        authToken,
        serverUrl: config.serverUrl,
        socketPath: config.socketPath
      })
      
      client.connect()
      
      // Wait for authentication
      const user = await client.waitForAuth()
      
      expect(user).toBeTypeOf('string')
      expect(client.getIsConnected()).toBe(true)
    })
    
    it('should emit error with invalid auth token', async () => {
      const config = getConfig()
      
      client = new SocketClient({
        authToken: 'invalid-token',
        serverUrl: config.serverUrl,
        socketPath: config.socketPath
      })
      
      client.connect()
      
      // Should reject with auth error
      try {
        await client.waitForAuth()
        throw new Error('Should have thrown auth error')
      } catch (error) {
        expect((error as Error).message).toContain('Authentication')
      }
    }, 10_000)
  })
  
  describe('events', () => {
    it('should emit connected event on successful connection', async () => {
      const config = getConfig()
      
      client = new SocketClient({
        authToken,
        serverUrl: config.serverUrl,
        socketPath: config.socketPath
      })
      
      const connectedPromise = new Promise<void>((resolve) => {
        client!.once('connected', () => {
          expect(client!.getIsConnected()).toBe(true)
          resolve()
        })
      })
      
      client.connect()
      await connectedPromise
    })
  })
})