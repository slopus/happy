import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

export async function privateDirectory(path: string): Promise<void> {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
    });
    await assertPrivate(path, true);
}

export async function assertPrivate(path: string, directory = false): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
        || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
        throw new Error(`Expected an owner-only ${directory ? 'directory' : 'file'}: ${path}`);
    }
}

export async function privateWrite(path: string, contents: string): Promise<void> {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(contents, 'utf8'); } finally { await handle.close(); }
}

export async function privateRead(path: string): Promise<string> {
    await assertPrivate(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await handle.readFile('utf8'); } finally { await handle.close(); }
}

export async function exists(path: string): Promise<boolean> {
    try { await lstat(path); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

/** No parent environment spread, host HOME, shell initialization, or dotenv. */
export function childEnvironment(runRoot: string): NodeJS.ProcessEnv {
    const home = join(runRoot, 'home');
    const temp = join(runRoot, 'tmp');
    return {
        PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
        LANG: 'en_US.UTF-8',
        CI: '1',
        HOME: home,
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_CACHE_HOME: join(home, 'cache'),
        XDG_DATA_HOME: join(home, 'data'),
        NODE_ENV: 'development',
        EXPO_NO_DOTENV: '1',
        EXPO_NO_TELEMETRY: '1',
        EXPO_OFFLINE: '1',
        BROWSER: 'none',
    };
}

export async function canonicalDirectory(path: string): Promise<string> {
    const canonical = await realpath(path);
    if (!(await lstat(canonical)).isDirectory()) throw new Error(`Not a directory: ${path}`);
    return canonical;
}