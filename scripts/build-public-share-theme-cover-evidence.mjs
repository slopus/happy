import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = resolve(repositoryRoot, 'docs/pr-evidence/public-share-theme-cover');
const rawBeforeRoot = resolve(evidenceRoot, 'raw/before');
const rawCurrentRoot = resolve(evidenceRoot, 'raw/current');
const manifestPath = resolve(evidenceRoot, 'evidence-manifest.json');

const primaryFiles = [
    'case-1-share-dialog-before.png',
    'case-1-share-dialog-after.png',
    'case-2-public-cover-before.png',
    'case-2-public-cover-after.png',
    'case-3-no-cover-before.png',
    'case-3-no-cover-after.png',
    'case-4-gingham-dark-before.png',
    'case-4-gingham-dark-after.png',
];
const supplementalFiles = ['case-3-no-cover-390x844.png'];

function annotation(label, color, height) {
    return Buffer.from(`<svg width="1440" height="900" xmlns="http://www.w3.org/2000/svg">
  <rect x="330" y="8" width="780" height="${height}" rx="8" fill="none" stroke="${color}" stroke-width="4" stroke-dasharray="12 8"/>
  <line x1="306" y1="33" x2="330" y2="33" stroke="${color}" stroke-width="4"/>
  <rect x="16" y="16" width="290" height="34" rx="7" fill="#111827" fill-opacity="0.92" stroke="${color}" stroke-width="2"/>
  <text x="31" y="38" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700">${label}</text>
</svg>`);
}

async function assertDimensions(path, width, height) {
    const metadata = await sharp(path).metadata();
    if (metadata.width !== width || metadata.height !== height) {
        throw new Error(`${path} must be ${width}x${height}, got ${metadata.width}x${metadata.height}`);
    }
}

async function replaceFromSharp(output, pipeline) {
    const temporary = `${output}.evidence.tmp.png`;
    await pipeline.png({ adaptiveFiltering: false, compressionLevel: 9 }).toFile(temporary);
    await rename(temporary, output);
}

async function annotate(input, output, label, color, height) {
    await assertDimensions(input, 1440, 900);
    await replaceFromSharp(output, sharp(input).composite([{ input: annotation(label, color, height) }]));
}

async function sha256(path) {
    return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function artifact(path, relativePath) {
    const metadata = await sharp(path).metadata();
    return {
        file: relativePath,
        height: metadata.height,
        sha256: await sha256(path),
        width: metadata.width,
    };
}

async function build(outputRoot) {
    const outputSupplementalRoot = resolve(outputRoot, 'supplemental');
    await mkdir(outputSupplementalRoot, { recursive: true });
    const case1Before = resolve(rawBeforeRoot, 'case-1-share-dialog-before.png');
    const case1Current = resolve(rawCurrentRoot, 'case-1-share-dialog-after.png');
    await assertDimensions(case1Before, 1440, 900);
    await assertDimensions(case1Current, 1440, 900);
    await copyFile(case1Before, resolve(outputRoot, 'case-1-share-dialog-before.png'));
    await copyFile(case1Current, resolve(outputRoot, 'case-1-share-dialog-after.png'));

    const anonymousBefore = resolve(rawBeforeRoot, 'anonymous-read-only-share-before.png');
    await annotate(anonymousBefore, resolve(outputRoot, 'case-2-public-cover-before.png'), 'CASE 2 · COVER + HEADER', '#2563eb', 340);
    await annotate(resolve(rawCurrentRoot, 'case-2-public-cover-after.png'), resolve(outputRoot, 'case-2-public-cover-after.png'), 'CASE 2 · COVER + HEADER', '#2563eb', 340);
    await annotate(anonymousBefore, resolve(outputRoot, 'case-3-no-cover-before.png'), 'CASE 3 · COVERLESS HEADER', '#16a34a', 78);
    await annotate(resolve(rawCurrentRoot, 'case-3-no-cover-after.png'), resolve(outputRoot, 'case-3-no-cover-after.png'), 'CASE 3 · COVERLESS HEADER', '#16a34a', 78);

    const case4Before = resolve(rawBeforeRoot, 'case-4-copy-before.png');
    await assertDimensions(case4Before, 900, 240);
    await copyFile(case4Before, resolve(outputRoot, 'case-4-gingham-dark-before.png'));
    const case4Current = resolve(rawCurrentRoot, 'case-4-gingham-dark-after.png');
    await assertDimensions(case4Current, 1440, 900);
    await replaceFromSharp(
        resolve(outputRoot, 'case-4-gingham-dark-after.png'),
        sharp(case4Current).extract({ height: 240, left: 270, top: 660, width: 900 }),
    );

    const supplementalInput = resolve(rawCurrentRoot, 'supplemental/case-3-no-cover-390x844.png');
    await assertDimensions(supplementalInput, 390, 844);
    await copyFile(supplementalInput, resolve(outputSupplementalRoot, supplementalFiles[0]));
}

async function collectManifest(root) {
    const supplemental = resolve(root, 'supplemental');
    const actualPrimary = (await readdir(root))
        .filter((name) => name.endsWith('.png'))
        .sort();
    if (JSON.stringify(actualPrimary) !== JSON.stringify([...primaryFiles].sort())) {
        throw new Error(`Expected exactly eight primary PNGs, got: ${actualPrimary.join(', ')}`);
    }
    const actualSupplemental = (await readdir(supplemental))
        .filter((name) => name.endsWith('.png'))
        .sort();
    if (JSON.stringify(actualSupplemental) !== JSON.stringify(supplementalFiles)) {
        throw new Error(`Unexpected supplemental PNG set: ${actualSupplemental.join(', ')}`);
    }

    const artifacts = [];
    for (const filename of primaryFiles) {
        artifacts.push(await artifact(resolve(root, filename), filename));
    }
    for (const filename of supplementalFiles) {
        artifacts.push(await artifact(resolve(supplemental, filename), `supplemental/${filename}`));
    }
    for (const caseNumber of [1, 2, 3, 4]) {
        const before = artifacts.find(({ file }) => file.startsWith(`case-${caseNumber}-`) && file.endsWith('-before.png'));
        const after = artifacts.find(({ file }) => file.startsWith(`case-${caseNumber}-`) && file.endsWith('-after.png'));
        if (!before || !after || before.sha256 === after.sha256) throw new Error(`Case ${caseNumber} Before/After must differ`);
        if (before.width !== after.width || before.height !== after.height) throw new Error(`Case ${caseNumber} dimensions must match`);
    }
    const beforeHashes = artifacts
        .filter(({ file }) => file.endsWith('-before.png'))
        .map(({ sha256: hash }) => hash);
    if (new Set(beforeHashes).size !== 4) throw new Error('All four primary Before artifacts must have distinct hashes');
    return { artifacts, primaryCount: 8, supplementalCount: 1 };
}

async function verify() {
    const generatedRoot = await mkdtemp(resolve(tmpdir(), 'happy-public-share-evidence-'));
    try {
        await build(generatedRoot);
        const generatedManifest = await collectManifest(generatedRoot);
        const trackedManifest = await collectManifest(evidenceRoot);
        const expectedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (
            JSON.stringify(generatedManifest) !== JSON.stringify(expectedManifest)
            || JSON.stringify(trackedManifest) !== JSON.stringify(expectedManifest)
        ) {
            throw new Error('Generated evidence does not match evidence-manifest.json; refresh only after reviewing new raw captures.');
        }
        for (const { file } of generatedManifest.artifacts) {
            const generated = await readFile(resolve(generatedRoot, file));
            const tracked = await readFile(resolve(evidenceRoot, file));
            if (!generated.equals(tracked)) {
                throw new Error(`${file} does not byte-match the evidence generated from tracked raw inputs.`);
            }
        }
        return generatedManifest;
    } finally {
        await rm(generatedRoot, { force: true, recursive: true });
    }
}

async function refreshManifest() {
    await build(evidenceRoot);
    const manifest = await collectManifest(evidenceRoot);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
}

async function main() {
    const [mode, ...extraArguments] = process.argv.slice(2);
    if (extraArguments.length > 0 || !['--refresh-manifest', '--verify'].includes(mode)) {
        throw new Error('Usage: node scripts/build-public-share-theme-cover-evidence.mjs --verify | --refresh-manifest');
    }
    let manifest;
    if (mode === '--refresh-manifest') {
        manifest = await refreshManifest();
    } else {
        manifest = await verify();
    }
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
