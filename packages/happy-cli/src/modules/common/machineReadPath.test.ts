import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMachineReadPath } from './machineReadPath';
let base: string, home: string, cwd: string, volume: string;
beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'machine-read-')));
    home = join(base, 'home'); cwd = join(home, 'task'); volume = join(base, 'SSD');
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(volume)]);
    await writeFile(join(volume, 'index.html'), '<h1>external</h1>');
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });
it('reads a linked file on a discovered mounted volume from an unrelated home workspace', async () => {
    const result = await validateMachineReadPath(join(volume, 'index.html'), cwd, home, [volume]);
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toBe(join(volume, 'index.html'));
});
it('does not infer permission from the /Volumes prefix or a neighboring path', async () => {
    expect((await validateMachineReadPath(join(volume, 'index.html'), cwd, home, [])).valid).toBe(false);
    const other = join(base, 'SSD-private'); await mkdir(other); await writeFile(join(other, 'secret'), 'private');
    expect((await validateMachineReadPath(join(other, 'secret'), cwd, home, [volume])).valid).toBe(false);
});
it('rejects symlinks escaping all authorized roots', async () => {
    await writeFile(join(base, 'secret'), 'private'); await symlink(join(base, 'secret'), join(volume, 'escape'));
    expect((await validateMachineReadPath(join(volume, 'escape'), cwd, home, [volume])).valid).toBe(false);
});
it('keeps relative reads rooted at cwd and supports canonical aliases', async () => {
    await writeFile(join(cwd, 'note'), 'ok');
    expect((await validateMachineReadPath('note', cwd, home, [])).valid).toBe(true);
    const alias = join(base, 'alias'); await symlink(volume, alias);
    expect((await validateMachineReadPath(join(alias, 'index.html'), cwd, home, [volume])).resolvedPath).toBe(join(volume, 'index.html'));
});
