import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function integrateBotsAssets(root, development = false) {
    const source = resolve(root, 'packages/paws-bots/apps/web/dist-embedded');
    const dist = resolve(root, development ? 'packages/happy-app/public' : 'packages/happy-app/dist');
    const files = {};
    const directory = development ? "bots-assets" : "assets/bots";
    for (const extension of ['js', 'css']) {
        const content = readFileSync(resolve(source, `bots.${extension}`));
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 20);
        const path = `${directory}/bots-${hash}.${extension}`;
        mkdirSync(resolve(dist, directory), { recursive: true });
        copyFileSync(resolve(source, `bots.${extension}`), resolve(dist, path));
        files[extension] = `/${path}`;
    }
    if (development) { writeFileSync(resolve(dist, directory, 'manifest.json'), JSON.stringify(files)); return files; }
    // Expo copies public/ wholesale; dev manifests and old bundles are not release assets.
    rmSync(resolve(dist, 'bots-assets'), { recursive: true, force: true });
    const index = resolve(dist, 'index.html');
    let html = readFileSync(index, 'utf8').replace(/<meta name="paws-bots-(?:entry|style)"[^>]*>/g, '');
    html = html.replace('</head>', `<meta name="paws-bots-entry" content="${files.js}"><meta name="paws-bots-style" content="${files.css}"></head>`);
    writeFileSync(index, html);
    return files;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = resolve(import.meta.dirname, '..');
    const build = spawnSync('pnpm', ['--filter', '@rakazo/web', 'build:embedded'], { cwd: root, stdio: 'inherit', env: process.env });
    if (build.status !== 0) process.exit(build.status ?? 1);
    console.log('Bots workspace assets integrated:', integrateBotsAssets(root, process.argv.includes('--dev')));
}
