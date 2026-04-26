import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    nativeTheme,
    shell,
} from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'

if (is.dev) {
    app.commandLine.appendSwitch('remote-debugging-port', '9224')
}

type ThemeSource = 'system' | 'light' | 'dark'
const themeState = () => ({
    source: nativeTheme.themeSource as ThemeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
})

ipcMain.handle('theme:get', () => themeState())
ipcMain.handle('theme:set', (_, source: ThemeSource) => {
    nativeTheme.themeSource = source
    return themeState()
})
ipcMain.on(
    'theme:set-opaque',
    (e, args: { opaque: boolean; surface?: string } | boolean) => {
        const win = BrowserWindow.fromWebContents(e.sender)
        if (!win || process.platform !== 'darwin') return
        // Backwards-compat: legacy callers send a bare boolean.
        const opaque = typeof args === 'boolean' ? args : !!args?.opaque
        const surface = typeof args === 'object' ? args?.surface : undefined
        try {
            if (opaque) {
                // Disable macOS vibrancy and set the actual theme surface as the
                // window's solid background. Without setBackgroundColor, the
                // initial transparent backing remains and the body shows through.
                win.setVibrancy(null)
                win.setBackgroundColor(surface || '#ffffff')
            } else {
                win.setVibrancy('sidebar')
                // Transparent so the vibrancy material shows through.
                win.setBackgroundColor('#00000000')
            }
        } catch {
            /* not all macOS versions accept all vibrancies */
        }
    }
)
/* ─────────── Codex OAuth via `codex login` ─────────── */

interface CodexTokens {
    access_token: string
    id_token: string
    refresh_token?: string
    account_id?: string
}
interface CodexAuthFile {
    OPENAI_API_KEY: string | null
    tokens?: CodexTokens
    last_refresh?: string
}
interface CodexAuthSnapshot {
    status: 'unconfigured' | 'connected'
    email?: string
    accountId?: string
    /** Bearer token (access_token) ready to use as Authorization header. */
    accessToken?: string
    expiresAt?: number
}

const CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json')
const CODEX_BIN_CANDIDATES = [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
]

function decodeJwtPayload<T = Record<string, unknown>>(jwt: string): T | null {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    try {
        let s = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
        while (s.length % 4) s += '='
        return JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as T
    } catch {
        return null
    }
}

async function readCodexAuth(): Promise<CodexAuthSnapshot> {
    if (!existsSync(CODEX_AUTH_PATH)) return { status: 'unconfigured' }
    try {
        const raw = await readFile(CODEX_AUTH_PATH, 'utf8')
        const parsed = JSON.parse(raw) as CodexAuthFile
        const tokens = parsed.tokens
        if (!tokens?.access_token) return { status: 'unconfigured' }
        const claims = decodeJwtPayload<{ exp?: number }>(tokens.access_token)
        const idClaims = decodeJwtPayload<{ email?: string }>(tokens.id_token ?? '')
        return {
            status: 'connected',
            email: idClaims?.email,
            accountId: tokens.account_id,
            accessToken: tokens.access_token,
            expiresAt: claims?.exp,
        }
    } catch {
        return { status: 'unconfigured' }
    }
}

function findCodexBin(): string | null {
    for (const p of CODEX_BIN_CANDIDATES) {
        if (existsSync(p)) return p
    }
    return null
}

let activeLogin: ChildProcess | null = null

async function spawnCodexLogin(): Promise<CodexAuthSnapshot> {
    if (activeLogin) {
        // already running — wait for it
    }
    const bin = findCodexBin()
    if (!bin) {
        throw new Error('Codex CLI not found. Install Codex.app or run `npm i -g @openai/codex`.')
    }
    // Drop any stale auth so we wait for a fresh write.
    try {
        if (existsSync(CODEX_AUTH_PATH)) await unlink(CODEX_AUTH_PATH)
    } catch {}

    return new Promise<CodexAuthSnapshot>((resolve, reject) => {
        const child = spawn(bin, ['login'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        })
        activeLogin = child
        let stderr = ''
        child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
        child.on('error', (err) => {
            activeLogin = null
            reject(err)
        })
        child.on('exit', async (code) => {
            activeLogin = null
            if (code !== 0) {
                reject(new Error(`codex login exited ${code}: ${stderr.trim() || 'unknown'}`))
                return
            }
            const snap = await readCodexAuth()
            if (snap.status !== 'connected') {
                reject(new Error('codex login finished but auth.json was not written'))
                return
            }
            resolve(snap)
        })
        // Safety: if `codex login` runs longer than 5 minutes, abort.
        setTimeout(() => {
            if (activeLogin === child) {
                child.kill()
                activeLogin = null
                reject(new Error('codex login timed out after 5 minutes'))
            }
        }, 5 * 60 * 1000)
    })
}

ipcMain.handle('codex:auth:status', async () => readCodexAuth())
ipcMain.handle('codex:auth:login', async () => {
    return spawnCodexLogin()
})
ipcMain.handle('codex:auth:logout', async () => {
    if (activeLogin) {
        try { activeLogin.kill() } catch {}
        activeLogin = null
    }
    try { if (existsSync(CODEX_AUTH_PATH)) await unlink(CODEX_AUTH_PATH) } catch {}
})
ipcMain.on('codex:auth:cancel-login', () => {
    if (activeLogin) {
        try { activeLogin.kill() } catch {}
        activeLogin = null
    }
})

nativeTheme.on('updated', () => {
    const state = themeState()
    for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('theme:updated', state)
    }
})

const ptys = new Map<string, pty.IPty>()

ipcMain.handle(
    'pty:create',
    (e, opts: { cols?: number; rows?: number; cwd?: string } = {}) => {
        const shell =
            process.env.SHELL ||
            (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
        const p = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: opts.cols ?? 80,
            rows: opts.rows ?? 24,
            cwd: opts.cwd ?? homedir(),
            env: process.env as Record<string, string>,
        })
        const id = randomUUID()
        const wc = e.sender
        const safeSend = (channel: string, ...args: unknown[]) => {
            if (wc.isDestroyed()) return
            try {
                wc.send(channel, ...args)
            } catch {
                /* webContents went away between the check and the send */
            }
        }
        p.onData((d) => safeSend(`pty:data:${id}`, d))
        p.onExit(() => {
            ptys.delete(id)
            safeSend(`pty:exit:${id}`)
        })
        ptys.set(id, p)
        return id
    }
)

ipcMain.on('pty:write', (_, id: string, data: string) => {
    ptys.get(id)?.write(data)
})

ipcMain.on('pty:resize', (_, id: string, cols: number, rows: number) => {
    const p = ptys.get(id)
    if (!p) return
    try {
        p.resize(cols, rows)
    } catch {
        /* ignored */
    }
})

ipcMain.on('pty:kill', (_, id: string) => {
    const p = ptys.get(id)
    if (!p) return
    try {
        p.kill()
    } finally {
        ptys.delete(id)
    }
})

app.on('before-quit', () => {
    for (const p of ptys.values()) {
        try {
            p.kill()
        } catch {
            /* ignored */
        }
    }
    ptys.clear()
})

ipcMain.on('win:sync:is-fullscreen', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    e.returnValue = win?.isFullScreen() ?? false
})

const IMAGE_MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    heic: 'image/heic',
}

ipcMain.handle('files:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [
            {
                name: 'Images',
                extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'],
            },
            {
                name: 'Documents',
                extensions: ['pdf', 'txt', 'md', 'json', 'csv', 'rtf', 'docx'],
            },
            { name: 'All Files', extensions: ['*'] },
        ],
    })
    if (result.canceled) return []
    return result.filePaths.map((p) => ({
        path: p,
        name: basename(p),
        ext: extname(p).toLowerCase().slice(1),
    }))
})

ipcMain.handle('files:pick-directory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    return {
        path,
        name: basename(path),
        ext: 'folder',
    }
})

ipcMain.handle('files:read-data-url', async (_e, filePath: string) => {
    const ext = extname(filePath).toLowerCase().slice(1)
    const mime = IMAGE_MIME[ext]
    if (!mime) return null
    try {
        const buf = await readFile(filePath)
        return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
        return null
    }
})

function createWindow(): void {
    const isMac = process.platform === 'darwin'
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: isMac ? '#00000000' : '#181818',
        titleBarStyle: isMac ? 'hiddenInset' : 'default',
        trafficLightPosition: isMac ? { x: 20, y: 17 } : undefined,
        vibrancy: isMac ? 'sidebar' : undefined,
        visualEffectState: 'active',
        webPreferences: {
            preload: join(__dirname, '../preload/index.mjs'),
            sandbox: false,
            contextIsolation: true,
        },
    })

    mainWindow.on('ready-to-show', () => {
        mainWindow.show()
    })

    mainWindow.on('enter-full-screen', () => {
        mainWindow.webContents.send('win:fullscreen', true)
    })
    mainWindow.on('leave-full-screen', () => {
        mainWindow.webContents.send('win:fullscreen', false)
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url)
        return { action: 'deny' }
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
}

app.whenReady().then(() => {
    electronApp.setAppUserModelId('dev.codium')

    app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
    })

    createWindow()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})
