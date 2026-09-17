import { RunError } from '../server/runs.js';

export type DebateSnapshot = {
  id: string;
  status: 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';
  members: [string, string];
  maxRounds: number;
  completedRounds: number;
  completedTurns: number;
  currentTurn: number;
  nextMemberId: string | null;
  sourceMessageId: string;
  stopReason?: string;
  terminalMessageId?: string;
};

export function validateMaxRounds(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) throw new RunError(400, 'maxRounds must be an integer from 1 to 10.');
}

export function debateTurn(debate: DebateSnapshot): { memberId: string; round: number; phase: 'opening' | 'rebuttal' } {
  validateMaxRounds(debate.maxRounds);
  if (debate.status !== 'running' || debate.completedTurns >= debate.maxRounds * 2) throw new RunError(409, 'This debate has no remaining turns.');
  return { memberId: debate.members[debate.completedTurns % 2]!, round: Math.floor(debate.completedTurns / 2) + 1, phase: debate.completedTurns < 2 ? 'opening' : 'rebuttal' };
}
