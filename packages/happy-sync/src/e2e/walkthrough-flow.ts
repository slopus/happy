export type WalkthroughStepAction = 'send' | 'stop' | 'cancel' | 'resume' | 'model-switch';

export interface WalkthroughComponentCapture {
    outputBase: string;
    afterPromptMs?: number;
}

export interface WalkthroughStep {
    id: number;
    name: string;
    prompt: string | null;
    action: WalkthroughStepAction;
    timeoutMs: number;
    componentCaptures?: WalkthroughComponentCapture[];
}

export const UX_REVIEW_OUTPUT_DIR = 'e2e-recordings/ux-review';
export const WALKTHROUGH_TRANSCRIPT_SELECTOR = '[data-testid="chat-transcript"]';
export const DEFAULT_INITIAL_RECORDING_DELAY_MS = 10_000;
export const DEFAULT_INTER_STEP_DELAY_MS = 2_000;
export const DEFAULT_CAPTURE_HOLD_MS = 6_000;
export const DEFAULT_FINAL_CAPTURE_MS = 120_000;
export const WALKTHROUGH_REDIRECT_PORT = 19020;

export const WALKTHROUGH_STEPS: WalkthroughStep[] = [
    { id: 0, name: 'Open the agent', prompt: null, action: 'send', timeoutMs: 0 },
    { id: 1, name: 'Orient', prompt: 'Read all files, tell me what this does.', action: 'send', timeoutMs: 120000 },
    { id: 2, name: 'Find the bug', prompt: "There's a bug in the Done filter — it shows all items instead of only completed ones. Find it and show me the exact line.", action: 'send', timeoutMs: 90000 },
    {
        id: 3,
        name: 'Edit rejected',
        prompt: 'Fix it.',
        action: 'send',
        timeoutMs: 180000,
        componentCaptures: [{ outputBase: 'component-permission-prompt-denied' }],
    },
    {
        id: 4,
        name: 'Edit approved once',
        prompt: 'Ok that diff looks right. Go ahead and apply it.',
        action: 'send',
        timeoutMs: 180000,
        componentCaptures: [{ outputBase: 'component-permission-prompt-approve-once' }],
    },
    {
        id: 5,
        name: 'Edit approved always',
        prompt: 'Add dark mode support. Use a `prefers-color-scheme: dark` media query in styles.css. Keep it simple — just invert the main colors.',
        action: 'send',
        timeoutMs: 180000,
        componentCaptures: [{ outputBase: 'component-permission-prompt-approve-always' }],
    },
    { id: 6, name: 'Auto-approved edit', prompt: 'Also add a `.dark-toggle` button to the HTML so users can manually switch themes. Put it after the h1 in the hero panel. Wire it up in app.js — toggle a `dark` class on the body.', action: 'send', timeoutMs: 240000 },
    { id: 7, name: 'Search the web', prompt: 'Search the web for best practices on accessible keyboard shortcuts in todo apps.', action: 'send', timeoutMs: 180000 },
    { id: 8, name: 'Parallel explore', prompt: "I want to add keyboard shortcuts. Before you do anything, use a subagent to explore what keyboard events the app currently handles, and separately check if there are any accessibility issues in the HTML. Do both in parallel.", action: 'send', timeoutMs: 300000 },
    { id: 9, name: 'Simple edit', prompt: "Add Cmd+Enter to submit the form from anywhere on the page. That's it, nothing else.", action: 'send', timeoutMs: 180000 },
    { id: 10, name: 'Cancel', prompt: 'Add keyboard shortcut support — Cmd+Enter to submit from anywhere, Escape to clear the input, arrow keys to navigate todos.', action: 'cancel', timeoutMs: 60000 },
    { id: 11, name: 'Resume after cancel', prompt: 'Ok just the Cmd+Enter. Do that.', action: 'resume', timeoutMs: 180000 },
    {
        id: 12,
        name: 'Agent asks a question',
        prompt: 'I want to add a test framework. Ask me which one I want before you set anything up.',
        action: 'send',
        timeoutMs: 180000,
        componentCaptures: [{ outputBase: 'component-question-prompt' }],
    },
    { id: 13, name: 'Act on the answer', prompt: 'Set up Vitest. Add a vitest config, a package.json with the dev dependency, and one test that verifies the Done filter bug is fixed (the filter should only return items where done===true).', action: 'send', timeoutMs: 300000 },
    { id: 14, name: 'Read outside project', prompt: 'What files are in the parent directory?', action: 'send', timeoutMs: 120000 },
    { id: 15, name: 'Write outside project', prompt: 'Create a file at `../outside-test.txt` with the content "boundary test".', action: 'send', timeoutMs: 120000 },
    { id: 16, name: 'Create todos', prompt: 'Create a todo list for this project. Track: 1) add due dates to todos, 2) add drag-to-reorder, 3) add export to JSON. Use your todo tracking.', action: 'send', timeoutMs: 120000 },
    { id: 17, name: 'Switch and edit', prompt: 'Add a "due date" field to the todo items. Add a date picker input next to the text input in the form. Store the date in localStorage with the item.', action: 'model-switch', timeoutMs: 240000 },
    { id: 18, name: 'Compact', prompt: 'Compact the context.', action: 'send', timeoutMs: 120000 },
    { id: 19, name: 'Post-compaction sanity', prompt: 'What files have we changed so far?', action: 'send', timeoutMs: 120000 },
    { id: 20, name: 'Close', prompt: null, action: 'stop', timeoutMs: 20000 },
    { id: 21, name: 'Reopen', prompt: null, action: 'resume', timeoutMs: 60000 },
    { id: 22, name: 'Verify continuity', prompt: 'What was the last thing we were working on?', action: 'send', timeoutMs: 180000 },
    { id: 23, name: 'Mark todo done', prompt: 'Mark the "add due dates" todo as completed — we just did that.', action: 'send', timeoutMs: 180000 },
    {
        id: 25,
        name: 'Multiple permissions in one turn',
        prompt: 'Refactor the app: extract the filter logic into a new file called `filters.js`, move the dark mode toggle into a new file called `theme.js`, and update app.js to import from both.',
        action: 'send',
        timeoutMs: 240000,
        componentCaptures: [{ outputBase: 'component-multiple-permissions' }],
    },
    { id: 26, name: 'Supersede pending permissions', prompt: 'Actually, undo all that. Put everything back in app.js. Also add a comment at the top: "// single-file architecture".', action: 'send', timeoutMs: 240000 },
    {
        id: 27,
        name: 'Subagent hits a permission wall',
        prompt: 'Use a subagent to add a "clear completed" button. The subagent should edit index.html and app.js. Don\'t auto-approve anything for it.',
        action: 'send',
        timeoutMs: 300000,
        componentCaptures: [{ outputBase: 'component-subagent-permission' }],
    },
    {
        id: 28,
        name: 'Stop session while permission is pending',
        prompt: 'Add a new "priority" field to todos — high, medium, low. Use a colored dot next to each item.',
        action: 'send',
        timeoutMs: 180000,
        componentCaptures: [{ outputBase: 'component-permission-prompt-pending-stop' }],
    },
    { id: 29, name: 'Resume after forced stop', prompt: 'What happened with the priority feature?', action: 'resume', timeoutMs: 240000 },
    { id: 30, name: 'Retry after stop', prompt: 'Try again — add the priority field. Approve everything this time.', action: 'send', timeoutMs: 240000 },
    {
        id: 31,
        name: 'Launch background task',
        prompt: 'Run a background task that sleeps for 30 seconds and then echoes "lol i am donezen". While it\'s running, tell me what time it is.',
        action: 'send',
        timeoutMs: 180000,
        componentCaptures: [{ outputBase: 'component-background-running', afterPromptMs: 10000 }],
    },
    { id: 32, name: 'Background task completes', prompt: 'Did that background task finish? What was the output?', action: 'send', timeoutMs: 240000 },
    {
        id: 33,
        name: 'Interact during background task',
        prompt: 'Run another background task: sleep 20 && echo "background two". While that\'s running, add a comment to the top of app.js saying "// background task test".',
        action: 'send',
        timeoutMs: 240000,
    },
    { id: 34, name: 'Full summary', prompt: 'Give me a git-style summary of everything we changed so far. List files modified, lines added/removed if you can tell.', action: 'send', timeoutMs: 300000 },
    {
        id: 35,
        name: 'Background subagent (TaskCreate)',
        prompt: 'Launch a background agent task: have it research what CSS frameworks would work well for this project. Don\'t wait for it — tell me about the current project structure while it works.',
        action: 'send',
        timeoutMs: 360000,
    },
    { id: 36, name: 'Check background agent result (TaskOutput)', prompt: 'Did that background research finish? What did it find?', action: 'send', timeoutMs: 360000 },
    {
        id: 37,
        name: 'Multiple background tasks',
        prompt: 'Launch two background tasks in parallel: one to check if our HTML is valid, another to analyze our CSS for unused rules. While they run, add a comment to app.js saying "// multi-task test".',
        action: 'send',
        timeoutMs: 360000,
    },
    { id: 38, name: 'Final summary', prompt: 'Update your earlier summary with everything we did since then, including the background tasks. Give me the final git-style summary.', action: 'send', timeoutMs: 300000 },
];

export function sanitizeSegment(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-');
}

export function stepFileBase(step: WalkthroughStep): string {
    return `step-${String(step.id).padStart(2, '0')}-${sanitizeSegment(step.name)}`;
}

export function parseStepBoundary(value: string | undefined): number | null {
    if (!value) {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

export function filterWalkthroughSteps(
    steps: WalkthroughStep[],
    startStepId: number | null,
    endStepId: number | null,
): WalkthroughStep[] {
    return steps.filter((step) => {
        if (startStepId !== null && step.id < startStepId) {
            return false;
        }
        if (endStepId !== null && step.id > endStepId) {
            return false;
        }
        return true;
    });
}

export function getNextPromptStep(steps: WalkthroughStep[], currentIndex: number): WalkthroughStep | null {
    for (let index = currentIndex + 1; index < steps.length; index += 1) {
        if (steps[index]?.prompt) {
            return steps[index];
        }
    }
    return null;
}
