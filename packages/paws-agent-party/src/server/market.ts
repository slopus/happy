import type { RoleId } from '../contracts.js';

const SYNTHETIC_MARKET = `SYNTHETIC MARKET DATA — testing context, not a live feed
Instrument: PAWS-DEMO perpetual (fictional)
30-minute: last 102.40; EMA20 101.85; EMA50 100.90; volume 1.18× synthetic baseline
10-minute: range 101.70–102.65; VWAP 102.05; two rejected tests of 102.60
1-minute: last five closes 102.08, 102.21, 102.18, 102.36, 102.40; spread 0.04
30-second: unavailable — do not infer or fabricate it
This snapshot is fixed, synthetic, and not suitable for trading.`;

const ROLE_FOCUS: Record<RoleId, string> = {
  moderator: 'Frame the discussion, reconcile disagreements, and state uncertainty.',
  trend30: 'Focus on the 30-minute trend evidence and its explicit limits.',
  structure10: 'Focus on the 10-minute structure. This evidence is insufficient to confirm a complete Chan-theory structure; do not invent strokes, segments, or centers.',
  timing1: 'Focus on 1-minute timing evidence and execution uncertainty; do not infer unavailable 30-second data.',
};

export function rolePrompt(role: RoleId, stock: string, task: string, context = ''): string {
  return [
    `You are the ${role} role in a local Paws AgentParty consultation for ${stock}.`,
    'All market figures below are a fixed synthetic mock dataset, not live data and not investment advice.',
    'Analyze only the supplied synthetic evidence. Do not fetch real-time market data.',
    'Do not place orders or modify project files. Your task is analysis and a public statement only.',
    ROLE_FOCUS[role],
    SYNTHETIC_MARKET,
    task,
    context ? `Party context:\n${context}` : '',
    'Return a concise public statement. Do not reveal tool traces, transport data, credentials, or hidden reasoning.',
  ].filter(Boolean).join('\n\n');
}
