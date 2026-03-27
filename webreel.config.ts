import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    DEFAULT_CAPTURE_HOLD_MS,
    DEFAULT_FINAL_CAPTURE_MS,
    UX_REVIEW_OUTPUT_DIR,
    filterWalkthroughSteps,
    getNextPromptStep,
    parseStepBoundary,
    stepFileBase,
    WALKTHROUGH_STEPS,
    WALKTHROUGH_TRANSCRIPT_SELECTOR,
} from './packages/happy-sync/src/e2e/walkthrough-flow.ts';

const OUTPUT_DIR = resolve(process.cwd(), UX_REVIEW_OUTPUT_DIR);
const SESSION_URL_FILE = resolve(OUTPUT_DIR, 'session-url.txt');
const STEP_START = parseStepBoundary(process.env.HAPPY_WALKTHROUGH_START_STEP);
const STEP_END = parseStepBoundary(process.env.HAPPY_WALKTHROUGH_END_STEP);
const CAPTURE_HOLD_MS = Number.parseInt(
    process.env.HAPPY_WALKTHROUGH_CAPTURE_HOLD_MS ?? `${DEFAULT_CAPTURE_HOLD_MS}`,
    10,
);
const FINAL_CAPTURE_MS = Number.parseInt(
    process.env.HAPPY_WALKTHROUGH_FINAL_CAPTURE_MS ?? `${DEFAULT_FINAL_CAPTURE_MS}`,
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

const runSteps = activeSteps.filter((step) => step.id !== 0);
for (const [index, step] of runSteps.entries()) {
    if (step.prompt) {
        steps.push(
            {
                action: 'wait',
                text: step.prompt,
                timeout: Math.max(step.timeoutMs, 120000),
                description: `Wait for Step ${step.id} prompt`,
            },
            {
                action: 'scroll',
                y: 99999,
                selector: WALKTHROUGH_TRANSCRIPT_SELECTOR,
                description: `Follow transcript for Step ${step.id}`,
                delay: 500,
            },
        );
    }

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

    const nextPromptStep = getNextPromptStep(runSteps, index);
    if (nextPromptStep?.prompt) {
        steps.push({
            action: 'wait',
            text: nextPromptStep.prompt,
            timeout: Math.max(step.timeoutMs, 120000),
            description: `Wait for Step ${nextPromptStep.id} prompt before capturing Step ${step.id}`,
        });
    } else {
        steps.push({
            action: 'pause',
            ms: FINAL_CAPTURE_MS,
            description: `Allow Step ${step.id} to finish before the final capture`,
        });
    }

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
            url: sessionUrl,
            viewport: 'macbook-pro',
            fps: 30,
            quality: 65,
            output: 'happy-walkthrough.mp4',
            steps,
        },
    },
};

module.exports = config;
