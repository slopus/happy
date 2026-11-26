import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMotionProjectCatalog } from './catalog';
import { resolveMotionProject } from './bridge';

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'paws-motion-catalog-'))); fixtures.push(base);
    const root = join(base, 'workspace'), storage = join(base, 'private-index'); await mkdir(root);
    return { base, root, storage, catalog: createMotionProjectCatalog(root, resolveMotionProject, storage) };
}
async function movie(path: string, title: string) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'mh.json'), JSON.stringify({ version: 3, projectType: 'pro', entry: 'src/project.ts' }));
    await writeFile(join(path, 'document.json'), JSON.stringify({ title, instances: { untouched: true }, revision: 1 }));
}
it('discovers and registers new/imported projects by their saved names without an engine', async () => {
    const { root, storage, catalog } = await fixture();
    await movie(join(root, 'films', 'one'), '宣传片一');
    const before = await readFile(join(root, 'films/one/document.json'), 'utf8');
    expect(await catalog.list()).toMatchObject({ truncated: false, projects: [{ title: '宣传片一', projectPath: join(root, 'films/one') }] });
    const index = join(storage, (await readdir(storage))[0]); expect(await readdir(index)).toHaveLength(1);
    await movie(join(root, 'imported'), '新导入影片');
    const reopened = createMotionProjectCatalog(root, resolveMotionProject, storage);
    expect((await reopened.list()).projects.map(project => project.title).sort()).toEqual(['宣传片一', '新导入影片'].sort());
    expect(await readFile(join(root, 'films/one/document.json'), 'utf8')).toBe(before);
});
it('remembers a deliberately added deep project and refreshes its title from the real document', async () => {
    const { root, catalog } = await fixture(); const deep = join(root, 'a/b/c/d/e/f/g/movie'); await movie(deep, '旧标题');
    expect((await catalog.list()).projects).toHaveLength(0);
    await catalog.register(deep, true);
    await writeFile(join(deep, 'document.json'), '{"title":"界面保存的新标题"}');
    expect((await catalog.list()).projects).toEqual([expect.objectContaining({ title: '界面保存的新标题', lastOpenedAt: expect.any(Number) })]);
    await rm(deep, { recursive: true }); expect((await catalog.list()).projects).toEqual([]);
});
it('does not follow dependency folders, symlink escapes, unsupported projects or malicious registrations', async () => {
    const { base, root, storage, catalog } = await fixture(); const outside = join(base, 'outside'); await movie(outside, '私有工程');
    await symlink(outside, join(root, 'escape'));
    await movie(join(root, 'node_modules/hidden'), '依赖中的工程');
    await movie(join(root, 'wrong'), '不支持'); await writeFile(join(root, 'wrong/mh.json'), '{"version":3,"projectType":"standard"}');
    await movie(join(root, 'valid'), '可用工程'); await catalog.list();
    const folder = join(storage, (await readdir(storage))[0]);
    await writeFile(join(folder, 'f'.repeat(64) + '.json'), JSON.stringify({ projectPath: outside }));
    await expect(catalog.register(outside)).rejects.toMatchObject({ code: 'PROJECT_NOT_ALLOWED' });
    expect((await catalog.list()).projects.map(project => project.title)).toEqual(['可用工程']);
});
it('caps discovery and explicitly reports a partial list', async () => {
    const { root, catalog } = await fixture();
    for (let n = 0; n < 101; n++) await movie(join(root, String(n)), `影片 ${n}`);
    const result = await catalog.list(); expect(result.projects).toHaveLength(100); expect(result.truncated).toBe(true);
});
