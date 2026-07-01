/**
 * Zod schemas + TypeScript types for `.ax/state.json` — the workspace SoT
 * for the AX Studio step workflow (plan / design / work / free).
 *
 * Shape mirrors specs/20260519-start-from-planning/spec.md §"Data Structure / API"
 * with specs/20260522-ax-step-free-mode adjustments (free step + permissions
 * field removal).
 */

import { z } from 'zod';

export const AxStepSchema = z.enum(['plan', 'design', 'work', 'free']);
export type AxStep = z.infer<typeof AxStepSchema>;

export const CandidatesSourceSchema = z.enum(['claude-suggested', 'user-picked']);
export type CandidatesSource = z.infer<typeof CandidatesSourceSchema>;

const IsoOrNullSchema = z.string().datetime().nullable();

export const HistoryEntrySchema = z.object({
    from: AxStepSchema.nullable(),
    to: AxStepSchema,
    at: z.string().datetime(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const AxStateSchema = z.object({
    version: z.literal(1),
    step: AxStepSchema,
    plan: z.object({
        filePath: z.string(),
        completedAt: IsoOrNullSchema,
    }),
    design: z.object({
        candidates: z.array(z.string()).max(10),
        candidatesSource: CandidatesSourceSchema,
        selected: z.string().nullable(),
        filePath: z.string(),
        completedAt: IsoOrNullSchema,
    }),
    work: z.object({
        startedAt: IsoOrNullSchema,
    }),
    history: z.array(HistoryEntrySchema),
});
export type AxState = z.infer<typeof AxStateSchema>;

export const PLAN_MD_FILENAME = 'specs/[feature-slug]/prd.md';
export const DESIGN_MD_FILENAME = 'AX_STUDIO_DESIGN.md';

export function createInitialState(step: AxStep, now: Date = new Date()): AxState {
    const at = now.toISOString();
    return {
        version: 1,
        step,
        plan: { filePath: PLAN_MD_FILENAME, completedAt: null },
        design: {
            candidates: [],
            candidatesSource: 'claude-suggested',
            selected: null,
            filePath: DESIGN_MD_FILENAME,
            completedAt: null,
        },
        work: {
            startedAt: null,
        },
        history: [{ from: null, to: step, at }],
    };
}
