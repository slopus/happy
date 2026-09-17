import type { Engine } from '../contracts.js';

/** A configured agent as it appears inside one room. */
export type RoomMember = {
  id: string;
  name: string;
  instructions: string;
  engine: Engine;
};

export type MentionRouting = {
  mode: 'mention' | 'auto' | 'quiet' | 'invalid';
  ids: string[];
  unknown: string[];
};

/**
 * Resolve who is allowed to answer a room message.
 *
 * An explicit @ is deliberately a hard boundary: a typo or a person outside
 * this room must never silently wake a different agent through auto-routing.
 */
export function resolveMentionTargets(text: string, members: readonly RoomMember[], autoReply: boolean): MentionRouting {
  const mentions = parseMentions(text);
  if (mentions.length > 0) {
    const byName = new Map(members.map(member => [member.name, member]));
    const ids: string[] = [];
    const unknown: string[] = [];
    for (const name of mentions) {
      const member = byName.get(name);
      if (!member) {
        if (!unknown.includes(name)) unknown.push(name);
        continue;
      }
      if (!ids.includes(member.id)) ids.push(member.id);
    }
    return unknown.length > 0 ? { mode: 'invalid', ids: [], unknown } : { mode: 'mention', ids, unknown: [] };
  }

  if (!autoReply) return { mode: 'quiet', ids: [], unknown: [] };
  const member = chooseRelevantMember(text, members);
  return member ? { mode: 'auto', ids: [member.id], unknown: [] } : { mode: 'quiet', ids: [], unknown: [] };
}

export function parseMentions(text: string): string[] {
  const mentions: string[] = [];
  // Names may be Chinese or Latin; stop at ordinary prose separators and @.
  const matcher = /@([^\s@，。！？、,.!?：:；;（）()【】\[\]{}]+)/gu;
  for (const match of text.matchAll(matcher)) {
    const name = match[1]?.trim();
    if (name && !mentions.includes(name)) mentions.push(name);
  }
  return mentions;
}

function chooseRelevantMember(text: string, members: readonly RoomMember[]): RoomMember | undefined {
  const terms = tokenize(text);
  if (members.length === 0) return undefined;
  const scored = members.map((member, index) => ({
    member,
    index,
    score: [...tokenize(`${member.name} ${member.instructions}`)].reduce((score, token) => score + (terms.has(token) ? 1 : 0), 0),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.member;
}

function tokenize(text: string): Set<string> {
  const normalized = text.toLocaleLowerCase('zh-CN');
  const tokens = new Set(normalized.match(/[\p{L}\p{N}]{2,}/gu) ?? []);
  // Chinese role labels frequently have no spaces, so retain adjacent two-char terms.
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}
