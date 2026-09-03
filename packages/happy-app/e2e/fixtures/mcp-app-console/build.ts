import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));

export async function buildMcpAppFixtureHtml(): Promise<string> {
    const template = await readFile(join(fixtureDirectory, 'mcp-app.html'), 'utf8');
    const result = await build({
        entryPoints: [join(fixtureDirectory, 'src', 'mcp-app.ts')],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['es2022'],
        write: false,
        outdir: 'out',
        minify: true,
        legalComments: 'none',
        logLevel: 'silent',
        loader: { '.css': 'css' },
    });
    const javascript = result.outputFiles.find((file) => file.path.endsWith('.js'))?.text;
    const css = result.outputFiles.find((file) => file.path.endsWith('.css'))?.text;
    if (!javascript || !css) throw new Error('MCP App fixture build did not emit JavaScript and CSS');
    const html = template
        .replace('<!-- MCP_APP_STYLE -->', () => `<style>${css}</style>`)
        .replace('<!-- MCP_APP_SCRIPT -->', () => `<script>${javascript}</script>`);
    if (![
        'approve-release-readiness',
        'check-service-health',
        'confirm-incident-runbook',
        'preview-deployment-plan',
        'mcp-example-root',
        'mcp-catalog-root',
        'mcp-incident-root',
        'mcp-deployment-root',
    ].every((marker) => html.includes(marker))) {
        throw new Error('MCP App fixture build is missing deterministic markers');
    }
    return html;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void (async () => {
        const output = join(fixtureDirectory, 'dist', 'mcp-app.html');
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, await buildMcpAppFixtureHtml(), 'utf8');
        process.stdout.write('Built deterministic MCP App fixture\n');
    })().catch((error) => {
        console.error(error instanceof Error ? error.message : 'MCP App fixture build failed');
        process.exitCode = 1;
    });
}
