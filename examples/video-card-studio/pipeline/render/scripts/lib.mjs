import { readFile } from 'node:fs/promises';

export function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') throw new Error('时间必须是秒数或时:分:秒');
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)
    || parts.slice(1).some(n => n >= 60)) throw new Error(`无效时间：${value}`);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function normalizeTranscript(data, format = 'json') {
  let rows;
  if (format === 'json') {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    rows = Array.isArray(parsed) ? parsed : parsed.segments ?? parsed.body;
  } else {
    // 同时支持 SRT 与 WebVTT，保留多行字幕，忽略样式提示和注释。
    rows = [];
    for (const block of data.replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = block.trim().split('\n');
      const at = lines.findIndex(l => l.includes('-->'));
      if (at < 0) continue;
      const [start, end] = lines[at].split('-->').map(s => s.trim().split(/\s/)[0]);
      rows.push({ start: timestamp(start), end: timestamp(end), text: lines.slice(at + 1).join(' ').replace(/<[^>]+>/g, '') });
    }
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error('字幕没有带时间戳的片段');
  return rows.map((row, i) => {
    const start = timestamp(row.start ?? row.from);
    const end = timestamp(row.end ?? row.to);
    const text = String(row.text ?? row.content ?? '').trim();
    if (end <= start || !text) throw new Error(`字幕第 ${i + 1} 段内容或时间无效`);
    return { id: `s${String(i + 1).padStart(4, '0')}`, start, end, text };
  }).sort((a, b) => a.start - b.start).map((s, i) => ({ ...s, id: `s${String(i + 1).padStart(4, '0')}` }));
}

export const clock = seconds => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

export function toSrt(segments) {
  return segments.map((s, i) => `${i + 1}\n${clock(s.start)} --> ${clock(s.end)}\n${s.text}\n`).join('\n');
}

export function validatePlan(plan, segments, source) {
  if (!Array.isArray(plan.cards) || !plan.cards.length) throw new Error('计划必须包含 cards');
  const ids = new Set();
  const byId = new Map(segments.map(s => [s.id, s]));
  const evidence = [];
  const visual = (v, selected, where) => {
    if (!v) return;
    const time = timestamp(v.time);
    if (time > source.duration || !selected.some(s => time >= s.start && time <= s.end)) {
      throw new Error(`${where} 的画面时间不在引用字幕内；请给画面补充独立 evidence`);
    }
    if (!['speaker', 'chart', 'demonstration', 'scene'].includes(v.role) || !v.reason?.trim()) {
      throw new Error(`${where} 缺少画面作用或选取理由`);
    }
  };
  const select = (refs, where) => {
    if (!Array.isArray(refs) || !refs.length) throw new Error(`${where} 没有字幕依据`);
    return refs.map(id => { if (!byId.has(id)) throw new Error(`不存在的字幕：${id}`); return byId.get(id); });
  };
  for (const card of plan.cards) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(card.id) || ids.has(card.id)) throw new Error('卡片 id 必须唯一且使用 kebab-case');
    ids.add(card.id);
    if (['title', 'subtitle', 'takeaway', 'theme'].some(key => key in card)) throw new Error('只叠加原字幕，不接受标题、总结或主题排版');
    if (!card.blocks?.length) throw new Error(`${card.id} 缺少字幕片段`);
    const all = [];
    for (const [i, block] of card.blocks.entries()) {
      if (['heading', 'text', 'quote', 'caption'].some(key => key in block)) throw new Error('字幕文字必须从evidence指定的原片段读取，不能另外填写正文');
      const selected = select(block.evidence, `${card.id} 第 ${i + 1} 段`);
      if ('excerpts' in block) {
        if (!block.excerpts || typeof block.excerpts !== 'object' || Array.isArray(block.excerpts)) throw new Error('摘选必须按字幕ID提供原句连续子串');
        for (const [id, text] of Object.entries(block.excerpts)) {
          if (!block.evidence.includes(id) || typeof text !== 'string' || !text.trim() || !byId.get(id).text.includes(text)) {
            throw new Error('摘选必须是已引用字幕的非空连续原文，不能改写');
          }
        }
      }
      all.push(...selected);
      if (selected.some((s, i) => i && s.start < selected[i - 1].start) || new Set(block.evidence).size !== block.evidence.length) throw new Error('同一片段字幕须按原顺序，不能重复');
      if (selected.some(s => s.end > source.duration + 0.5)) throw new Error('字幕时间超过视频时长');
      if (block.visual) visual(block.visual, block.visual.evidence ? select(block.visual.evidence, '画面') : selected, card.id);
      evidence.push({ card: card.id, block: i, segments: selected, ...(block.excerpts ? { excerpts: block.excerpts } : {}), visual: block.visual ?? card.visual ?? null });
    }
    if (!card.visual && !card.blocks.some(b => b.visual)) throw new Error(`${card.id} 没有对应画面`);
    if (card.visual) visual(card.visual, card.visual.evidence ? select(card.visual.evidence, '主画面') : all, card.id);
  }
  return evidence;
}

export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
