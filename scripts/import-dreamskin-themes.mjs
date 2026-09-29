#!/usr/bin/env node

// Curated, repeatable import of the four DreamSkin packages selected for Paws.
// Their CSS targets DreamSkin-only data-ds-part elements; the Paws runtime maps
// the verified palette to its own semantic tokens instead of injecting that CSS.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicSkins = join(root, 'packages/happy-app/public/desktop-skins');
const generatedCatalog = join(root, 'packages/happy-app/sources/importedDesktopSkins.generated.ts');
const assetManifest = join(root, 'scripts/desktop-skin-assets.json');
const sources = [
    { id: 'wukong', assetId: 'wukong', versionId: 'ver_ab667004dad5bfec326d', zipSha256: 'b2892300bdfb1229a092c140c5fd5de41fa27b97db6ec7e827c3ae0f9d75af44' },
    { id: 'firefly', assetId: 'firefly', versionId: 'ver_db0516661b1ac5bc1590', zipSha256: 'ff29404d4b277075c3a01dbecc63ddc3856ac5a601f97443fa7bee3c4f55c381' },
    { id: 'evaWarm', assetId: 'eva-warm', versionId: 'ver_f836b53d9df32ab8ecf7', zipSha256: '8fc427b28e2dd696b3cf35640fa05fc0c1ab7008bfb343f6c6aa6ebab1cd1696' },
    { id: 'meadowSky', assetId: 'meadow-sky', versionId: 'ver_2da9f883d79a7bb3864b', zipSha256: '1f23f1457ade893cf1ff1b9a8829c2796a6eec9b6680151dc8eeed99b34f6007' },
];
const existing = [
    { id: 'dreamskin', assetId: 'dreamskin' },
    { id: 'warmNight', assetId: 'warm-night' },
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (command, args, options = {}) => execFileSync(command, args, { maxBuffer: 20 * 1024 * 1024, ...options });
const fail = (message) => { throw new Error(message); };

function readZipEntry(archive, name) {
    if (!/^[a-z][a-z0-9.]*$/i.test(name)) fail(`unsafe ZIP entry: ${name}`);
    return run('unzip', ['-p', archive, name]);
}

async function writeExpected(path, bytes, check) {
    if (check) {
        const current = await readFile(path).catch(() => null);
        if (!current?.equals(bytes)) fail(`generated output differs: ${path}`);
        return;
    }
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, bytes);
}

async function singleBackground(assetId) {
    const names = (await readdir(join(publicSkins, assetId))).filter((name) => /^background\.[0-9a-f]{16}\.webp$/.test(name));
    if (names.length !== 1) fail(`${assetId}: expected exactly one hashed WebP`);
    const bytes = await readFile(join(publicSkins, assetId, names[0]));
    if (sha256(bytes).slice(0, 16) !== names[0].split('.')[1]) fail(`${assetId}: background hash mismatch`);
    return names[0];
}

const archiveDirArgument = process.argv.indexOf('--archive-dir');
const archiveDir = archiveDirArgument === -1 ? null : process.argv[archiveDirArgument + 1];
const check = process.argv.includes('--check');
if (archiveDirArgument !== -1 && (!archiveDir || archiveDir.startsWith('--'))) fail('--archive-dir requires a directory');
const temporary = await mkdtemp(join(tmpdir(), 'paws-dreamskin-import-'));

try {
    const imported = [];
    const assets = [];
    for (const spec of existing) assets.push({ ...spec, filename: await singleBackground(spec.assetId) });
    for (const spec of sources) {
        const archive = archiveDir ? join(archiveDir, `${spec.versionId.slice(4)}.zip`) : join(temporary, `${spec.id}.zip`);
        if (!archiveDir) run('curl', ['-fsSL', '--retry', '3', '--retry-all-errors', '--retry-delay', '2', '--max-time', '90', `https://api.dreamskin.cc/v1/themes/${spec.versionId}/download`, '-o', archive], { timeout: 110_000 });
        const archiveHash = sha256(await readFile(archive));
        if (archiveHash !== spec.zipSha256) fail(`${spec.versionId}: ZIP SHA-256 mismatch (${archiveHash})`);
        const manifest = JSON.parse(readZipEntry(archive, 'manifest.json').toString('utf8'));
        const themeBytes = readZipEntry(archive, 'theme.json');
        const theme = JSON.parse(themeBytes.toString('utf8'));
        if (manifest.packageVersion !== 1 || theme.schemaVersion !== 1 || manifest.themeId !== theme.id || !['light', 'dark'].includes(theme.appearance)) fail(`${spec.versionId}: unsupported theme package`);
        if (!/^background\.(?:png|jpe?g|webp)$/.test(theme.image)) fail(`${spec.versionId}: invalid background filename`);
        for (const file of manifest.files) {
            const data = readZipEntry(archive, file.path);
            if (data.length !== file.bytes || sha256(data) !== file.sha256) fail(`${spec.versionId}: corrupt ${file.path}`);
        }
        const sourceImage = join(temporary, theme.image);
        const compressedImage = join(temporary, `${spec.id}.webp`);
        await writeFile(sourceImage, readZipEntry(archive, theme.image));
        // All four pinned source images exceed 1920 px. This keeps the same
        // composition while avoiding 4K decoding for a desktop background.
        run('cwebp', ['-quiet', '-q', '82', '-m', '6', '-resize', '1920', '0', sourceImage, '-o', compressedImage]);
        const image = await readFile(compressedImage);
        const filename = `background.${sha256(image).slice(0, 16)}.webp`;
        const targetDir = join(publicSkins, spec.assetId);
        if (check) {
            await writeExpected(join(targetDir, filename), image, true);
        } else {
            await mkdir(targetDir, { recursive: true });
            for (const name of await readdir(targetDir)) if (name.startsWith('background.')) await rm(join(targetDir, name));
            await writeExpected(join(targetDir, filename), image, false);
        }
        assets.push({ id: spec.id, assetId: spec.assetId, filename });
        imported.push({
            id: spec.id,
            assetId: spec.assetId,
            sourceVersionId: spec.versionId,
            name: theme.name,
            publisher: manifest.publisher.displayName,
            license: manifest.license,
            appearance: theme.appearance,
            backgroundUrl: `/desktop-skins/${spec.assetId}/${filename}`,
            focusX: theme.art.focusX,
            focusY: theme.art.focusY,
            colors: theme.colors,
        });
        console.log(`${spec.id}: ${image.length} bytes, ${filename}`);
    }
    const catalog = Buffer.from(`// Generated by scripts/import-dreamskin-themes.mjs; do not edit by hand.\nexport const importedDesktopSkins = ${JSON.stringify(imported, null, 4)} as const;\n`);
    const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, skins: assets }, null, 2)}\n`);
    await writeExpected(generatedCatalog, catalog, check);
    await writeExpected(assetManifest, manifest, check);
} finally {
    await rm(temporary, { recursive: true, force: true });
}
