/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.happy/ or local .happy/
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { configuration } from '@/configuration'

interface Settings {
  onboardingCompleted: boolean
}

const defaultSettings: Settings = {
  onboardingCompleted: false
}

export async function readSettings(): Promise<Settings | null> {
  if (!existsSync(configuration.settingsFile)) {
    return {...defaultSettings}
  }
  
  try {
    const content = await readFile(configuration.settingsFile, 'utf8')
    return JSON.parse(content)
  } catch {
    return {...defaultSettings}
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  if (!existsSync(configuration.happyDir)) {
    await mkdir(configuration.happyDir, { recursive: true })
  }
  
  await writeFile(configuration.settingsFile, JSON.stringify(settings, null, 2))
}

// Store as base64 string for portability
export async function readPrivateKey(): Promise<Uint8Array | null> {
  if (!existsSync(configuration.privateKeyFile)) {
    return null
  }
  try {
    const keyBase64 = (await readFile(configuration.privateKeyFile, 'utf8')).trim()
    return new Uint8Array(Buffer.from(keyBase64, 'base64'))
  } catch {
    return null
  }
}

export async function writePrivateKey(key: Uint8Array): Promise<void> {
  if (!existsSync(configuration.happyDir)) {
    await mkdir(configuration.happyDir, { recursive: true })
  }
  const keyBase64 = Buffer.from(key).toString('base64')
  await writeFile(configuration.privateKeyFile, keyBase64, 'utf8')
}