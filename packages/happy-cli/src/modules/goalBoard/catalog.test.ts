import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { catalogSummary, readProjects } from './catalog';

it('uses archive prose while omitting status metadata and navigation links', () => {
    expect(catalogSummary('---\nstatus: running\n---\n# Project\n\n[Task](tasks/index.md)\n\n围绕**同一目标**持续交付。\n\n## Tasks')).toBe('围绕同一目标持续交付。');
    expect(catalogSummary('# Project\n\n- [Task](tasks/index.md)')).toBeUndefined();
});

it('returns real project and child-project summaries without importing Task prose', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'paws-project-catalog-')));
    try {
        const project = join(root, 'paws');
        const feature = join(project, 'features', 'web');
        await mkdir(feature, { recursive: true });
        await writeFile(join(project, 'index.md'), '# Paws\n\nProject description.');
        await writeFile(join(feature, 'index.md'), '# Web\n\nChild description.');
        const projects = await readProjects([root]);
        expect(projects).toEqual([expect.objectContaining({ title: 'Paws', summary: 'Project description.', features: [expect.objectContaining({ title: 'Web', summary: 'Child description.' })] })]);
    } finally { await rm(root, { recursive: true, force: true }); }
});
