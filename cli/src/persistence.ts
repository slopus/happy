/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.handy/
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const handyDir = join(homedir(), '.handy')
const settingsFile = join(handyDir, 'settings.json')
const privateKeyFile = join(handyDir, 'access.key')

interface Settings {
  onboardingCompleted: boolean
}

const defaultSettings: Settings = {
  onboardingCompleted: false
}

export async function readSettings(): Promise<Settings | null> {
  if (!existsSync(settingsFile)) {
    return {...defaultSettings}
  }
  
  try {
    const content = await readFile(settingsFile, 'utf8')
    return JSON.parse(content)
  } catch {
    return {...defaultSettings}
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  if (!existsSync(handyDir)) {
    await mkdir(handyDir, { recursive: true })
  }
  
  await writeFile(settingsFile, JSON.stringify(settings, null, 2))
}

// Store as base64 string for portability
export async function readPrivateKey(): Promise<Uint8Array | null> {
  if (!existsSync(privateKeyFile)) {
    return null
  }
  try {
    const keyBase64 = (await readFile(privateKeyFile, 'utf8')).trim()
    return new Uint8Array(Buffer.from(keyBase64, 'base64'))
  } catch {
    return null
  }
}

export async function writePrivateKey(key: Uint8Array): Promise<void> {
  if (!existsSync(handyDir)) {
    await mkdir(handyDir, { recursive: true })
  }
  const keyBase64 = Buffer.from(key).toString('base64')
  await writeFile(privateKeyFile, keyBase64, 'utf8')
}