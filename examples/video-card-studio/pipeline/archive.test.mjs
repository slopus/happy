import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveCards } from './archive.mjs';
import { digest, readJSON, writeJSON } from './io.mjs';

test('归档中断保留逐卡回执，存储成功而回执未完成时也复用稳定runId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-archive-'));
  try {
    await mkdir(join(dir, 'cards'));
    const cards = ['one', 'two'].map(card => ({ card, file: `cards/${card}.png` }));
    for (const card of cards) await writeFile(join(dir, card.file), card.card);
    await writeJSON(join(dir, 'metadata.json'), { bvid: 'BV1ttykzFERD', title: '测试' });
    await writeJSON(join(dir, 'cards.json'), cards);
    await writeJSON(join(dir, 'plan.json'), { cards: cards.map(c => ({ id: c.card, blocks: [{ evidence: ['s0001'] }] })) });
    await writeJSON(join(dir, 'transcript.json'), { segments: [{ id: 's0001', text: '原句', start: 0, end: 1 }] });
    const runs = new Map(), assets = new Map(); let fail = true;
    const runner = async (_bin, args, options) => {
      if (args[1] === 'archive') {
        const input = JSON.parse(options.input); assert.match(input.runId, /^run-video-cards-[a-f0-9]{64}$/);
        const sha256 = digest(await readFile(args[2]));
        if (!runs.has(input.runId)) { const record = { asset: { id: 'img-' + sha256, sha256, path: args[2] }, run: input }; runs.set(input.runId, record); assets.set(record.asset.id, record.asset); }
        // The library stored card two, but the caller never received its result.
        if (fail && input.parameters.card === 'two') throw new Error('connection lost after save');
        return JSON.stringify(runs.get(input.runId));
      }
      return JSON.stringify(assets.get(args[2]));
    };
    const options = { outDir: dir, imageOpsScript: '/fake/library.mjs', font: '/font.ttc', runner };
    await assert.rejects(archiveCards(options), /connection lost/);
    assert.equal((await readJSON(join(dir, 'image-ops-archive.json'))).length, 1);
    fail = false;
    const result = await archiveCards(options);
    assert.equal(result.images, 2); assert.equal(runs.size, 2);
    assert.equal((await readJSON(join(dir, 'image-ops-archive.json'))).length, 2);
  } finally { await rm(dir, { recursive: true }); }
});
