/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.happy/ or local .happy/
 */

import { readFile, writeFile, mkdir, open, unlink, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { constants } from 'node:fs'
import { configuration } from '@/configuration'
import * as z from 'zod';
import { encodeBase64 } from '../api/encryption';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

interface Settings {
  onboardingCompleted: boolean
  // This ID is used as the actual database ID on the server
  // All machine operations use this ID
  machineId?: string
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

/**
 * Atomically update settings with multi-process safety via file locking
 * @param updater Function that takes current settings and returns updated settings
 * @returns The updated settings
 */
export async function updateSettings(
  updater: (current: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
  // Timing constants
  const LOCK_RETRY_INTERVAL_MS = 100;  // How long to wait between lock attempts
  const MAX_LOCK_ATTEMPTS = 50;        // Maximum number of attempts (5 seconds total)
  const STALE_LOCK_TIMEOUT_MS = 10000; // Consider lock stale after 10 seconds
  
  const lockFile = configuration.settingsFile + '.lock';
  const tmpFile = configuration.settingsFile + '.tmp';
  let fileHandle;
  let attempts = 0;
  
  // Acquire exclusive lock with retries
  while (attempts < MAX_LOCK_ATTEMPTS) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY = create exclusively, fail if exists
      fileHandle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      break;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock file exists, wait and retry
        attempts++;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
        
        // Check for stale lock
        try {
          const stats = await stat(lockFile);
          if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
            await unlink(lockFile).catch(() => {});
          }
        } catch {}
      } else {
        throw err;
      }
    }
  }
  
  if (!fileHandle) {
    throw new Error(`Failed to acquire settings lock after ${MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS / 1000} seconds`);
  }
  
  try {
    // Read current settings with defaults
    const current = await readSettings() || { ...defaultSettings };
    
    // Apply update
    const updated = await updater(current);
    
    // Ensure directory exists
    if (!existsSync(configuration.happyDir)) {
      await mkdir(configuration.happyDir, { recursive: true });
    }
    
    // Write atomically using rename
    await writeFile(tmpFile, JSON.stringify(updated, null, 2));
    await rename(tmpFile, configuration.settingsFile); // Atomic on POSIX
    
    return updated;
  } finally {
    // Release lock
    await fileHandle.close();
    await unlink(lockFile).catch(() => {}); // Remove lock file
  }
}

/**
 * Ensure machine ID exists in settings, generating if needed
 * @returns Settings with machineId guaranteed to exist
 * @deprecated Use authAndSetupMachineIfNeeded() from ui/auth.ts instead
 */
export async function ensureMachineId(): Promise<Settings> {
  return updateSettings(settings => {
    if (!settings.machineId) {
      return {
        ...settings,
        machineId: randomUUID()
      };
    }
    return settings;
  });
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