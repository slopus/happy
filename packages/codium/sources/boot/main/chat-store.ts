/* ─────────────────────────────────────────────────────────────────────────
 * Chat/workspace store persistence (main-process IPC).
 *
 * The renderer keeps live state in jotai. On boot it asks main for the
 * persisted snapshot via `chats:load`; after each change it pushes the
 * snapshot back via `chats:save`. The snapshot is stored in
 * <Happy home>/state.sqlite.
 * ──────────────────────────────────────────────────────────────────────── */
import { app, ipcMain } from 'electron'
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateDatabasePath } from './app-storage'

export interface PersistedChats {
    /** chatId -> Chat - opaque to main; the renderer's store owns the shape. */
    chats: Record<string, unknown>
    /** Display order (newest-first). */
    order: string[]
    projects?: Record<string, unknown>
    projectOrder?: string[]
    workspaces?: Record<string, unknown>
    terminals?: Record<string, unknown>
}

const EMPTY: PersistedChats = { chats: {}, order: [] }
const SNAPSHOT_KEY = 'workspace-snapshot'

let db: Database.Database | null = null

function getDb(): Database.Database {
    if (db) return db
    const next = new Database(stateDatabasePath())
    next.pragma('journal_mode = WAL')
    next.exec(`
        CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `)
    db = next
    return next
}

function legacyChatsFile(): string {
    return join(app.getPath('userData'), 'codium-chats.json')
}

async function loadChats(): Promise<PersistedChats> {
    const row = getDb()
        .prepare('SELECT value FROM app_state WHERE key = ?')
        .get(SNAPSHOT_KEY) as { value: string } | undefined
    if (row) return parseSnapshot(row.value, `sqlite:${SNAPSHOT_KEY}`)

    const migrated = await loadLegacyChats()
    if (migrated) {
        await saveChats(migrated)
        return migrated
    }

    return EMPTY
}

async function loadLegacyChats(): Promise<PersistedChats | null> {
    const path = legacyChatsFile()
    if (!existsSync(path)) return null
    try {
        return parseSnapshot(await readFile(path, 'utf8'), path)
    } catch {
        return null
    }
}

function parseSnapshot(raw: string, label: string): PersistedChats {
    try {
        const parsed = JSON.parse(raw) as Partial<PersistedChats>
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.order)) return EMPTY
        return {
            chats: isRecord(parsed.chats) ? parsed.chats : {},
            order: parsed.order.filter((id): id is string => typeof id === 'string'),
            projects: isRecord(parsed.projects) ? parsed.projects : undefined,
            projectOrder: Array.isArray(parsed.projectOrder)
                ? parsed.projectOrder.filter((id): id is string => typeof id === 'string')
                : undefined,
            workspaces: isRecord(parsed.workspaces) ? parsed.workspaces : undefined,
            terminals: isRecord(parsed.terminals) ? parsed.terminals : undefined,
        }
    } catch {
        // eslint-disable-next-line no-console
        console.error('[chat-store] failed to parse persisted state at', label)
        return EMPTY
    }
}

async function saveChats(state: PersistedChats): Promise<void> {
    getDb()
        .prepare(`
            INSERT INTO app_state (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
        `)
        .run(SNAPSHOT_KEY, JSON.stringify(state), Date.now())
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function closeDb(): void {
    try {
        db?.close()
    } finally {
        db = null
    }
}

export function registerChatStoreIpc(): void {
    ipcMain.handle('chats:load', () => loadChats())
    ipcMain.handle('chats:save', (_e, state: PersistedChats) => saveChats(state))
    app.on('before-quit', closeDb)
}
