/**
 * Prompt composition for the start-from-planning workflow.
 *
 * Three layers are produced here (Layer 4 is workspace CLAUDE.md, loaded by
 * Claude Code automatically):
 *
 * - L1 (base): inlined `BASE_PROMPT`, injected into the subprocess via
 *   `--append-system-prompt` (idempotent — see `integrate.ts`).
 * - L2 (step guide): one of `STEP_PLAN`/`STEP_DESIGN`/`STEP_WORK`, prepended
 *   each turn.
 * - L3 (dynamic context): a JSON state summary plus the step's attached md
 *   files (plan → none, design → plan, work → plan + design).
 *
 * Missing attachments degrade gracefully — we emit a "not yet created" marker
 * so Claude can decide whether to suggest filling them in.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AxState, AxStep, PLAN_MD_FILENAME, DESIGN_MD_FILENAME } from '../state/schema';
import { BASE_PROMPT, STEP_PLAN, STEP_DESIGN, STEP_WORK } from './assets';

const STEP_GUIDES: Record<AxStep, string> = {
    plan: STEP_PLAN,
    design: STEP_DESIGN,
    work: STEP_WORK,
};

export async function loadBasePrompt(): Promise<string> {
    return BASE_PROMPT;
}

export async function composeStepGuide(step: AxStep): Promise<string> {
    return STEP_GUIDES[step];
}

export async function composeDynamicContext(workspaceRoot: string, state: AxState): Promise<string> {
    const summary = formatStateSummary(state);
    const attachments = await collectAttachments(workspaceRoot, state.step);
    return [
        '<ax-dynamic-context>',
        '',
        '### Current `.ax/state.json`',
        '',
        '```json',
        summary,
        '```',
        ...(attachments.length > 0 ? ['', '### Attachments', '', ...attachments] : []),
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

const STEP_ATTACHMENTS: Record<AxStep, readonly string[]> = {
    plan: [],
    design: [PLAN_MD_FILENAME],
    work: [PLAN_MD_FILENAME, DESIGN_MD_FILENAME],
};

async function collectAttachments(workspaceRoot: string, step: AxStep): Promise<string[]> {
    const out: string[] = [];
    for (const filename of STEP_ATTACHMENTS[step]) {
        const path = join(workspaceRoot, filename);
        try {
            const body = await readFile(path, 'utf8');
            out.push(`#### \`${filename}\``, '', '```markdown', body.trimEnd(), '```', '');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            out.push(`#### \`${filename}\` — not yet created`, '');
        }
    }
    return out;
}
