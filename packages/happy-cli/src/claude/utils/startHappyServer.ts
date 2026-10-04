import { registerSessionWriteScopeTools } from '@/daemon/sessionWriteScopeAgentTools';
import { localToolAgentContext, requestLocalToolAgent } from '@/daemon/localToolAgentRelay';
/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 *
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { execFileSync, type ChildProcess } from 'node:child_process';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import type { SessionEnvelope } from "@slopus/happy-wire";
import { runBashStream } from "./bashStream";
import { getActiveBashStreamCall } from "./bashStreamCallRegistry";
import { requestBrowser, readDaemonControlPort, fetchBrowserStatus, BrowserClientError } from "@/daemon/browserClient";
import { runBrowserTool, BROWSER_TOOL_NAMES, type BridgeRequest } from "./browserTools";
import { readFile } from 'node:fs/promises';
import { chmodSync, chownSync, mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { MandatorySandboxError } from '@/sandbox/sandboxPolicy';
import { registerBrowserTaskTools, BROWSER_TASK_TOOL_NAMES } from '@/browserRuntime/agentTools';
import { registerCheckpointAgentTools } from '@/checkpoint/checkpointAgentTools';
import type { CheckpointAgentReader } from '@/checkpoint/checkpointAgentReader';
import { RuntimeClient } from '@/browserRuntime/runtimeClient';
import { createBrokerGrantSource } from '@/browserRuntime/brokerGrantSource';
import { BrowserRuntimeError } from '@/browserRuntime/contracts';

// chat-tool-output-streaming Phase 3 — bash_stream emits its agent-side
// tool name via this constant so per-runner mappers (sessionProtocolMapper
// for Claude, AcpSessionManager for ACP, …) consistently key the call
// registry against the same name.
import { runScriptAutomationTool, scriptAutomationToolRequestSchema } from './scriptAutomationTools';

export const BASH_STREAM_AGENT_TOOL_NAME = 'mcp__happy__bash_stream';

export interface HappyServerHandlers {
    localToolAvailable?: boolean;
    checkpointReader?: CheckpointAgentReader;
    admitTool?: <T>(work: () => Promise<T>) => Promise<T>;
    changeTitle: (title: string, branchSlug?: string) => Promise<{ success: boolean; error?: string }>;
    client: ApiSessionClient;
    proposeLesson?: (input: { token: string; proposal: unknown }) => { accepted: boolean };
    protectedBashCwd?: () => string | null;
    trackProtectedBashProcess?: (child: ChildProcess) => void;
    browserTaskRuntime?: RuntimeClient;
    /** The granted profile: fixed, or (execution machine H) the one the broker's grant names. */
    browserTaskProfileId?: string | (() => Promise<string>);
    exitAfterFirstTurn?: boolean;
    /** The run-once host keeps the session parked while a browser task waits for the user. */
    browserHostContinues?: boolean;
    mandatorySandbox?: boolean;
}

// The first title generated through change_title is the one users rely on to
// find the chat again. Letting later calls overwrite it makes the title churn,
// so once a title exists this becomes a no-op.
//
// branchSlug rides along in the same call so the model can supply it for free
// off the title-generation pass, without a second LLM round-trip. It is stored
// separately in metadata.summary.branchSlug rather than folded into the
// synthetic `summary` RawJSONLines event, since that event's shape mirrors
// Claude's own JSONL log format and isn't the place to grow custom fields.
export function createChangeTitleHandler(client: ApiSessionClient) {
    return async (title: string, branchSlug?: string): Promise<{ success: boolean; error?: string }> => {
        if (client.hasTitle()) {
            logger.debug('[happyMCP] Title already set; ignoring change_title call');
            return { success: false, error: 'Title already set for this session and is now locked' };
        }
        logger.debug('[happyMCP] Changing title to:', title);
        try {
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
            const slug = branchSlug?.trim();
            if (slug) {
                // The summary above is written by a separate, fire-and-forget
                // updateMetadata call that silently gives up on a hard error, so
                // metadata.summary may still be missing here. Fill text/updatedAt
                // from the title we just sent rather than writing a partial summary.
                client.updateMetadata((metadata) => ({
                    ...metadata,
                    summary: {
                        text: metadata.summary?.text ?? title,
                        updatedAt: metadata.summary?.updatedAt ?? Date.now(),
                        branchSlug: slug
                    }
                }));
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };
}

function createToolRunner(admitTool: HappyServerHandlers['admitTool']) {
    // Track the actual callback, not HTTP response lifetime (disconnect does not stop a tool).
    return async <T,>(work: () => Promise<T>) => {
        if (!admitTool) return work();
        let started = false;
        try { return await admitTool(() => { started = true; return work(); }); }
        catch (error) {
            if (started) throw error;
            return { isError: true, content: [{ type: 'text' as const, text: 'Tool unavailable during session shutdown' }] };
        }
    };
}

function createMcpServer(handlers: HappyServerHandlers): McpServer {
    const runTool = createToolRunner(handlers.admitTool);
    const scopedSession = process.env.HAPPY_WRITE_SCOPE_SESSION === '1';
    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
    });

    if (!handlers.mandatorySandbox || scopedSession) registerSessionWriteScopeTools(mcp, handlers.client.sessionId, runTool);

    if (handlers.checkpointReader) registerCheckpointAgentTools(mcp, handlers.checkpointReader, runTool);

    if (handlers.proposeLesson && !handlers.mandatorySandbox) {
        mcp.registerTool('propose_lesson', {
            title: 'Propose Project Lesson',
            description: 'Stage one verified lesson proposal for the current foreground turn. Requires its current token. This does not save or approve a lesson; normal turn completion and human approval are required.',
            inputSchema: { token: z.string().uuid(), proposal: z.record(z.string(), z.unknown()) },
        }, async (input) => runTool(async () => ({ content: [{ type: 'text' as const, text: JSON.stringify(handlers.proposeLesson!(input)) }] })));
    }

    if (!handlers.mandatorySandbox && !scopedSession) mcp.registerTool('script_automations', {
        title: 'Manage Script Automations',
        description: 'Manage Node bundle scripts in the Execution > Automations admin of this project or Chat without an LLM session. List before registering scheduled collection or batch work. Supports list/get/upsert/run/list_runs/set_enabled; use registrationKey and expectedRevision for safe retries. upsert reads sourcePath relative to this project or Chat workspace, encrypts the bundle, and supports schedule=null or at/interval/daily/weekly, externalEnabled, JSON inputSchema, allowlisted origins and env:<mountedGroupId>:<KEY> secret references (in a Chat, only default-load env groups of the organization resolve). No API keys are issued by this tool. Return and use the same admin ID; do not install OS cron or hidden background timers.',
        inputSchema: { request: scriptAutomationToolRequestSchema },
    }, async ({ request }) => runTool(async () => {
        try {
            const metadata = handlers.client.getMetadata();
            if (!metadata?.path) throw new Error('SCRIPT_PROJECT_CONTEXT_REQUIRED');
            const result = await runScriptAutomationTool(request, { directory: metadata.path, machineId: metadata.machineId });
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
            const code = error instanceof Error && /^[A-Z0-9_-]{1,100}$/.test(error.message) ? error.message : 'SCRIPT_MANAGEMENT_FAILED';
            return { isError: true, content: [{ type: 'text' as const, text: code }] };
        }
    }));

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
            branchSlug: z.string().optional().describe(
                'A short English kebab-case slug (2-4 words) summarizing the same task, for use as a git branch name.'
            ),
        },
    }, async (args) => runTool(async () => {
        const response = await handlers.changeTitle(args.title, args.branchSlug);
        logger.debugLargeJson('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    }));

    // chat-tool-output-streaming Phase 3 — bash_stream wraps `bash -c` and
    // forwards stdout/stderr line-by-line via onBashStreamProgress so the
    // chat can tail the output. MVP scope: single-line shell commands (no
    // heredoc, timeouts, cancellation). The system prompt steers the agent
    // to fall back to Claude's built-in Bash for everything outside that.
    if (!handlers.mandatorySandbox && !scopedSession) mcp.registerTool('bash_stream', {
        description:
            'Run a shell command via `bash -c` and stream stdout/stderr live to the chat UI. Use this for long-running batch commands (npm install, pytest, build, etc.) so the user sees output as it happens. For short read-only commands or anything with heredocs/multiline scripts, prefer the built-in Bash tool.',
        title: 'Bash (streamed)',
        inputSchema: {
            command: z.string().describe('Shell command to execute via `bash -c`'),
            cwd: z.string().optional().describe('Working directory (defaults to the daemon cwd)'),
        },
    }, async (args) => runTool(async () => {
        logger.debug(`[bash_stream:tool] invoked command=${String(args.command).slice(0, 100)}`);
        try {
            const protectedCwd = handlers.protectedBashCwd?.();
            if (handlers.protectedBashCwd && !protectedCwd) {
                throw new Error('checkpoint protection has no active turn workspace');
            }
            const result = await runBashStream({
                command: args.command,
                cwd: protectedCwd ?? args.cwd,
                detached: Boolean(handlers.protectedBashCwd),
                onSpawn: handlers.trackProtectedBashProcess,
                onProgress: (progress) => {
                    const call = getActiveBashStreamCall();
                    logger.debug(`[bash_stream:tool] flush stream=${progress.stream} lines=${progress.lines.length} call=${call ?? '(none)'}`);
                    if (!call) return;
                    // Build the envelope manually instead of calling
                    // happy-wire's createEnvelope: the published
                    // @slopus/happy-wire@^0.1.0 zod schema doesn't yet
                    // know about `tool-call-progress`, and its
                    // `.parse(...)` would throw a ZodError inside this
                    // setTimeout callback. That unhandled exception
                    // bubbles up through StreamLineBuffer.close() and
                    // prevents runBashStream from ever resolving — the
                    // tool then hangs forever from the agent's POV.
                    const envelope: SessionEnvelope = {
                        id: createId(),
                        time: Date.now(),
                        role: 'agent',
                        ev: {
                            t: 'tool-call-progress',
                            call,
                            stream: progress.stream,
                            lines: progress.lines,
                        } as SessionEnvelope['ev'],
                    };
                    try {
                        handlers.client.sendSessionProtocolMessage(envelope);
                    } catch (sendErr) {
                        logger.debug(`[bash_stream:tool] envelope send failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
                    }
                },
            });
            logger.debug(`[bash_stream:tool] done exit=${result.exitCode} stdoutBytes=${result.stdout.length}`);
            const tail = `\n[exit ${result.exitCode}]`;
            return {
                content: [
                    {
                        type: 'text',
                        text: (result.stdout || '') + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : '') + tail,
                    },
                ],
                isError: result.exitCode !== 0,
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `bash_stream failed: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    }));

    // Agent Browser PoC: the task runtime replaces the extension-bridge tools,
    // which fall back to the active tab and would bypass the task lease.
    if (handlers.browserTaskRuntime) {
        registerBrowserTaskTools(mcp, handlers.browserTaskRuntime, { agentSessionId: handlers.client.sessionId, profileId: handlers.browserTaskProfileId ?? 'default', exitAfterFirstTurn: handlers.exitAfterFirstTurn, hostContinues: handlers.browserHostContinues });
    } else if (!handlers.mandatorySandbox && !scopedSession) {
        registerBrowserTools(mcp, runTool);
    }

    if (handlers.localToolAvailable && !handlers.mandatorySandbox && !handlers.browserTaskRuntime) {
        const invoke = async (operation: Record<string, unknown>, signal?: AbortSignal) => runTool(async () => {
            try {
                const context = await localToolAgentContext(handlers.client.sessionId, handlers.client.getMetadata()?.machineId);
                if (!context) throw new Error('CALLER_REQUIRED');
                const value = await requestLocalToolAgent(context, operation, signal);
                return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
            } catch (error) {
                const code = error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'LOCAL_TOOL_FAILED';
                return { isError: true, content: [{ type: 'text' as const, text: code }] };
            }
        });
        mcp.registerTool('local_tool_capabilities', {
            title: 'Inspect approved computer tools', description: 'List currently approved local computer tool operations and their bounded input schemas. Inspect before controlling the computer. Native permission prompts and denied/ambiguous input require the user.', inputSchema: {},
        }, (_input, extra) => invoke({ action: 'describe' }, extra.signal));
        mcp.registerTool('local_tool_control', {
            title: 'Control this computer', description: 'Run a currently approved operation from local_tool_capabilities. Use fresh window/element references; do not bypass native permission prompts. Requires the same authenticated user, machine and conversation on a running Desktop. Cancel releases only this conversation; remote work may remain unconfirmed.',
            inputSchema: z.object({ action: z.enum(['run', 'cancel']), extensionId: z.string().regex(/^[a-z][a-z0-9.-]{1,127}$/), operation: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).optional(), parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional() }).strict(),
        }, (input, extra) => invoke({ ...input, ...(input.action === 'run' ? { parameters: input.parameters ?? {} } : {}) }, extra.signal));
    }
    return mcp;
}

/**
 * chrome-extension-bridge Phase 2 — read-only control of the user's real,
 * logged-in Chrome. The session reaches the browser through the daemon
 * (`/browser/request`), which relays to the extension over a loopback socket.
 */
function registerBrowserTools(mcp: McpServer, runTool: ReturnType<typeof createToolRunner>): void {
    const bridge: BridgeRequest = async (method, params, opts) => {
        const viewerKey = process.env.HAPPY_BROWSER_VIEWER_KEY
        if (process.env.HAPPY_BROWSER_VIEWER_SCOPE_REQUIRED === '1' && !viewerKey) {
            throw new BrowserClientError(
                'VIEWER_SCOPE_UNAVAILABLE',
                'Per-user browser routing is required but the server did not issue a viewer key',
            )
        }
        const connection = await readDaemonControlPort();
        if (connection === null) {
            throw new BrowserClientError('DAEMON_UNREACHABLE', 'No happy daemon is running on this machine');
        }
        return requestBrowser({
            ...connection,
            method,
            params,
            ...(opts?.profile !== undefined ? { profile: opts.profile } : {}),
            ...(viewerKey ? { viewerKey } : {}),
        });
    };

    // Only consulted when a command comes back looking wrong (see runBrowserTool).
    const status = async () => {
        const connection = await readDaemonControlPort();
        return connection === null
            ? null
            : fetchBrowserStatus(connection.port, connection.controlSecret, process.env.HAPPY_BROWSER_VIEWER_KEY);
    };

    mcp.registerTool('browser_tabs', {
        description:
            "List the tabs open in the user's real Chrome on this machine (their logged-in profile, not a fresh headless browser). Use this to find the tab to work with; the returned ids can be passed as tabId to the other browser tools.",
        title: 'List browser tabs',
        inputSchema: {
            profile: z.string().optional().describe('Which connected Chrome profile to act on. Only needed when browser_capabilities or an AMBIGUOUS_PROFILE error says more than one is connected.'),
        },
    }, async (args) => runTool(async () => runBrowserTool({ request: bridge, status, method: 'tabs_list', params: { profile: args.profile } })));

    mcp.registerTool('browser_snapshot', {
        description:
            "Snapshot the interactive elements of a tab in the user's Chrome — links, buttons, inputs — each with a @eN ref. Prefer this over a screenshot when you need to understand or act on the page: it is text, cheap, and the refs are how you will target elements. Refs are invalidated by navigation, so re-snapshot after the page changes.",
        title: 'Snapshot page elements',
        inputSchema: {
            tabId: z.number().optional().describe('Tab to snapshot (defaults to the active tab)'),
            profile: z.string().optional().describe('Which connected Chrome profile to act on. Only needed when browser_capabilities or an AMBIGUOUS_PROFILE error says more than one is connected.'),
        },
    }, async (args) => runTool(async () => runBrowserTool({ request: bridge, status, method: 'snapshot', params: { profile: args.profile, tabId: args.tabId } })));

    mcp.registerTool('browser_screenshot', {
        description:
            "Capture what a tab in the user's Chrome currently looks like. Use it for visual questions (layout, rendering, a chart); for reading or acting on page content prefer browser_snapshot.",
        title: 'Screenshot a tab',
        inputSchema: {
            tabId: z.number().optional().describe('Tab to capture (defaults to the active tab)'),
            fullPage: z.boolean().optional().describe('Capture the whole scrollable page instead of just the visible area. Needs the optional debugger permission, which only the user can enable.'),
            profile: z.string().optional().describe('Which connected Chrome profile to act on. Only needed when browser_capabilities or an AMBIGUOUS_PROFILE error says more than one is connected.'),
        },
    }, async (args) => runTool(async () => runBrowserTool({ request: bridge, status, method: 'screenshot', params: { profile: args.profile, tabId: args.tabId, fullPage: args.fullPage } })));

    mcp.registerTool('browser_click', {
        description:
            'Click an element in the user\'s Chrome by its @eN ref from the most recent browser_snapshot. If the ref is stale (the page navigated or changed) this fails and tells you to re-snapshot.',
        title: 'Click an element',
        inputSchema: {
            ref: z.string().describe('Element ref from browser_snapshot, e.g. "@e3"'),
            tabId: z.number().optional().describe('Tab the ref belongs to (defaults to the active tab)'),
            trusted: z.boolean().optional().describe('Dispatch a real (isTrusted) mouse event instead of a scripted click. Only needed when a page ignores scripted clicks. Requires the optional debugger permission, which only the user can enable. Not supported for elements inside an iframe (a @fN:eM ref) — use a normal click there.'),
            profile: z.string().optional().describe('Which connected Chrome profile to act on. Only needed when browser_capabilities or an AMBIGUOUS_PROFILE error says more than one is connected.'),
        },
    }, async (args) => runTool(async () => runBrowserTool({ request: bridge, status, method: 'click', params: { profile: args.profile, ref: args.ref, tabId: args.tabId, trusted: args.trusted } })));

    mcp.registerTool('browser_fill', {
        description:
            'Set the value of a text input, textarea or editable element in the user\'s Chrome by its @eN ref from the most recent browser_snapshot.',
        title: 'Fill an element',
        inputSchema: {
            ref: z.string().describe('Element ref from browser_snapshot, e.g. "@e3"'),
            value: z.string().describe('Text to enter. An empty string clears the field.'),
            tabId: z.number().optional().describe('Tab the ref belongs to (defaults to the active tab)'),
            trusted: z.boolean().optional().describe('Type as real (isTrusted) input instead of setting the value directly. Needed for editors that ignore scripted input. Requires the optional debugger permission, which only the user can enable. Not supported for elements inside an iframe (a @fN:eM ref) — use a normal fill there.'),
            profile: z.string().optional().describe('Which connected Chrome profile to act on. Only needed when browser_capabilities or an AMBIGUOUS_PROFILE error says more than one is connected.'),
        },
    }, async (args) => runTool(async () => runBrowserTool({ request: bridge, status, method: 'fill', params: { profile: args.profile, ref: args.ref, value: args.value, tabId: args.tabId, trusted: args.trusted } })));

    mcp.registerTool('browser_scroll', {
        description:
            "Scroll a page or a scrollable region in the user's Chrome by pixel deltas. Omit ref to scroll the document; pass a ref from browser_snapshot to scroll that element or its nearest scrollable ancestor. Re-run browser_snapshot after scrolling because lazy-loaded content can change the page and its refs.",
        title: 'Scroll a browser page or region',
        inputSchema: z.object({
            deltaX: z.number().min(-10_000).max(10_000).optional().describe('Horizontal pixel delta; negative scrolls left and positive scrolls right'),
            deltaY: z.number().min(-10_000).max(10_000).optional().describe('Vertical pixel delta; negative scrolls up and positive scrolls down'),
            ref: z.string().min(1).optional().describe('Optional element or scrollable-region ref from browser_snapshot, e.g. "@e3" or "@f7:e2"'),
            tabId: z.number().optional().describe('Tab to scroll (defaults to the active tab)'),
            profile: z.string().optional().describe('Which connected Chrome profile to act on. Only needed when browser_capabilities or an AMBIGUOUS_PROFILE error says more than one is connected.'),
        }).refine((args) => (args.deltaX ?? 0) !== 0 || (args.deltaY ?? 0) !== 0, {
            message: 'At least one of deltaX or deltaY must be non-zero',
        }),
    }, async (args) => runTool(async () => runBrowserTool({
        request: bridge,
        status,
        method: 'scroll',
        params: {
            profile: args.profile,
            ref: args.ref,
            tabId: args.tabId,
            deltaX: args.deltaX ?? 0,
            deltaY: args.deltaY ?? 0,
        },
    })));

    mcp.registerTool('browser_navigate', {
        description: "Navigate a tab in the user's Chrome to a URL. This invalidates any refs from an earlier browser_snapshot of that tab — re-snapshot after navigating.",
        title: 'Navigate a tab',
        inputSchema: {
            url: z.string().describe('URL to navigate to'),
            tabId: z.number().optional().describe('Tab to navigate (defaults to the active tab)'),
            profile: z.string().optional().describe('Which connected Chrome profile to act on. Only needed when browser_capabilities or an AMBIGUOUS_PROFILE error says more than one is connected.'),
        },
    }, async (args) => runTool(async () => runBrowserTool({ request: bridge, status, method: 'navigate', params: { profile: args.profile, url: args.url, tabId: args.tabId } })));

    mcp.registerTool('browser_open_tab', {
        description: "Open a new tab in the user's Chrome at a URL.",
        title: 'Open a new tab',
        inputSchema: {
            url: z.string().describe('URL to open'),
            profile: z.string().optional().describe('Which connected Chrome profile to act on. Only needed when browser_capabilities or an AMBIGUOUS_PROFILE error says more than one is connected.'),
        },
    }, async (args) => runTool(async () => runBrowserTool({ request: bridge, status, method: 'tabs_open', params: { profile: args.profile, url: args.url } })));

    mcp.registerTool('browser_capabilities', {
        description:
            "Check what the browser bridge can do right now — in particular whether the optional debugger tier (fullPage screenshots, trusted click/fill) is enabled. Check this before relying on those rather than discovering it from a failed call.",
        title: 'Browser capabilities',
        inputSchema: {
            profile: z.string().optional().describe('Which connected Chrome profile to act on. Only needed when browser_capabilities or an AMBIGUOUS_PROFILE error says more than one is connected.'),
        },
    }, async (args) => runTool(async () => runBrowserTool({ request: bridge, status, method: 'capabilities', params: { profile: args.profile } })));

    mcp.registerTool('browser_close_tab', {
        description: "Close a tab in the user's Chrome. Use browser_tabs first to find the tabId.",
        title: 'Close a tab',
        inputSchema: {
            tabId: z.number().describe('Tab id from browser_tabs'),
            profile: z.string().optional().describe('Which connected Chrome profile to act on. Only needed when browser_capabilities or an AMBIGUOUS_PROFILE error says more than one is connected.'),
        },
    }, async (args) => runTool(async () => runBrowserTool({ request: bridge, status, method: 'tabs_close', params: { profile: args.profile, tabId: args.tabId } })));
}

/**
 * The per-session broker secret is taken out of the environment on first read,
 * so nothing this process spawns (claude, MCP children) inherits it.
 */
let browserTaskSessionSecret: string | undefined;
function takeBrowserTaskSessionSecret(): string | undefined {
    browserTaskSessionSecret ??= process.env.HAPPY_BROWSER_TASK_SESSION_SECRET || undefined;
    delete process.env.HAPPY_BROWSER_TASK_SESSION_SECRET;
    return browserTaskSessionSecret;
}

function createBrowserTaskRuntimeClient(client: ApiSessionClient, profileId: string): { runtime: RuntimeClient; profileId: string | (() => Promise<string>) } | undefined {
    const baseUrl = process.env.HAPPY_BROWSER_TASK_RUNTIME_URL;
    if (!baseUrl) return undefined;
    const socketPath = process.env.HAPPY_BROWSER_TASK_BROKER_SOCKET;
    const sessionSecret = takeBrowserTaskSessionSecret();
    if (socketPath && sessionSecret) {
        // Execution machine H: the Runtime broker issues this session's grant (D4), for the profile it picks
        // (on a shared machine the session user's).
        const grants = createBrokerGrantSource({
            socketPath,
            sessionSecret,
            agentSessionId: () => client.sessionId,
            profileId,
        });
        return { runtime: new RuntimeClient({ baseUrl, token: grants }), profileId: grants.grantedProfileId };
    }
    // Harness only: the E2E harness writes a grant file for the session.
    const grantFile = process.env.HAPPY_BROWSER_TASK_GRANT_FILE;
    // Read at call time so a rotated grant is picked up without a restart.
    const token = async () => {
        const grant = grantFile ? await readFile(grantFile, 'utf8').catch(() => '') : '';
        if (!grant.trim()) throw new BrowserRuntimeError('UNAUTHORIZED', 'browser task grant is unavailable');
        return grant.trim();
    };
    return { runtime: new RuntimeClient({ baseUrl, token }), profileId };
}

export async function startHappyServer(
    client: ApiSessionClient,
    options: {
        checkpointReader?: CheckpointAgentReader;
        exitAfterFirstTurn?: boolean;
        /** Set by the daemon for a Studio Chat(beta) session (HAPPY_AUTOMATION_BROWSER_CONTINUATION). */
        browserHostContinues?: boolean;
        mandatorySandbox?: boolean;
        /** Authenticated scope launch stays at the parent UID, rather than using agent-sbx. */
        sameUidSandbox?: boolean;
        admitTool?: <T>(work: () => Promise<T>) => Promise<T>;
        proposeLesson?: (input: { token: string; proposal: unknown }) => { accepted: boolean };
        protectedBashCwd?: () => string | null;
        trackProtectedBashProcess?: (child: ChildProcess) => void;
    } = {},
) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

    const browserTask = createBrowserTaskRuntimeClient(client, process.env.HAPPY_BROWSER_TASK_PROFILE_ID || 'default');
    const browserTaskRuntime = browserTask?.runtime;
    const browserTaskProfileId = browserTask?.profileId;
    if (browserTaskRuntime) {
        logger.debug('[happyMCP] legacy browser_* tools disabled by HAPPY_BROWSER_TASK_RUNTIME_URL (agent browser PoC)');
    }

    const computerAvailable = async () => {
        if (options.mandatorySandbox || browserTaskRuntime) return false;
        try {
            const context = await localToolAgentContext(client.sessionId, client.getMetadata()?.machineId);
            if (!context) return false;
            // Every runner awaits startup; a slow Desktop must cost at most 2s, not the 3s+35s call budget.
            const result = await requestLocalToolAgent(context, { action: 'describe' }, AbortSignal.timeout(2000));
            return Array.isArray(result.tools) && result.tools.length > 0;
        } catch { return false; }
    };
    const initialComputerAvailable = await computerAvailable();
    const changeTitle = createChangeTitleHandler(client);
    // The same-UID Linux scope boundary denies socket(AF_UNIX); do not start without Happy tools.
    if (options.mandatorySandbox && options.sameUidSandbox && process.platform === 'linux') {
        throw new MandatorySandboxError('capability-unavailable', 'Same-UID Linux scope MCP transport unavailable');
    }
    const linuxMandatory = options.mandatorySandbox && process.platform === 'linux' && !options.sameUidSandbox;
    let mcpGroup: number | undefined;
    let privateDir: string | undefined;
    try {
        mcpGroup = linuxMandatory ? Number(execFileSync('/usr/bin/id', ['-g', 'agent-sbx'], { encoding: 'utf8' }).trim()) : undefined;
        if (linuxMandatory) {
            const root = lstatSync('/run/abp-mcp');
            if (!root.isDirectory() || root.uid !== process.getuid?.() || root.gid !== mcpGroup || (root.mode & 0o777) !== 0o710) throw new Error('Mandatory MCP directory permissions invalid');
        }
        privateDir = options.mandatorySandbox ? mkdtempSync(join(linuxMandatory ? '/run/abp-mcp' : tmpdir(), 'happy-mcp-')) : undefined;
        if (privateDir && mcpGroup !== undefined) {
            chownSync(privateDir, process.getuid!(), mcpGroup);
            chmodSync(privateDir, 0o710);
        }
    } catch {
        if (privateDir) rmSync(privateDir, { recursive: true, force: true });
        throw new MandatorySandboxError('capability-unavailable', 'MCP socket directory or group unavailable');
    }
    const socketPath = privateDir ? join(privateDir, 'mcp.sock') : undefined;
    const token = privateDir ? randomBytes(32).toString('hex') : undefined;

    const server = createServer(async (req, res) => {
        if (token) {
            const supplied = Buffer.from(req.headers.authorization ?? '');
            const expected = Buffer.from(`Bearer ${token}`);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
                res.writeHead(401).end();
                return;
            }
        }
        const mcp = createMcpServer({
            // Keep the advertised tools and stateless request registration in sync.
            // Invocation still resolves the caller and enforces current grants.
            localToolAvailable: initialComputerAvailable,
            changeTitle,
            checkpointReader: options.checkpointReader,
            admitTool: options.admitTool,
            client,
            mandatorySandbox: options.mandatorySandbox,
            proposeLesson: options.proposeLesson,
            protectedBashCwd: options.protectedBashCwd,
            trackProtectedBashProcess: options.trackProtectedBashProcess,
            browserTaskRuntime,
            browserTaskProfileId,
            exitAfterFirstTurn: options.exitAfterFirstTurn,
            browserHostContinues: options.browserHostContinues,
        });
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            mcp.close();
        }
    });

    const baseUrl = await new Promise<URL>((resolve, reject) => {
        server.once('error', reject);
        if (socketPath) {
            server.listen(socketPath, () => {
                try {
                    if (mcpGroup !== undefined) chownSync(socketPath, process.getuid!(), mcpGroup);
                    chmodSync(socketPath, mcpGroup === undefined ? 0o600 : 0o660);
                    resolve(new URL('http://localhost/'));
                } catch { reject(new MandatorySandboxError('capability-unavailable', 'MCP socket permissions unavailable')); }
            });
        } else {
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address() as AddressInfo;
                resolve(new URL(`http://127.0.0.1:${addr.port}`));
            });
        }
    }).catch(error => {
        server.close();
        if (privateDir) rmSync(privateDir, { recursive: true, force: true });
        throw error;
    });
    const mcpConfig: { type: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string } = socketPath
        ? { type: 'stdio', command: process.execPath, args: [join(projectPath(), 'bin/happy-mcp.mjs')], env: {
            SAYCODE_MCP_SOCKET: socketPath,
            SAYCODE_MCP_TOKEN: token!,
        } }
        : { type: 'http', url: baseUrl.toString() };

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        socketPath,
        mcpConfig,
        toolNames: [...(initialComputerAvailable ? ['local_tool_capabilities', 'local_tool_control'] : []), ...(options.checkpointReader ? ['checkpoint_status', 'checkpoint_list', 'checkpoint_preview', 'checkpoint_diff'] : []), ...(options.mandatorySandbox
            ? ['change_title', ...(browserTaskRuntime ? BROWSER_TASK_TOOL_NAMES : [])]
            : [...(options.proposeLesson ? ['propose_lesson'] : []), 'change_title', 'bash_stream', 'script_automations', ...(browserTaskRuntime ? BROWSER_TASK_TOOL_NAMES : BROWSER_TOOL_NAMES)])],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            server.close(() => { if (privateDir) rmSync(privateDir, { recursive: true, force: true }); });
            server.closeAllConnections();
        }
    }
}
