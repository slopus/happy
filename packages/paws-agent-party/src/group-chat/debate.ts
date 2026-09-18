import { RunError } from '../server/runs.js';

export type DebateSnapshot = {
  id: string;
  status: 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';
  members: string[];
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

export function validateDebateMembers(members: readonly string[]): void {
  if (members.length < 2 || new Set(members).size !== members.length) throw new RunError(400, 'A debate requires at least two distinct participants without duplicates.');
}

export function debateTurn(debate: DebateSnapshot): { memberId: string; round: number; phase: 'opening' | 'rebuttal' } {
  validateMaxRounds(debate.maxRounds);
  validateDebateMembers(debate.members);
  const memberCount = debate.members.length;
  if (debate.status !== 'running' || debate.completedTurns >= debate.maxRounds * memberCount) throw new RunError(409, 'This debate has no remaining turns.');
  return { memberId: debate.members[debate.completedTurns % memberCount]!, round: Math.floor(debate.completedTurns / memberCount) + 1, phase: debate.completedTurns < memberCount ? 'opening' : 'rebuttal' };
}
