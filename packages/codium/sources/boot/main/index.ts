import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    nativeTheme,
    shell,
} from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import {
    cancelLogin as cancelCodexLogin,
    getStatus as getCodexStatus,
    login as codexLogin,
    logout as codexLogout,
} from './codex-oauth'

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
/* ─────────── Codex OAuth (PKCE flow, no CLI dependency) ─────────── */
ipcMain.handle('codex:auth:status', () => getCodexStatus())
ipcMain.handle('codex:auth:login', () => codexLogin())
ipcMain.handle('codex:auth:logout', () => codexLogout())
ipcMain.on('codex:auth:cancel-login', () => cancelCodexLogin())

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
