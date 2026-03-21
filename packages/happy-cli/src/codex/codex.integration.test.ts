/**
 * Integration tests for Codex app-server session lifecycle.
 *
 * Drives `codex app-server` via the CodexAppServerClient — exercises the
 * permission reject → turn_aborted flow and per-turn model changes that
 * were impossible with the legacy MCP tools.
 *
 * Requirements:
 *   - `codex` CLI installed and on PATH (>= 0.100)
 *   - OPENAI_API_KEY (or equivalent) configured
 *
 * Run:
 *   npx vitest run src/codex/codex.integration.test.ts
 */

import { afterEach, describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { CodexAppServerClient } from "./codexAppServerClient";
import type { ReviewDecision, EventMsg } from "./codexAppServerTypes";
import { getIntegrationEnv } from "@/testing/currentIntegrationEnv";

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "gpt-5.2-codex";
const integrationEnv = getIntegrationEnv();

type PermissionPolicy = "approve" | "deny" | "cancel" | "hold";

function policyToDecision(policy: Exclude<PermissionPolicy, "hold">): ReviewDecision {
    switch (policy) {
        case "approve":
            return "approved";
        case "deny":
            return "denied";
        case "cancel":
            return "abort";
    }
}

async function isCodexAppServerAvailable(): Promise<boolean> {
    try {
        const version = execSync("codex --version", { encoding: "utf8" }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
        if (!match) return false;
        const [major, minor] = match[1].split(".").map(Number);
        return major > 0 || minor >= 100;
    } catch {
        return false;
    }
}

// ── CodexDriver ──────────────────────────────────────────────────────────────

interface TurnResult {
    aborted: boolean;
    elapsed_ms: number;
}

interface CodexEvent {
    type: string;
    data: any;
}

/**
 * Thin wrapper around CodexAppServerClient for testing.
 * Tracks events, permissions, and provides a simple send/continue API.
 */
class CodexDriver {
    private client: CodexAppServerClient;
    private threadStarted = false;
    private heldApprovals: Array<(decision: ReviewDecision) => void> = [];

    events: CodexEvent[] = [];
    permissionPolicy: PermissionPolicy = "approve";
    permissionCount = 0;

    constructor() {
        this.client = new CodexAppServerClient();

        this.client.setEventHandler((msg: EventMsg) => {
            this.events.push({ type: msg.type, data: msg });
        });

        this.client.setApprovalHandler(async () => {
            this.permissionCount++;
            if (this.permissionPolicy === "hold") {
                return new Promise<ReviewDecision>((resolve) => {
                    this.heldApprovals.push(resolve);
                });
            }
            return policyToDecision(this.permissionPolicy);
        });
    }

    resolveHeldApprovals(decision: ReviewDecision): void {
        for (const resolve of this.heldApprovals) {
            resolve(decision);
        }
        this.heldApprovals = [];
    }

    /**
     * Interrupt the active turn. Unblock held approvals and send
     * turn/interrupt concurrently — codex may be blocked on the approval
     * callback and unable to process the interrupt until we respond.
     */
    async interrupt(): Promise<void> {
        this.resolveHeldApprovals("abort");
        await this.client.abortTurnWithFallback({
            gracePeriodMs: 5_000,
            forceRestartOnTimeout: true,
        });
    }

    async connect(): Promise<void> {
        await this.client.connect();
    }

    async restartBackendAndResume(): Promise<void> {
        if (!this.threadStarted) {
            throw new Error("No active thread — call send() first");
        }

        const resumed = await this.client.reconnectAndResumeThread();
        if (!resumed) {
            throw new Error("Expected reconnectAndResumeThread() to resume the existing thread");
        }
    }

    /** Start a new thread and send the first turn. */
    async send(
        prompt: string,
        opts?: {
            approvalPolicy?: string;
            sandbox?: string;
            cwd?: string;
            model?: string;
        }
    ): Promise<TurnResult> {
        if (!this.threadStarted) {
            await this.client.startThread({
                model: opts?.model ?? DEFAULT_MODEL,
                cwd: opts?.cwd,
                approvalPolicy: opts?.approvalPolicy as any,
                sandbox: opts?.sandbox as any,
            });
            this.threadStarted = true;
        }

        const start = Date.now();
        const result = await this.client.sendTurnAndWait(prompt, {
            model: opts?.model,
            approvalPolicy: opts?.approvalPolicy as any,
            sandbox: opts?.sandbox as any,
            cwd: opts?.cwd,
        });

        return {
            aborted: result.aborted,
            elapsed_ms: Date.now() - start,
        };
    }

    /** Continue an existing thread with a new turn. */
    async continue(
        prompt: string,
        opts?: { model?: string; timeout?: number; approvalPolicy?: string; sandbox?: string }
    ): Promise<TurnResult> {
        if (!this.threadStarted) {
            throw new Error("No active thread — call send() first");
        }

        const start = Date.now();
        const result = await this.client.sendTurnAndWait(prompt, {
            model: opts?.model,
            approvalPolicy: opts?.approvalPolicy as any,
            sandbox: opts?.sandbox as any,
        });

        return {
            aborted: result.aborted,
            elapsed_ms: Date.now() - start,
        };
    }

    getMessages(): string[] {
        return this.events
            .filter((e) => e.type === "agent_message")
            .map((e) => e.data?.message ?? "")
            .filter(Boolean);
    }

    hasEvent(type: string): boolean {
        return this.events.some((e) => e.type === type);
    }

    clearEvents(): void {
        this.events = [];
        this.permissionCount = 0;
    }

    async close(): Promise<void> {
        await this.client.disconnect();
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!(await isCodexAppServerAvailable()))(
    "Codex Integration (app-server)",
    { timeout: 180_000 },
    () => {
        let driver: CodexDriver | null = null;

        afterEach(async () => {
            if (driver) {
                await driver.close();
                driver = null;
            }
        });

        it("should complete turn gracefully after permission cancel", async () => {
            driver = new CodexDriver();
            await driver.connect();

            driver.permissionPolicy = "cancel";
            const result = await driver.send(
                'create a file called /tmp/codex-cancel-test.txt with the text "hello"',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath }
            );

            // Codex v2 (0.115+): approval cancel declines the action, model
            // handles it gracefully and completes the turn (not aborted).
            expect(result.elapsed_ms).toBeLessThan(30_000);
            expect(driver.permissionCount).toBeGreaterThan(0);
            expect(driver.hasEvent("task_complete")).toBe(true);
            expect(result.aborted).toBe(false);
        });

        it("should preserve context when continuing after cancel", async () => {
            driver = new CodexDriver();
            await driver.connect();

            // Turn 1: establish context with a mundane phrase
            driver.permissionPolicy = "approve";
            await driver.send(
                'The project name we are working on is "blue-falcon-42". Confirm by repeating the project name. Do NOT use any tools or run any commands.',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath }
            );
            expect(driver.getMessages().join(" ").toLowerCase()).toContain("blue-falcon-42");

            // Turn 2: permission cancel — model handles rejection gracefully,
            // turn completes normally (v2 cancel ≠ abort).
            driver.clearEvents();
            driver.permissionPolicy = "cancel";
            const r2 = await driver.continue(
                'Create a file called /tmp/codex-test-context.txt with the text "test". Use a shell command.',
                { approvalPolicy: "on-request", sandbox: "read-only" }
            );
            expect(driver.hasEvent("task_complete")).toBe(true);
            expect(r2.aborted).toBe(false);

            // Turn 3: Codex must remember the project name from turn 1
            driver.clearEvents();
            driver.permissionPolicy = "approve";
            await driver.continue(
                "What was the project name I mentioned earlier? Reply with just the name."
            );

            const text = driver.getMessages().join(" ").toLowerCase();
            expect(text).toContain("blue-falcon-42");
        });

        it("should abort turn via interruptTurn while permission is pending", async () => {
            driver = new CodexDriver();
            await driver.connect();

            // Hold permissions — simulates user not responding to approval
            driver.permissionPolicy = "hold";

            const turnPromise = driver.send(
                'Create a file called /tmp/codex-interrupt-test.txt with the text "hello". Use a shell command.',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath }
            );

            // Wait for a permission request to arrive
            const deadline = Date.now() + 30_000;
            while (driver.permissionCount === 0 && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(driver.permissionCount).toBeGreaterThan(0);

            // Simulate the web app abort button: abort held approvals + interrupt turn.
            // Codex v2: approval cancel = decline, model may finish before interrupt
            // lands. The key invariant: the turn must NOT hang.
            await driver.interrupt();

            const result = await turnPromise;
            expect(result.elapsed_ms).toBeLessThan(30_000);
        });

        it("should preserve context after backend reconnect and thread/resume", async () => {
            driver = new CodexDriver();
            await driver.connect();

            driver.permissionPolicy = "approve";
            await driver.send(
                'The project codename is "steady-orchid-19". Confirm by repeating the project codename. Do NOT use any tools or run any commands.',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath }
            );
            expect(driver.getMessages().join(" ").toLowerCase()).toContain("steady-orchid-19");

            driver.clearEvents();
            await driver.restartBackendAndResume();

            driver.clearEvents();
            await driver.continue(
                "What was the project codename I mentioned earlier? Reply with just the codename."
            );

            const text = driver.getMessages().join(" ").toLowerCase();
            expect(text).toContain("steady-orchid-19");
        });

        it("should preserve context when continuing after interruptTurn abort", async () => {
            driver = new CodexDriver();
            await driver.connect();

            // Turn 1: establish context with a mundane phrase
            driver.permissionPolicy = "approve";
            await driver.send(
                'The project codename is "golden-phoenix-77". Confirm by repeating the project codename. Do NOT use any tools or run any commands.',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath }
            );
            expect(driver.getMessages().join(" ").toLowerCase()).toContain("golden-phoenix-77");

            // Turn 2: hold permission, then abort via interruptTurn
            driver.clearEvents();
            driver.permissionPolicy = "hold";

            const abortedTurn = driver.continue(
                'Run this exact shell command: printf "test" > /tmp/codex-interrupt-context.txt',
                { approvalPolicy: "on-request", sandbox: "read-only" }
            );

            const deadline = Date.now() + 30_000;
            while (driver.permissionCount === 0 && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(driver.permissionCount).toBeGreaterThan(0);

            // Codex v2: cancel = decline, model may finish normally before
            // interrupt lands. The important thing is it doesn't hang.
            await driver.interrupt();
            const r2 = await abortedTurn;
            expect(r2.elapsed_ms).toBeLessThan(30_000);

            // Turn 3: context must be preserved — Codex should remember the project name
            driver.clearEvents();
            driver.permissionPolicy = "approve";
            await driver.continue(
                "What was the project codename I mentioned earlier? Reply with just the codename."
            );

            const text = driver.getMessages().join(" ").toLowerCase();
            expect(text).toContain("golden-phoenix-77");
        });
    }
);
