/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.happy/ or local .happy/
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { configuration } from '@/configuration'
import * as z from 'zod';
import { encodeBase64 } from '../api/encryption';

interface Settings {
  onboardingCompleted: boolean
  machineId?: string
  machineHost?: string
  daemonAutoStartWhenRunningHappy?: boolean
}

const defaultSettings: Settings = {
  onboardingCompleted: false
}

export async function readSettings(): Promise<Settings | null> {
  if (!existsSync(configuration.settingsFile)) {
    return { ...defaultSettings }
  }

  try {
    const content = await readFile(configuration.settingsFile, 'utf8')
    return JSON.parse(content)
  } catch {
    return { ...defaultSettings }
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  if (!existsSync(configuration.happyDir)) {
    await mkdir(configuration.happyDir, { recursive: true })
  }

  await writeFile(configuration.settingsFile, JSON.stringify(settings, null, 2))
}

//
// Authentication
//

const credentialsSchema = z.object({
  secret: z.string().base64(),
  token: z.string(),
})

export async function readCredentials(): Promise<{ secret: Uint8Array, token: string } | null> {
  if (!existsSync(configuration.privateKeyFile)) {
    return null
  }
  try {
    const keyBase64 = (await readFile(configuration.privateKeyFile, 'utf8'));
    const credentials = credentialsSchema.parse(JSON.parse(keyBase64));
    return {
      secret: new Uint8Array(Buffer.from(credentials.secret, 'base64')),
      token: credentials.token
    }
  } catch {
    return null
  }
}

export async function writeCredentials(credentials: { secret: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyDir)) {
    await mkdir(configuration.happyDir, { recursive: true })
  }
  await writeFile(configuration.privateKeyFile, JSON.stringify({
    secret: encodeBase64(credentials.secret),
    token: credentials.token
  }, null, 2));
}