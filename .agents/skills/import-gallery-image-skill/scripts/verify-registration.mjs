#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith('--') || !value) {
        throw new Error('Arguments must use --key value pairs.');
    }
    args.set(key.slice(2), value);
}

const requiredArgs = ['style-id', 'repository', 'revision', 'template-ref', 'prompt-path', 'source-case', 'execution-kind', 'input-mode', 'multi-input', 'title-key', 'hint-key', 'preview'];
for (const key of requiredArgs) {
    if (!args.get(key)) throw new Error(`Missing --${key}`);
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const app = join(root, 'packages/happy-app');
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const assertContains = (relativePath, tokens) => {
    const content = read(relativePath);
    for (const token of tokens) {
        if (!content.includes(token)) throw new Error(`${relativePath} is missing: ${token}`);
    }
};

const extractObject = (content, marker) => {
    const markerIndex = content.indexOf(marker);
    if (markerIndex < 0) throw new Error(`Missing record marker: ${marker}`);
    const start = marker.endsWith(':')
        ? content.indexOf('{', markerIndex + marker.length)
        : content.lastIndexOf('{', markerIndex);
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = start; index < content.length; index += 1) {
        const char = content[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") quote = char;
        else if (char === '{') depth += 1;
        else if (char === '}' && --depth === 0) return content.slice(start, index + 1);
    }
    throw new Error(`Unterminated record for: ${marker}`);
};

const assertRecordContains = (relativePath, marker, tokens) => {
    const record = extractObject(read(relativePath), marker);
    for (const token of tokens) {
        if (!record.includes(token)) throw new Error(`${relativePath} record ${marker} is missing: ${token}`);
    }
};

const readStringField = (record, field) => record.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`))?.[1];
const readNumberField = (record, field) => Number(record.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`))?.[1]);
const assertStringField = (record, field, expected, relativePath) => {
    const actual = readStringField(record, field);
    if (actual !== expected) throw new Error(`${relativePath} ${field}: expected ${expected}, received ${actual ?? '<missing>'}`);
};

const hasJpegCommentSegment = (bytes) => {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;

    let offset = 2;
    let inScanData = false;
    while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
        }

        let markerOffset = offset + 1;
        while (bytes[markerOffset] === 0xff) markerOffset += 1;
        const marker = bytes[markerOffset];
        if (marker === undefined) return false;
        if (inScanData && marker === 0x00) {
            offset = markerOffset + 1;
            continue;
        }
        if (inScanData && marker >= 0xd0 && marker <= 0xd7) {
            offset = markerOffset + 1;
            continue;
        }
        if (marker === 0xfe) return true;
        if (marker === 0xd9) return false;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset = markerOffset + 1;
            continue;
        }
        if (markerOffset + 2 >= bytes.length) return false;

        const segmentLength = bytes.readUInt16BE(markerOffset + 1);
        if (segmentLength < 2) return false;
        const nextOffset = markerOffset + 1 + segmentLength;
        if (nextOffset > bytes.length) return false;

        if (marker === 0xda) inScanData = true;
        else if (!(inScanData && marker === 0xdc)) inScanData = false;
        offset = nextOffset;
    }
    return false;
};

const jpegCommentBeforeScanProbe = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x05, 0x41, 0x42, 0x43, 0xff, 0xd9]);
const jpegStuffedAndRestartProbe = Buffer.from([
    0xff, 0xd8,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
    0x11, 0xff, 0x00, 0xfe, 0x22, 0xff, 0xff, 0xd3, 0x33,
    0xff, 0xd9,
]);
const jpegCommentAfterScanProbe = Buffer.from([
    0xff, 0xd8,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
    0x11, 0xff, 0xff, 0xd0, 0x22,
    0xff, 0xc4, 0x00, 0x04, 0xff, 0xfe,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
    0x33, 0xff, 0xd2, 0x44,
    0xff, 0xfe, 0x00, 0x05, 0x41, 0x42, 0x43,
    0xff, 0xd9,
]);
if (!hasJpegCommentSegment(jpegCommentBeforeScanProbe)
    || hasJpegCommentSegment(jpegStuffedAndRestartProbe)
    || !hasJpegCommentSegment(jpegCommentAfterScanProbe)) {
    throw new Error('JPEG COM metadata scanner self-check failed');
}

const decodeDimensions = (bytes) => {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) { offset += 1; continue; }
            const marker = bytes[offset + 1];
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
            }
            if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
            offset += 2 + bytes.readUInt16BE(offset + 2);
        }
    }
    throw new Error('Preview must be a decodable JPEG or PNG');
};

const styleId = args.get('style-id');
const repository = args.get('repository');
const revision = args.get('revision');
const templateRef = args.get('template-ref');
const promptPath = args.get('prompt-path');
const sourceCase = args.get('source-case');
const executionKind = args.get('execution-kind');
const inputMode = args.get('input-mode');
const multiInputMode = args.get('multi-input');
const titleKey = args.get('title-key');
const hintKey = args.get('hint-key');
const preview = args.get('preview');

if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('--revision must be a full 40-character lowercase commit SHA');

const catalogPath = 'packages/happy-app/sources/components/agents/imageStyleCatalogExtras.ts';
const catalogRecord = extractObject(read(catalogPath), `"id": "${styleId}"`);
for (const [field, expected] of Object.entries({
    id: styleId,
    sourceRepository: repository,
    sourceRevision: revision,
    templateRef,
    promptPath,
    sourceCaseId: sourceCase,
    labelKey: titleKey,
    promptHintKey: hintKey,
    executionKind,
    inputMode,
    multiInputMode,
})) assertStringField(catalogRecord, field, expected, catalogPath);
if (args.get('formats')) {
    const actualFormats = [...catalogRecord.matchAll(/"(jpeg|png)"/g)].map((match) => match[1]).join(',');
    if (actualFormats !== args.get('formats')) throw new Error(`${catalogPath} supportedInputFormats: expected ${args.get('formats')}, received ${actualFormats || '<missing>'}`);
}
if (!catalogRecord.includes('"sourceLicenseNotice"')) throw new Error(`${catalogPath} record is missing sourceLicenseNotice`);

const manifestPath = 'packages/happy-app/sources/components/agents/imageStylePreviewManifestExtras.ts';
const manifestRecord = extractObject(read(manifestPath), `"${styleId}":`);
for (const [field, expected] of Object.entries({ fileName: preview, sourceSet: 'github-skill', sourceCaseId: sourceCase })) {
    assertStringField(manifestRecord, field, expected, manifestPath);
}
const assetLine = read('packages/happy-app/sources/components/agents/imageStylePreviewAssetsExtras.ts')
    .split('\n').find((line) => line.includes(`"${styleId}"`));
if (!assetLine?.includes(preview)) throw new Error(`Preview asset map is missing the exact ${styleId} → ${preview} registration`);
assertContains('packages/happy-app/sources/components/agents/imageAgentPrompt.test.ts', [styleId, repository]);
assertContains('packages/happy-app/sources/components/agents/imageStyleOptions.test.ts', [styleId]);

const allLanguages = read('packages/happy-app/sources/text/_all.ts')
    .match(/export type SupportedLanguage = ([^;]+);/)?.[1]
    .match(/'([^']+)'/g)?.map((value) => value.slice(1, -1));
if (!allLanguages?.length) throw new Error('Could not derive supported languages from sources/text/_all.ts');
const translationFiles = [
    'packages/happy-app/sources/text/_default.ts',
    ...allLanguages.map((language) => `packages/happy-app/sources/text/translations/${language}.ts`),
];
for (const file of translationFiles) {
    for (const key of [titleKey, hintKey]) {
        const leaf = key.split('.').at(-1);
        const value = read(file).match(new RegExp(`\\b${leaf}:\\s*(['\\"])(.*?)\\1`))?.[2]?.trim();
        if (!value) throw new Error(`${file} is missing a nonempty translation for ${leaf}`);
    }
}
assertContains('packages/happy-app/sources/components/agents/imageStyleTypes.ts', [titleKey, hintKey]);

const previewPath = join(app, 'sources/assets/images/gpt-image-2/reference-examples', preview);
if (!existsSync(previewPath)) throw new Error(`Preview asset does not exist: ${previewPath}`);
const previewBytes = readFileSync(previewPath);
if (['Exif\0\0', 'http://ns.adobe.com/xap/1.0/', 'eXIf', 'iTXt', 'tEXt', 'zTXt'].some((marker) => previewBytes.includes(Buffer.from(marker)))
    || previewBytes.includes(Buffer.from([0xff, 0xed]))
    || hasJpegCommentSegment(previewBytes)) {
    throw new Error(`Preview asset still contains EXIF/XMP/APP13/COM metadata: ${previewPath}`);
}
const decoded = decodeDimensions(previewBytes);
const declared = { width: readNumberField(manifestRecord, 'width'), height: readNumberField(manifestRecord, 'height') };
if (decoded.width !== declared.width || decoded.height !== declared.height) {
    throw new Error(`Preview dimensions mismatch: decoded ${decoded.width}x${decoded.height}, declared ${declared.width}x${declared.height}`);
}
const siblingIndices = [...read(manifestPath).matchAll(/"sourceSet"\s*:\s*"github-skill"[\s\S]*?"sourceIndex"\s*:\s*(\d+)/g)]
    .map((match) => Number(match[1]));
if (new Set(siblingIndices).size !== siblingIndices.length) throw new Error('github-skill sourceIndex values must be unique');

console.log(`Verified gallery Skill registration: ${styleId}`);
