import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function happyHomeName(platform: NodeJS.Platform = process.platform): 'Happy' | 'happy' {
    return platform === 'linux' ? 'happy' : 'Happy'
}

export function happyHomeDir(
    platform: NodeJS.Platform = process.platform,
    homeDir: string = homedir(),
): string {
    return join(homeDir, happyHomeName(platform))
}

export function ensureHappyHomeDir(): string {
    const dir = happyHomeDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
}

export function stateDatabasePath(): string {
    return join(ensureHappyHomeDir(), 'state.sqlite')
}

export function workspacesRootDir(): string {
    return join(ensureHappyHomeDir(), 'workspaces')
}

export function projectWorkspacesDir(projectName: string): string {
    return join(workspacesRootDir(), projectName)
}

export function storageFilePath(filename: string): string {
    return join(ensureHappyHomeDir(), filename)
}
