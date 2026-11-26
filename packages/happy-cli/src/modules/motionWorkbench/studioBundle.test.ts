import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildStudioLicenseText } from './studioBundle';

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function runtime() {
    const path = await mkdtemp(join(tmpdir(), 'paws-motion-notices-'));
    fixtures.push(path);
    return path;
}
async function packageAt(root: string, name: string, version = '1.0.0', repository: unknown = { type: 'git', url: 'git+https://github.com/MotionHarness/motionharness.git' }) {
    const path = join(root, 'node_modules/@motionharness', name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: '@motionharness/' + name, version, license: name === 'sdk' ? 'MIT' : 'GPL-3.0-only', repository }));
    await writeFile(join(path, 'LICENSE'), name + ' original license\n');
    return path;
}

it('preserves installed notices and exact package versions in the existing license download text', async () => {
    const root = await runtime();
    for (const name of ['studio', 'core', 'sdk', 'ui']) {
        const path = await packageAt(root, name, name === 'sdk' ? '0.1.8' : '1.0.0');
        await writeFile(join(path, 'NOTICE'), name + ' original attribution\n');
        await writeFile(join(path, 'THIRD_PARTY_NOTICES.md'), name + ' dependency notices\n');
    }
    const before = await readFile(join(root, 'node_modules/@motionharness/studio/LICENSE'), 'utf8');
    const text = await buildStudioLicenseText(root, '0.1.8');
    for (const name of ['studio', 'core', 'sdk', 'ui']) {
        expect(text).toContain(name + ' original license\n');
        expect(text).toContain(name + ' original attribution\n');
        expect(text).toContain(name + ' dependency notices\n');
        expect(text).toContain(`"name":"@motionharness/${name}","version":"${name === 'sdk' ? '0.1.8' : '1.0.0'}"`);
    }
    expect(text).toContain('git+https://github.com/MotionHarness/motionharness.git');
    expect(text).toContain('Paws adapter changes, 2026-11-26');
    expect(text).toContain('Replace CompositionStudio view-context interval reporting');
    expect(text).toContain('studioHostEntry.ts');
    expect(text).toContain('not a pinned source archive');
    expect(text).toContain('does not establish availability or completeness');
    expect(text).not.toContain(root);
    expect(await readFile(join(root, 'node_modules/@motionharness/studio/LICENSE'), 'utf8')).toBe(before);
});

it('explicitly reports absent optional packages and notice files', async () => {
    const root = await runtime();
    await packageAt(root, 'studio');
    const text = await buildStudioLicenseText(root, '0.1.8');
    expect(text).toContain('@motionharness/core');
    expect(text).toContain('Package metadata: not present in the selected runtime.');
    expect(text).toContain('--- @motionharness/studio/NOTICE ---\nOptional notice file: not present');
    expect(text).toContain('studio original license');
});

it('requires the original Studio license rather than silently producing a partial download', async () => {
    const root = await runtime();
    const path = await packageAt(root, 'studio');
    await rm(join(path, 'LICENSE'));
    await expect(buildStudioLicenseText(root, '0.1.8')).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(path, 'LICENSE'), '   ');
    await expect(buildStudioLicenseText(root, '0.1.8')).rejects.toThrow('Required editor license is empty');
});

it('bounds individual notice files, metadata and the combined archive', async () => {
    const root = await runtime();
    const studio = await packageAt(root, 'studio');
    await writeFile(join(studio, 'NOTICE'), Buffer.alloc(256 * 1024 + 1, 65));
    await expect(buildStudioLicenseText(root, '0.1.8')).rejects.toThrow('size limit');
    await rm(join(studio, 'NOTICE'));
    const metadata = await readFile(join(studio, 'package.json'));
    await writeFile(join(studio, 'package.json'), Buffer.alloc(64 * 1024 + 1, 65));
    await expect(buildStudioLicenseText(root, '0.1.8')).rejects.toThrow('size limit');
    await writeFile(join(studio, 'package.json'), metadata);
    for (const name of ['studio', 'core', 'sdk', 'ui']) {
        const path = name === 'studio' ? studio : await packageAt(root, name);
        await writeFile(join(path, 'NOTICE'), Buffer.alloc(256 * 1024, 65));
    }
    await expect(buildStudioLicenseText(root, '0.1.8')).rejects.toThrow('combined size limit');
});

it('does not disclose private paths or credentials from repository metadata', async () => {
    const root = await runtime();
    await packageAt(root, 'studio', '1.0.0', 'https://user:repository-secret@github.com/MotionHarness/motionharness.git');
    await packageAt(root, 'core', '1.0.0', '/private/source/checkout');
    await packageAt(root, 'sdk', '0.1.8', 'https://github.com/MotionHarness/motionharness.git?token=query-secret');
    const text = await buildStudioLicenseText(root, '0.1.8');
    expect(text).not.toContain('repository-secret');
    expect(text).not.toContain('query-secret');
    expect(text).not.toContain('/private/source/checkout');
    expect(text).toContain('No public repository reference included');
});
