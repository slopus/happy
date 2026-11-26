import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { readJSON, writeJSON, digest, run } from './io.mjs';

/** Optional private Image OPS retention; no library records enter public assets. */
export async function archiveCards({ outDir, imageOpsScript, font, signal, emit = () => {}, runner = run }) {
  const [metadata, plan, transcript, cards] = await Promise.all(['metadata.json', 'plan.json', 'transcript.json', 'cards.json'].map(f => readJSON(join(outDir, f))));
  const target = join(outDir, 'image-ops-archive.json');
  let existing;
  try { existing = await readJSON(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const segments = new Map(transcript.segments.map(s => [s.id, s]));
  const records = [];
  for (const card of cards) {
    assert(card.file === `cards/${card.card}.png` && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(card.card), '归档卡片路径无效');
    const bytes = await readFile(join(outDir, card.file)), sha256 = digest(bytes);
    let record = existing?.find(r => r.asset?.sha256 === sha256 && r.run?.parameters?.bvid === metadata.bvid && r.run?.parameters?.card === card.card);
    if (!record) {
      const selected = plan.cards.find(c => c.id === card.card); assert(selected);
      const prompt = JSON.stringify({ method: 'video-to-cards deterministic render', card: selected,
        segments: selected.blocks.flatMap(b => b.evidence.map(id => segments.get(id))), font: basename(font || ''), width: 1080, maxHeight: 12000 });
      const input = { effectRef: 'video-subtitle-cards@1.0.0', prompt, title: `${metadata.title} · ${card.card}`,
        tags: ['原话卡片', 'video-to-cards', '待核对'], executor: 'video-to-cards / FFmpeg / Pillow',
        parameters: { bvid: metadata.bvid, card: card.card, width: '1080', approval: 'review' },
        note: '自动转写，未经逐字听校或用户认可。原片、计划、选帧与引用证据保存在原episode任务。' };
      input.runId = 'run-video-cards-' + digest(JSON.stringify({ ...input, imageSHA256: sha256 }));
      record = JSON.parse(await runner(process.execPath, [imageOpsScript, 'archive', join(outDir, card.file)], { signal, input: JSON.stringify(input) }));
    }
    assert.equal(record.asset.sha256, sha256, '归档图与输出不一致');
    const saved = JSON.parse(await runner(process.execPath, [imageOpsScript, 'asset-get', record.asset.id], { signal }));
    const asset = saved.asset || saved;
    assert.equal(digest(await readFile(asset.path)), sha256, '归档读回不一致');
    records.push(record);
    const completed = new Set(records.map(r => r.run.parameters.card));
    await writeJSON(target, [...records, ...(existing || []).filter(r => !completed.has(r.run?.parameters?.card))]);
  }
  await writeJSON(target, records);
  emit({ bvid: metadata.bvid, phase: 'archive', status: 'retained', images: records.length });
  return { images: records.length, assetIds: records.map(r => r.asset.id) };
}
