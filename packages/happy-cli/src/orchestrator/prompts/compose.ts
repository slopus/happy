/**
 * Prompt composition for the start-from-planning workflow.
 *
 * Three layers are produced here (Layer 4 is workspace CLAUDE.md, loaded by
 * Claude Code automatically):
 *
 * - L1 (base): inlined `BASE_PROMPT`, injected into the subprocess via
 *   `--append-system-prompt` (idempotent — see `integrate.ts`).
 * - L2 (step guide): one of `STEP_PLAN`/`STEP_DESIGN`/`STEP_WORK`, injected
 *   each turn.
 * - L3 (dynamic context): a JSON state summary plus references to step-related
 *   md files. File bodies are intentionally not embedded every turn; the agent
 *   can read them from disk when the current task needs them.
 *
 * Missing attachments degrade gracefully — we emit a "not yet created" marker
 * so Claude can decide whether to suggest filling them in.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AxState, AxStep, PLAN_MD_FILENAME, DESIGN_MD_FILENAME } from '../state/schema';
import { BASE_PROMPT, STEP_PLAN, STEP_DESIGN, STEP_WORK, STEP_FREE } from './assets';

const STEP_GUIDES: Record<AxStep, string> = {
    plan: STEP_PLAN,
    design: STEP_DESIGN,
    work: STEP_WORK,
    free: STEP_FREE,
};

export async function loadBasePrompt(): Promise<string> {
    return BASE_PROMPT;
}

export async function composeStepGuide(step: AxStep): Promise<string> {
    return STEP_GUIDES[step];
}

export async function composeDynamicContext(workspaceRoot: string, state: AxState): Promise<string> {
    const summary = formatStateSummary(state);
    const references = await collectReferences(workspaceRoot, state.step);
    return [
        '<ax-dynamic-context>',
        '',
        '### Current `.ax/state.json`',
        '',
        '```json',
        summary,
        '```',
        ...(references.length > 0 ? ['', '### Referenced Files', '', ...references] : []),
        '',
        '</ax-dynamic-context>',
        '',
    ].join('\n');
}

function formatStateSummary(state: AxState): string {
    const summary = {
        step: state.step,
        plan: { completedAt: state.plan.completedAt },
        design: {
            candidates: state.design.candidates,
            candidatesSource: state.design.candidatesSource,
            selected: state.design.selected,
            completedAt: state.design.completedAt,
        },
        work: {
            startedAt: state.work.startedAt,
        },
        historyDepth: state.history.length,
    };
    return JSON.stringify(summary, null, 2);
}

const STEP_REFERENCES: Record<AxStep, readonly string[]> = {
    plan: [],
    design: [PLAN_MD_FILENAME],
    work: [PLAN_MD_FILENAME, DESIGN_MD_FILENAME],
    free: [PLAN_MD_FILENAME, DESIGN_MD_FILENAME],
};

async function collectReferences(workspaceRoot: string, step: AxStep): Promise<string[]> {
    const out: string[] = [];
    for (const filename of STEP_REFERENCES[step]) {
        const path = join(workspaceRoot, filename);
        try {
            await readFile(path, 'utf8');
            out.push(`- \`${filename}\` — available in the workspace; read it only when needed for the current task.`);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            out.push(`- \`${filename}\` — not yet created`);
        }
    }
    return out;
}
