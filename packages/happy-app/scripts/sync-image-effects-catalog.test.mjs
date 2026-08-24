import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCatalogSnapshot,
  parseEffectSource,
  parsePreviewFileNames,
  renderPreviewAssets,
  renderPreviewManifest,
  replaceCategoryMetadata,
} from './sync-image-effects-catalog.mjs';

const effect = {
  ref: 'paper-scene@1.2.0',
  id: 'paper-scene',
  version: '1.2.0',
  title: { en: 'Paper Scene', zh: '纸感场景' },
  summary: { en: 'A complete summary.', zh: '一段完整摘要。' },
  category: 'editorial',
  executionKind: 'host-image-generation',
  previewWidth: 1200,
  previewHeight: 800,
  input: { mode: 'text-or-image', min: 0, max: 1, formats: ['jpeg', 'png'] },
  outputCount: 1,
  previewUrl: './media/paper-scene@1.2.0.png',
  sourceUrl: './source/paper-scene@1.2.0.md',
  provenance: {
    repository: 'example/source',
    revision: 'a'.repeat(40),
    license: { spdx: 'MIT', url: 'https://example.test/license' },
    preview: { origin: 'Fictional text-only preview.', author: 'owner', licenseSpdx: 'CC-BY-4.0' },
  },
};

test('parses the immutable preview digest and prompt body from an effect source', () => {
  const parsed = parseEffectSource(`---\nid: paper-scene\npreview_sha256: ${'b'.repeat(64)}\n---\n\n## Prompt\n\nKeep the paper texture.\n`);
  assert.equal(parsed.previewSha256, 'b'.repeat(64));
  assert.equal(parsed.promptContent, '## Prompt\n\nKeep the paper texture.');
});

test('inherits local Metro filenames from the generated preview manifest', () => {
  const names = parsePreviewFileNames(`
    'image-effects/paper-scene@1.2.0': { fileName: 'paper-scene.jpg', sourceSet: 'image-effects-snapshot' },
  `);
  assert.equal(names.get('paper-scene@1.2.0'), 'paper-scene.jpg');
});

test('builds a versioned snapshot and preserves an existing local preview name', () => {
  const snapshot = buildCatalogSnapshot({
    library: { schemaVersion: 1, effects: [effect] },
    metadata: {
      schemaVersion: 1,
      catalogVersion: '2026-08-24.1',
      categories: { editorial: { title: { en: 'Editorial', zh: '编辑设计' }, accent: '#B34732' } },
    },
    sourceRepository: 'wangjs-jacky/image-effects',
    sourceCommit: 'c'.repeat(40),
    canonicalRepository: 'wangjs-jacky/jacky-skills',
    canonicalCommit: 'd'.repeat(40),
    effectSources: new Map([[effect.ref, {
      previewSha256: 'b'.repeat(64),
      promptContent: '## Prompt\n\nKeep the paper texture.',
    }]]),
    previousSnapshot: {
      effects: [{ ref: effect.ref, previewFileName: 'paper-scene-custom.jpg' }],
    },
  });

  assert.equal(snapshot.catalogVersion, '2026-08-24.1');
  assert.equal(snapshot.sourceCommit, 'c'.repeat(40));
  assert.equal(snapshot.canonicalCommit, 'd'.repeat(40));
  assert.match(snapshot.catalogDigest, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.effects[0].previewFileName, 'paper-scene-custom.jpg');
  assert.equal(snapshot.effects[0].sourcePreviewSha256, 'b'.repeat(64));
  assert.equal(snapshot.effects[0].promptContent, '## Prompt\n\nKeep the paper texture.');
});

test('renders Metro-safe assets and version-aware preview metadata', () => {
  const snapshot = buildCatalogSnapshot({
    library: { schemaVersion: 1, effects: [effect] },
    metadata: {
      schemaVersion: 1,
      catalogVersion: '2026-08-24.1',
      categories: { editorial: { title: { en: 'Editorial', zh: '编辑设计' }, accent: '#B34732' } },
    },
    sourceRepository: 'wangjs-jacky/image-effects',
    sourceCommit: 'c'.repeat(40),
    canonicalRepository: 'wangjs-jacky/jacky-skills',
    canonicalCommit: 'd'.repeat(40),
    effectSources: new Map([[effect.ref, { previewSha256: 'b'.repeat(64), promptContent: 'Prompt' }]]),
    previousSnapshot: { effects: [] },
  });

  assert.equal(snapshot.effects[0].previewFileName, 'paper-scene--1.2.0.jpg');
  assert.match(renderPreviewAssets(snapshot), /require\('\.\.\/\.\.\/\.\.\/assets\/images\/image-effects\/paper-scene--1\.2\.0\.jpg'\)/);
  assert.match(renderPreviewManifest(snapshot), /sourceCaseId: 'paper-scene@1\.2\.0'/);
});

test('replaces only the generated category metadata block', () => {
  const source = `before\n// <image-effects-category-meta>\nold\n// </image-effects-category-meta>\nafter\n`;
  const updated = replaceCategoryMetadata(source, {
    editorial: { title: { en: 'Editorial', zh: '编辑设计' }, accent: '#B34732' },
  });
  assert.match(updated, /const CATEGORY_META/);
  assert.match(updated, /"label": "编辑设计"/);
  assert.ok(updated.startsWith('before\n'));
  assert.ok(updated.endsWith('after\n'));
});
