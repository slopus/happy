/* ─────────────────────────────────────────────────────────────────────────
 * Chat store persistence (main-process IPC).
 *
 * The renderer keeps the live chat state in jotai. On boot it asks main
 * for the persisted snapshot via `chats:load`; after each change it pushes
 * the snapshot back via `chats:save`. We write atomically to
 * <userData>/codium-chats.json so a crash mid-write doesn't corrupt the
 * file.
 * ──────────────────────────────────────────────────────────────────────── */
import { app, ipcMain } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface PersistedChats {
    /** chatId → Chat — opaque to main; the renderer's store owns the shape. */
    chats: Record<string, unknown>
    /** Display order (newest-first). */
    order: string[]
}

const EMPTY: PersistedChats = { chats: {}, order: [] }

function chatsFile(): string {
    return join(app.getPath('userData'), 'codium-chats.json')
}

async function loadChats(): Promise<PersistedChats> {
    const path = chatsFile()
    let raw: string
    try {
        raw = await readFile(path, 'utf8')
    } catch {
        return EMPTY
    }
    try {
        const parsed = JSON.parse(raw) as PersistedChats
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.order)) return EMPTY
        return { chats: parsed.chats ?? {}, order: parsed.order }
    } catch {
        // Corrupt file — return empty and let the next save overwrite. Don't
        // delete; if a human wrote it by hand, surface via DevTools instead.
        // eslint-disable-next-line no-console
        console.error('[chat-store] failed to parse chats file at', path)
        return EMPTY
    }
}

async function saveChats(state: PersistedChats): Promise<void> {
    const path = chatsFile()
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(state), 'utf8')
    // Atomic-ish: rename clobbers the destination on POSIX. Avoids a
    // half-written file if power dies mid-write.
    await rename(tmp, path)
}

export function registerChatStoreIpc(): void {
    ipcMain.handle('chats:load', () => loadChats())
    ipcMain.handle('chats:save', (_e, state: PersistedChats) => saveChats(state))
}
