import { readFile, mkdir, open, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { resolveExtensionDir, resolveExtensionId } from '@/commands/browser'
import type { BrowserSetupPolicy } from './browserBridge'

export async function readBrowserSetupPolicy(file: string): Promise<BrowserSetupPolicy> {
    let raw: string
    try { raw = await readFile(file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
    const value = JSON.parse(raw)
    if (value?.version !== 1 || !value.scopes || typeof value.scopes !== 'object' || Array.isArray(value.scopes)) throw new Error('INVALID_BROWSER_SETUP_POLICY')
    for (const [scope, grant] of Object.entries(value.scopes)) {
        if (!/^bv1_[A-Za-z0-9_-]{32}$/.test(scope)) throw new Error('INVALID_BROWSER_SETUP_POLICY')
        if (grant === null) continue
        const row = grant as Record<string, unknown>
        if (typeof row?.pairingId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(row.pairingId)
            || typeof row.profile !== 'string' || !row.profile.trim() || row.profile.length > 128) throw new Error('INVALID_BROWSER_SETUP_POLICY')
    }
    return value.scopes
}
export async function writeBrowserSetupPolicy(file: string, scopes: BrowserSetupPolicy): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    // fsync before rename: a crash must leave the old policy or the new one, never a truncated file
    // (an unreadable policy disables the whole bridge).
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ version: 1, scopes })); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
}
export function localBrowserExtensionMetadata() {
    const directory = resolveExtensionDir()
    const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, 'utf8'))
    const id = resolveExtensionId(directory)
    if (id !== 'emaponnolfbhnoaabgiebjmbdlmoifke' || manifest.options_page !== 'src/options.html'
        || !readFileSync(`${directory}/src/nativePairing.js`, 'utf8').includes('attemptSetupPairing')) throw new Error('BROWSER_SETUP_UPGRADE_REQUIRED')
    return { directory, id, version: String(manifest.version) }
}
