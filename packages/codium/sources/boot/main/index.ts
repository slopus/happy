import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { join } from 'node:path'

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
nativeTheme.on('updated', () => {
    const state = themeState()
    for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('theme:updated', state)
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
