#!/usr/bin/env node
// Read the downloaded DreamSkin package as design data. Never execute its CSS.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const EXPECTED_ZIP_SHA256 = '3ade08bd0066142f1e97f684f28071dd3fa3a356fe65cf1f397e87f779c633e7';
const EXPECTED_FILES = ['manifest.json', 'theme.json', 'theme.css', 'background.jpg'];
const zipPath = process.argv[2];
if (!zipPath) {
    console.error('Usage: node scripts/inspect-dreamskin-theme.mjs /absolute/path/original.zip');
    process.exit(2);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const zip = readFileSync(zipPath);
if (sha256(zip) !== EXPECTED_ZIP_SHA256) throw new Error('Downloaded ZIP checksum differs from reviewed package');

const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 64 * 1024 })
    .trim().split('\n');
if (entries.length !== EXPECTED_FILES.length || entries.some((entry) => !EXPECTED_FILES.includes(entry))) {
    throw new Error(`Unexpected package entries: ${entries.join(', ')}`);
}
const readEntry = (name, maxBuffer) => execFileSync('unzip', ['-p', zipPath, name], { maxBuffer });
const manifest = JSON.parse(readEntry('manifest.json', 64 * 1024).toString('utf8'));
const theme = JSON.parse(readEntry('theme.json', 64 * 1024).toString('utf8'));
if (manifest.themeId !== 'cecilylove002' || theme.id !== manifest.themeId || theme.appearance !== 'dark') {
    throw new Error('Theme identity or appearance differs from reviewed package');
}
for (const file of manifest.files) {
    if (!EXPECTED_FILES.includes(file.path) || file.path === 'manifest.json') throw new Error(`Unexpected manifest file: ${file.path}`);
    const bytes = readEntry(file.path, Math.max(file.bytes + 1024, 64 * 1024));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
        throw new Error(`File checksum or size mismatch: ${file.path}`);
    }
}
const css = readEntry('theme.css', 64 * 1024).toString('utf8');
if (!/^\s*\[data-ds-part="root"\]\s*\{\s*background-color:\s*var\(--ds-theme-color-background\);\s*\}\s*$/.test(css)) {
    throw new Error('Source CSS differs from the reviewed single-token rule');
}
const upper = (value) => value.toUpperCase();
const normalized = {
    primary: upper(theme.colors.highlight),
    primaryPressed: upper(theme.colors.accentAlt),
    onPrimary: '#101820',
    link: '#9ABCE0',
    bg: upper(theme.colors.background),
    surface: upper(theme.colors.panelAlt),
    surfaceHigh: '#343A41',
    surfaceHighest: '#404A55',
    text: upper(theme.colors.text),
    textSecondary: '#A8AFB8',
    particleA: upper(theme.colors.highlight),
    particleB: upper(theme.colors.secondary),
};
const configUrl = new URL('../sources/desktopSkinTokens.json', import.meta.url);
const configText = `${JSON.stringify(normalized, null, 2)}\n`;
if (process.argv.includes('--write')) writeFileSync(configUrl, configText);
else if (readFileSync(configUrl, 'utf8') !== configText) throw new Error('Reviewed semantic tokens differ from source mapping; run with --write and review the diff');
console.log(JSON.stringify({
    source: { id: theme.id, name: theme.name, version: manifest.version, license: manifest.license, provenance: manifest.provenance, zipSha256: EXPECTED_ZIP_SHA256 },
    colors: theme.colors,
    pawsSemanticTokens: normalized,
    cssUse: 'review only; do not inject',
    backgroundUse: 'quality-92 WebP derivative of the reviewed background.jpg; see asset provenance',
}, null, 2));
