import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    DEFAULT_CAPTURE_HOLD_MS,
    UX_REVIEW_OUTPUT_DIR,
    WALKTHROUGH_REDIRECT_PORT,
    filterWalkthroughSteps,
    parseStepBoundary,
    stepFileBase,
    WALKTHROUGH_STEPS,
    WALKTHROUGH_TRANSCRIPT_SELECTOR,
    type WalkthroughStep,
} from './packages/happy-sync/src/e2e/walkthrough-flow.ts';

const OUTPUT_DIR = resolve(process.cwd(), UX_REVIEW_OUTPUT_DIR);
const SESSION_URL_FILE = resolve(OUTPUT_DIR, 'session-url.txt');
const STEP_START = parseStepBoundary(process.env.HAPPY_WALKTHROUGH_START_STEP);
const STEP_END = parseStepBoundary(process.env.HAPPY_WALKTHROUGH_END_STEP);
const CAPTURE_HOLD_MS = Number.parseInt(
    process.env.HAPPY_WALKTHROUGH_CAPTURE_HOLD_MS ?? `${DEFAULT_CAPTURE_HOLD_MS}`,
    10,
);
const REDIRECT_PORT = Number.parseInt(
    process.env.HAPPY_WALKTHROUGH_REDIRECT_PORT ?? `${WALKTHROUGH_REDIRECT_PORT}`,
    10,
);

if (!existsSync(SESSION_URL_FILE)) {
    throw new Error(`Missing session URL file: ${SESSION_URL_FILE}`);
}

const sessionUrl = readFileSync(SESSION_URL_FILE, 'utf8').trim();
const activeSteps = filterWalkthroughSteps(WALKTHROUGH_STEPS, STEP_START, STEP_END);

if (!sessionUrl) {
    throw new Error(`Session URL file is empty: ${SESSION_URL_FILE}`);
}

const APP_ORIGIN = new URL(sessionUrl).origin;
const REDIRECT_URL = `http://127.0.0.1:${REDIRECT_PORT}/`;
const WALKTHROUGH_COMPLETED_TEXT = 'Walkthrough Completed';
const runSteps = activeSteps.filter((step) => step.id !== 0);

// Steps that create a new session (resume/reopen) — webreel must navigate
// to the redirect server to pick up the new session URL.
const SESSION_CHANGE_STEP_IDS = new Set([11, 21, 29]);

function stepSyncText(step: WalkthroughStep): string {
    return `Walkthrough Step ${step.id}: ${step.name}`;
}

const steps: Array<Record<string, unknown>> = [
    {
        action: 'navigate',
        url: sessionUrl,
        description: 'Open the live Happy session',
    },
    {
        action: 'pause',
        ms: 1500,
        description: 'Allow the app shell to hydrate',
    },
];

const step0 = activeSteps.find((step) => step.id === 0);
if (step0) {
    const firstRunStep = runSteps[0];
    if (firstRunStep) {
        steps.push({
            action: 'wait',
            text: stepSyncText(firstRunStep),
            timeout: Math.max(firstRunStep.timeoutMs, 120000),
            description: `Wait for Step ${firstRunStep.id} to start`,
        });
    }

    steps.push(
        {
            action: 'scroll',
            y: 99999,
            selector: WALKTHROUGH_TRANSCRIPT_SELECTOR,
            description: 'Jump to the newest transcript content',
        },
        {
            action: 'pause',
            ms: 1500,
            description: 'Hold on the initial session state',
        },
        {
            action: 'screenshot',
            output: `${UX_REVIEW_OUTPUT_DIR}/${stepFileBase(step0)}.png`,
            description: 'Initial session screenshot',
        },
    );
}

for (const [index, step] of runSteps.entries()) {
    // The previous step's completion-wait already looked for stepSyncText(step),
    // so only emit an explicit start-wait for the very first step.  For all later
    // steps the label may have already transitioned away by the time we get here
    // (fast steps like "resume" complete in <3 s), causing a spurious timeout.
    if (index === 0) {
        const startWaitTimeout = Math.max(step.timeoutMs, 120000);
        steps.push({
            action: 'wait',
            text: stepSyncText(step),
            timeout: startWaitTimeout,
            description: `Wait for Step ${step.id} to start`,
        });
    }

    // Session change: navigate to redirect server for the new session URL
    if (SESSION_CHANGE_STEP_IDS.has(step.id)) {
        steps.push(
            {
                action: 'pause',
                ms: 1000,
                description: `Allow session ${step.id} URL to settle`,
            },
            {
                action: 'navigate',
                url: REDIRECT_URL,
                description: `Navigate to new session for Step ${step.id}`,
            },
            {
                action: 'wait',
                text: stepSyncText(step),
                timeout: Math.max(step.timeoutMs, 30000),
                description: `Wait for Step ${step.id} after session redirect`,
            },
            {
                action: 'pause',
                ms: 1500,
                description: `Let new session page hydrate after Step ${step.id}`,
            },
        );
    }

    steps.push({
        action: 'scroll',
        y: 99999,
        selector: WALKTHROUGH_TRANSCRIPT_SELECTOR,
        description: `Follow transcript for Step ${step.id}`,
        delay: 500,
    });

    for (const capture of step.componentCaptures ?? []) {
        steps.push(
            {
                action: 'pause',
                ms: capture.afterPromptMs ?? CAPTURE_HOLD_MS,
                description: `Hold for ${capture.outputBase}`,
            },
            {
                action: 'screenshot',
                output: `${UX_REVIEW_OUTPUT_DIR}/${capture.outputBase}.png`,
                description: `Capture ${capture.outputBase}`,
            },
        );
    }

    const nextStep = runSteps[index + 1];
    // Use step timeout + 120s buffer to account for driver overhead
    // (permission waits, capture holds, inter-step delays, SyncNode propagation)
    const completionTimeout = step.timeoutMs + 120000;
    steps.push({
        action: 'wait',
        text: nextStep ? stepSyncText(nextStep) : WALKTHROUGH_COMPLETED_TEXT,
        timeout: completionTimeout,
        description: nextStep
            ? `Wait for Step ${nextStep.id} before capturing Step ${step.id}`
            : `Wait for walkthrough completion before capturing Step ${step.id}`,
    });

    steps.push(
        {
            action: 'scroll',
            y: 99999,
            selector: WALKTHROUGH_TRANSCRIPT_SELECTOR,
            description: `Scroll to the newest content after Step ${step.id}`,
            delay: 500,
        },
        {
            action: 'pause',
            ms: 1500,
            description: `Hold on Step ${step.id} completion`,
        },
        {
            action: 'screenshot',
            output: `${UX_REVIEW_OUTPUT_DIR}/${stepFileBase(step)}.png`,
            description: `Capture Step ${step.id}`,
        },
    );
}

const config = {
    $schema: 'https://webreel.dev/schema/v1.json',
    outDir: './e2e-recordings/ux-review',
    defaultDelay: 500,
    videos: {
        'happy-walkthrough': {
            url: APP_ORIGIN,
            viewport: 'macbook-pro',
            fps: 30,
            quality: 65,
            output: 'happy-walkthrough.mp4',
            steps,
        },
    },
};

module.exports = config;
