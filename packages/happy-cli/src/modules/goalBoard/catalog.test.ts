import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { GoalProjectSchema } from '@slopus/happy-wire';
import { catalogSummary, readProjects, projectGithubUrl } from './catalog';

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
        await writeFile(join(project, 'index.md'), '---\ngithub_url: https://github.com/wangjs-jacky/happy.git\n---\n# Paws\n\nProject description.');
        await writeFile(join(feature, 'index.md'), '# Web\n\nChild description.');
        const projects = await readProjects([root]);
        expect(projects).toEqual([expect.objectContaining({ title: 'Paws', githubUrl: 'https://github.com/wangjs-jacky/happy', summary: 'Project description.', features: [expect.objectContaining({ title: 'Web', summary: 'Child description.' })] })]);
    } finally { await rm(root, { recursive: true, force: true }); }
});


it('reads only explicit project frontmatter and normalizes clone URLs', () => {
    expect(projectGithubUrl('---\r\ngithub_url: "https://github.com/owner/repo.git/"\r\n---\r\n# Project')).toBe('https://github.com/owner/repo');
    expect(projectGithubUrl("---\ngithub_url: 'https://github.com/owner/repo'\n---\n# Project")).toBe('https://github.com/owner/repo');
    expect(projectGithubUrl('# Project\ngithub_url: https://github.com/owner/repo')).toBeUndefined();
    expect(projectGithubUrl('---\ngithub_url: https://github.com/a/b\ngithub_url: https://github.com/c/d\n---')).toBeUndefined();
});

it.each(['', 'null', 'javascript:alert(1)', 'http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://user:secret@github.com/a/b', 'https://github.com/a/b/issues', 'https://github.com/a/b?token=secret', 'https://github.com/a/b#readme', 'https://github.com/a/..', 'git@github.com:a/b.git'])(
    'ignores invalid repository metadata without losing the project: %s', value => {
        expect(projectGithubUrl(`---\ngithub_url: ${value}\n---\n# Project`)).toBeUndefined();
        const project = GoalProjectSchema.parse({ projectPath: '/p', title: 'Project', features: [], githubUrl: value });
        expect(project.title).toBe('Project');
        expect(project.githubUrl).toBeUndefined();
    });

it('preserves repository metadata through the wire schema while accepting older projects', () => {
    const old = { projectPath: '/p', title: 'Project', features: [] };
    expect(GoalProjectSchema.parse(old)).toEqual(old);
    expect(GoalProjectSchema.parse({ ...old, githubUrl: 'https://github.com/a/b' }).githubUrl).toBe('https://github.com/a/b');
});
