#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const APP_ROOT = path.resolve(SCRIPT_DIR, '..');
const HAPPY_ROOT = path.resolve(APP_ROOT, '..', '..');
const GENERATED_ROOT = path.join(APP_ROOT, 'sources/components/agents');
const PREVIEW_ROOT = path.join(APP_ROOT, 'assets/images/image-effects');
const SNAPSHOT_PATH = path.join(GENERATED_ROOT, 'imageEffectsCatalogSnapshot.json');
const ADAPTER_PATH = path.join(GENERATED_ROOT, 'imageEffectsCatalogAdapter.ts');
const PREVIEW_MANIFEST_PATH = path.join(GENERATED_ROOT, 'imageStylePreviewManifest.ts');
const PREVIEW_ASSETS_PATH = path.join(GENERATED_ROOT, 'imageStylePreviewAssets.ts');
const PUBLIC_REPOSITORY = 'wangjs-jacky/image-effects';
const CATEGORY_START = '// <image-effects-category-meta>';
const CATEGORY_END = '// </image-effects-category-meta>';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertCanonicalSlug(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${label} must be a canonical kebab-case slug`);
  }
  return value;
}

function assertCommit(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return value;
}

export function parseEffectSource(source) {
  if (typeof source !== 'string') throw new TypeError('Effect source must be text');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error('Effect source must contain YAML frontmatter');
  const previewMatch = match[1].match(/^preview_sha256:\s*([0-9a-f]{64})\s*$/m);
  if (!previewMatch) throw new Error('Effect source must declare preview_sha256');
  const promptContent = match[2].trim();
  if (promptContent.length < 1) throw new Error('Effect prompt body must not be empty');
  return { previewSha256: previewMatch[1], promptContent };
}

export function parsePreviewFileNames(source) {
  if (typeof source !== 'string') throw new TypeError('Preview manifest must be text');
  const entries = [...source.matchAll(
    /^\s*'image-effects\/([^']+)':\s*\{\s*fileName:\s*'([^']+)'/gm,
  )].map((match) => [match[1], match[2]]);
  if (entries.length === 0) throw new Error('Preview manifest contains no image-effects entries');
  const result = new Map();
  for (const [ref, fileName] of entries) {
    if (result.has(ref)) throw new Error(`Duplicate preview manifest ref: ${ref}`);
    result.set(ref, fileName);
  }
  return result;
}

function localPreviewFileName(effect, previousByRef) {
  const previous = previousByRef.get(effect.ref);
  if (previous?.previewFileName) return previous.previewFileName;
  return effect.version === '1.0.0'
    ? `${effect.id}.jpg`
    : `${effect.id}--${effect.version}.jpg`;
}

export function buildCatalogSnapshot({
  library,
  metadata,
  sourceRepository,
  sourceCommit,
  canonicalRepository,
  canonicalCommit,
  effectSources,
  previousSnapshot = { effects: [] },
}) {
  assertObject(library, 'Gallery library');
  assertObject(metadata, 'Catalog metadata');
  if (!Array.isArray(library.effects) || library.effects.length === 0) {
    throw new Error('Gallery library must contain effects');
  }
  if (metadata.schemaVersion !== 1) throw new Error('Unsupported catalog metadata schema');
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(metadata.catalogVersion ?? '')) {
    throw new Error('catalogVersion must use YYYY-MM-DD.count');
  }
  if (Number(metadata.catalogVersion.split('.').at(-1)) !== library.effects.length) {
    throw new Error('catalogVersion count must equal the published effect count');
  }
  assertObject(metadata.categories, 'Catalog categories');
  if (!(effectSources instanceof Map)) throw new TypeError('effectSources must be a Map');
  assertCommit(sourceCommit, 'Public source commit');
  assertCommit(canonicalCommit, 'Canonical source commit');

  const previousByRef = new Map((previousSnapshot.effects ?? []).map((effect) => [effect.ref, effect]));
  const seenRefs = new Set();
  const seenPreviewNames = new Set();
  const effects = library.effects.map((effect) => {
    assertObject(effect, 'Catalog effect');
    assertCanonicalSlug(effect.id, 'Effect id');
    if (effect.ref !== `${effect.id}@${effect.version}`) {
      throw new Error(`Effect ref/version mismatch: ${effect.ref}`);
    }
    if (seenRefs.has(effect.ref)) throw new Error(`Duplicate effect ref: ${effect.ref}`);
    seenRefs.add(effect.ref);
    const category = metadata.categories[effect.category];
    if (!category) throw new Error(`Missing category metadata for ${effect.category}`);
    const source = effectSources.get(effect.ref);
    if (!source) throw new Error(`Missing effect source for ${effect.ref}`);
    const previous = previousByRef.get(effect.ref);
    if (
      previous?.sourcePreviewSha256 &&
      previous.sourcePreviewSha256 !== source.previewSha256
    ) {
      throw new Error(`Immutable preview changed without a new version: ${effect.ref}`);
    }
    const previewFileName = localPreviewFileName(effect, previousByRef);
    if (!/^[a-z0-9][a-z0-9.@-]*\.(?:jpg|png)$/.test(previewFileName)) {
      throw new Error(`Unsafe local preview filename: ${previewFileName}`);
    }
    if (seenPreviewNames.has(previewFileName)) {
      throw new Error(`Duplicate local preview filename: ${previewFileName}`);
    }
    seenPreviewNames.add(previewFileName);
    return {
      ref: effect.ref,
      id: effect.id,
      version: effect.version,
      title: { ...effect.title },
      summary: { ...effect.summary },
      category: effect.category,
      executionKind: effect.executionKind,
      input: { ...effect.input, formats: [...effect.input.formats] },
      outputCount: effect.outputCount,
      previewFileName,
      previewWidth: effect.previewWidth,
      previewHeight: effect.previewHeight,
      sourcePreviewSha256: source.previewSha256,
      provenance: structuredClone(effect.provenance),
      promptContent: source.promptContent,
    };
  });

  const publishedCategories = [...new Set(effects.map((effect) => effect.category))].sort();
  const declaredCategories = Object.keys(metadata.categories).sort();
  if (JSON.stringify(publishedCategories) !== JSON.stringify(declaredCategories)) {
    throw new Error('Catalog categories must cover every and only published category');
  }

  return {
    schemaVersion: 1,
    catalogVersion: metadata.catalogVersion,
    catalogDigest: sha256(JSON.stringify(effects)),
    sourceRepository,
    sourceCommit,
    canonicalRepository,
    canonicalCommit,
    effects,
  };
}

export function renderPreviewManifest(snapshot) {
  const lines = snapshot.effects.map((effect, index) => {
    const styleId = `image-effects/${effect.ref}`;
    return `    '${styleId}': { fileName: '${effect.previewFileName}', sourceSet: 'image-effects-snapshot', sourceCaseId: '${effect.ref}', sourceIndex: ${index + 1}, width: ${effect.previewWidth}, height: ${effect.previewHeight} },`;
  });
  return `// Generated from the pinned image-effects build snapshot. Do not edit entries by hand.\n\nexport type ImageStylePreviewEntry = {\n    fileName: \`${'${string}'}.jpg\` | \`${'${string}'}.png\`;\n    sourceSet: 'image-effects-snapshot' | 'gpt-image-2-101' | 'curated-reference-examples' | 'github-skill';\n    sourceCaseId: string;\n    sourceIndex: number;\n    width: number;\n    height: number;\n};\n\nexport const IMAGE_STYLE_PREVIEW_MANIFEST: Record<string, ImageStylePreviewEntry> = {\n${lines.join('\n')}\n};\n`;
}

export function renderPreviewAssets(snapshot) {
  const lines = snapshot.effects.map((effect) => {
    const styleId = `image-effects/${effect.ref}`;
    return `    '${styleId}': require('../../../assets/images/image-effects/${effect.previewFileName}'),`;
  });
  return `// Generated from the pinned image-effects build snapshot. Do not edit entries by hand.\nimport type { ImageSourcePropType } from 'react-native';\n\nconst IMAGE_STYLE_PREVIEW_ASSETS: Record<string, ImageSourcePropType> = {\n${lines.join('\n')}\n};\n\nexport function getImageStylePreviewAsset(styleId: string): ImageSourcePropType | undefined {\n    return IMAGE_STYLE_PREVIEW_ASSETS[styleId];\n}\n`;
}

export function replaceCategoryMetadata(adapterSource, categories) {
  const start = adapterSource.indexOf(CATEGORY_START);
  const end = adapterSource.indexOf(CATEGORY_END);
  if (start < 0 || end < start) throw new Error('Adapter is missing category metadata markers');
  const categoryMeta = Object.fromEntries(
    Object.entries(categories).map(([id, category]) => [id, {
      label: category.title.zh,
      accent: category.accent,
    }]),
  );
  const replacement = `${CATEGORY_START}\nconst CATEGORY_META: Record<string, { label: string; accent: string }> = Object.freeze(${JSON.stringify(categoryMeta, null, 4)});\n${CATEGORY_END}`;
  return `${adapterSource.slice(0, start)}${replacement}${adapterSource.slice(end + CATEGORY_END.length)}`;
}

function decodeImageDimensions(bytes) {
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
  throw new Error('Preview is not a decodable JPEG or PNG');
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function git(root, args) {
  return (await execFile('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
}

async function assertCleanGitRoot(root, label) {
  const canonicalRoot = await realpath(root);
  const gitRoot = await realpath(await git(root, ['rev-parse', '--show-toplevel']));
  if (canonicalRoot !== gitRoot) throw new Error(`${label} must be a Git repository root`);
  const statusOutput = await git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (statusOutput) throw new Error(`${label} must be completely clean`);
  return git(root, ['rev-parse', 'HEAD']);
}

async function loadEffectSources(sourceRoot, library) {
  const entries = await Promise.all(library.effects.map(async (effect) => {
    if (typeof effect.sourceUrl !== 'string' || !effect.sourceUrl.startsWith('./source/')) {
      throw new Error(`Unsafe source URL for ${effect.ref}`);
    }
    const relativePath = effect.sourceUrl.slice(2);
    if (relativePath !== `source/${effect.ref}.md`) {
      throw new Error(`Unexpected source URL for ${effect.ref}`);
    }
    const source = await readFile(path.join(sourceRoot, 'gallery', relativePath), 'utf8');
    return [effect.ref, parseEffectSource(source)];
  }));
  return new Map(entries);
}

async function loadSharp(sourceRoot) {
  const requireFromSource = createRequire(path.join(sourceRoot, 'package.json'));
  const imported = requireFromSource('sharp');
  return imported.default ?? imported;
}

async function desiredPreviewBytes({ sourceRoot, library, snapshot, previousSnapshot }) {
  const previousByRef = new Map((previousSnapshot.effects ?? []).map((effect) => [effect.ref, effect]));
  const libraryByRef = new Map(library.effects.map((effect) => [effect.ref, effect]));
  let sharp;
  const desired = new Map();
  for (const effect of snapshot.effects) {
    const previous = previousByRef.get(effect.ref);
    const existingPath = path.join(PREVIEW_ROOT, effect.previewFileName);
    let bytes;
    if (previous?.previewFileName === effect.previewFileName && await pathExists(existingPath)) {
      bytes = await readFile(existingPath);
    } else {
      const libraryEffect = libraryByRef.get(effect.ref);
      if (!libraryEffect.previewUrl.startsWith('./media/')) {
        throw new Error(`Unsafe preview URL for ${effect.ref}`);
      }
      const sourcePath = path.join(sourceRoot, 'gallery', libraryEffect.previewUrl.slice(2));
      sharp ??= await loadSharp(sourceRoot);
      bytes = await sharp(sourcePath)
        .rotate()
        .jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: '4:2:0' })
        .toBuffer();
    }
    const dimensions = decodeImageDimensions(bytes);
    if (dimensions.width !== effect.previewWidth || dimensions.height !== effect.previewHeight) {
      throw new Error(`Preview dimensions do not match the catalog for ${effect.ref}`);
    }
    desired.set(effect.previewFileName, bytes);
  }
  return desired;
}

async function compareFile(candidate, desired) {
  if (!(await pathExists(candidate))) return false;
  const current = await readFile(candidate);
  return Buffer.compare(current, Buffer.isBuffer(desired) ? desired : Buffer.from(desired)) === 0;
}

async function writeAtomic(candidate, content) {
  await mkdir(path.dirname(candidate), { recursive: true });
  const temporary = `${candidate}.image-effects-sync-${process.pid}`;
  await writeFile(temporary, content);
  await rename(temporary, candidate);
}

function parseArguments(args) {
  let source;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--source') {
      source = args[++index];
    } else if (argument === '--check') {
      check = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!source || !path.isAbsolute(source) || path.resolve(source) !== source) {
    throw new Error('Usage: sync-image-effects-catalog.mjs --source <absolute-public-repo> [--check]');
  }
  return { source, check };
}

export async function syncImageEffectsCatalog({ sourceRoot, check = false }) {
  const canonicalSourceRoot = await realpath(sourceRoot);
  const sourceCommit = await assertCleanGitRoot(canonicalSourceRoot, 'Public image-effects source');
  const happyGitRoot = await realpath(await git(HAPPY_ROOT, ['rev-parse', '--show-toplevel']));
  if (happyGitRoot !== await realpath(HAPPY_ROOT)) throw new Error('Happy target root is invalid');

  const [
    library,
    metadata,
    exportManifest,
    previousSnapshot,
    previousPreviewManifestSource,
    adapterSource,
  ] = await Promise.all([
    readFile(path.join(canonicalSourceRoot, 'gallery/api/library.json'), 'utf8').then(JSON.parse),
    readFile(path.join(canonicalSourceRoot, 'gallery/catalog-metadata.json'), 'utf8').then(JSON.parse),
    readFile(path.join(canonicalSourceRoot, '.image-effects-export.json'), 'utf8').then(JSON.parse),
    readFile(SNAPSHOT_PATH, 'utf8').then(JSON.parse).catch((error) => {
      if (error.code === 'ENOENT') return { effects: [] };
      throw error;
    }),
    readFile(PREVIEW_MANIFEST_PATH, 'utf8'),
    readFile(ADAPTER_PATH, 'utf8'),
  ]);
  if (exportManifest.sourceRepository !== 'wangjs-jacky/jacky-skills') {
    throw new Error('Public export manifest must point to the canonical jacky-skills repository');
  }
  const effectSources = await loadEffectSources(canonicalSourceRoot, library);
  const previousPreviewNames = parsePreviewFileNames(previousPreviewManifestSource);
  const previousSnapshotWithLocalPreviews = {
    ...previousSnapshot,
    effects: (previousSnapshot.effects ?? []).map((effect) => ({
      ...effect,
      previewFileName: previousPreviewNames.get(effect.ref) ?? effect.previewFileName,
    })),
  };
  const snapshot = buildCatalogSnapshot({
    library,
    metadata,
    sourceRepository: PUBLIC_REPOSITORY,
    sourceCommit,
    canonicalRepository: exportManifest.sourceRepository,
    canonicalCommit: exportManifest.sourceCommit,
    effectSources,
    previousSnapshot: previousSnapshotWithLocalPreviews,
  });
  const desiredText = new Map([
    [SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`],
    [ADAPTER_PATH, replaceCategoryMetadata(adapterSource, metadata.categories)],
    [PREVIEW_MANIFEST_PATH, renderPreviewManifest(snapshot)],
    [PREVIEW_ASSETS_PATH, renderPreviewAssets(snapshot)],
  ]);
  const previewBytes = await desiredPreviewBytes({
    sourceRoot: canonicalSourceRoot,
    library,
    snapshot,
    previousSnapshot: previousSnapshotWithLocalPreviews,
  });

  const drift = [];
  for (const [candidate, content] of desiredText) {
    if (!(await compareFile(candidate, content))) drift.push(path.relative(HAPPY_ROOT, candidate));
  }
  const currentPreviewFiles = (await readdir(PREVIEW_ROOT).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter((name) => /\.(?:jpg|png)$/i.test(name));
  for (const [fileName, bytes] of previewBytes) {
    const candidate = path.join(PREVIEW_ROOT, fileName);
    if (!(await compareFile(candidate, bytes))) drift.push(path.relative(HAPPY_ROOT, candidate));
  }
  const stalePreviewFiles = currentPreviewFiles.filter((name) => !previewBytes.has(name));
  drift.push(...stalePreviewFiles.map((name) => path.relative(HAPPY_ROOT, path.join(PREVIEW_ROOT, name))));

  if (check) {
    if (drift.length > 0) {
      throw new Error(`image-effects snapshot is out of date:\n${[...new Set(drift)].sort().join('\n')}`);
    }
    return { changed: false, effectCount: snapshot.effects.length, catalogVersion: snapshot.catalogVersion };
  }
  for (const [candidate, content] of desiredText) await writeAtomic(candidate, content);
  await mkdir(PREVIEW_ROOT, { recursive: true });
  for (const [fileName, bytes] of previewBytes) await writeAtomic(path.join(PREVIEW_ROOT, fileName), bytes);
  for (const fileName of stalePreviewFiles) await rm(path.join(PREVIEW_ROOT, fileName));
  return {
    changed: drift.length > 0,
    effectCount: snapshot.effects.length,
    catalogVersion: snapshot.catalogVersion,
  };
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  return await realpath(process.argv[1]) === await realpath(SCRIPT_PATH);
}

if (await isMainModule()) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await syncImageEffectsCatalog({ sourceRoot: options.source, check: options.check });
    console.log(`${options.check ? 'Verified' : 'Synchronized'} ${result.effectCount} image effects (${result.catalogVersion}).`);
  } catch (error) {
    console.error(`image-effects sync failed: ${error.message}`);
    process.exitCode = 1;
  }
}
