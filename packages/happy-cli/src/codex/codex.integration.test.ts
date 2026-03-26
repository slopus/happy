/**
 * Integration tests for the Codex SDK thread lifecycle.
 *
 * Drives the real `codex` CLI via CodexAppServerClient. The SDK manages
 * approvals internally, so these tests assert the real read-only limitation
 * directly and cover interruption via a real long-running shell command.
 *
 * Requirements:
 *   - `codex` CLI installed and on PATH (>= 0.100)
 *
 * Run:
 *   npx vitest run src/codex/codex.integration.test.ts
 */

import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServerClient } from "./codexAppServerClient";
import type { ApprovalPolicy, EventMsg, SandboxMode } from "./codexAppServerTypes";
import { getIntegrationEnv } from "@/testing/currentIntegrationEnv";

const DEFAULT_MODEL = "gpt-5.2-codex";
const integrationEnv = getIntegrationEnv();

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

interface TurnResult {
    aborted: boolean;
    elapsed_ms: number;
}

interface CodexEvent {
    type: string;
    data: EventMsg;
}

type TurnOptions = {
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    cwd?: string;
    model?: string;
};

function uniqueBlockedFile(name: string): string {
    return join(
        integrationEnv.projectPath,
        `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
}

class CodexDriver {
    private client: CodexAppServerClient;
    private threadStarted = false;

    events: CodexEvent[] = [];

    constructor() {
        this.client = new CodexAppServerClient();
        this.client.setEventHandler((msg: EventMsg) => {
            this.events.push({ type: msg.type, data: msg });
        });
    }

    async interrupt(): Promise<void> {
        await this.client.abortTurnWithFallback();
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

    async send(prompt: string, opts?: TurnOptions): Promise<TurnResult> {
        if (!this.threadStarted) {
            await this.client.startThread({
                model: opts?.model ?? DEFAULT_MODEL,
                cwd: opts?.cwd,
                approvalPolicy: opts?.approvalPolicy,
                sandbox: opts?.sandbox,
            });
            this.threadStarted = true;
        }

        const start = Date.now();
        const result = await this.client.sendTurnAndWait(prompt, {
            model: opts?.model,
            approvalPolicy: opts?.approvalPolicy,
            sandbox: opts?.sandbox,
            cwd: opts?.cwd,
        });

        return {
            aborted: result.aborted,
            elapsed_ms: Date.now() - start,
        };
    }

    async continue(prompt: string, opts?: TurnOptions): Promise<TurnResult> {
        if (!this.threadStarted) {
            throw new Error("No active thread — call send() first");
        }

        const start = Date.now();
        const result = await this.client.sendTurnAndWait(prompt, {
            model: opts?.model,
            approvalPolicy: opts?.approvalPolicy,
            sandbox: opts?.sandbox,
            cwd: opts?.cwd,
        });

        return {
            aborted: result.aborted,
            elapsed_ms: Date.now() - start,
        };
    }

    getMessages(): string[] {
        return this.events
            .filter((event) => event.type === "agent_message")
            .map((event) => event.data?.message)
            .filter((message): message is string => typeof message === "string" && message.length > 0);
    }

    hasEvent(type: string): boolean {
        return this.events.some((event) => event.type === type);
    }

    clearEvents(): void {
        this.events = [];
    }

    async waitForEvent(type: string, timeoutMs = 30_000): Promise<CodexEvent> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const event = this.events.find((entry) => entry.type === type);
            if (event) {
                return event;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        throw new Error(`Timed out waiting for event ${type}`);
    }

    async close(): Promise<void> {
        await this.client.disconnect();
    }
}

describe.skipIf(!(await isCodexAppServerAvailable()))(
    "Codex Integration (SDK)",
    { timeout: 180_000 },
    () => {
        let driver: CodexDriver | null = null;
        const createdFiles: string[] = [];

        afterEach(async () => {
            if (driver) {
                await driver.close();
                driver = null;
            }

            for (const file of createdFiles.splice(0)) {
                rmSync(file, { force: true });
            }
        });

        it("should complete turn gracefully when read-only sandbox blocks a write", async () => {
            driver = new CodexDriver();
            await driver.connect();

            const blockedFile = uniqueBlockedFile("codex-sdk-read-only-blocked");
            createdFiles.push(blockedFile);

            const result = await driver.send(
                `Create a file called ${blockedFile} with the text "hello". Use a shell command.`,
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath },
            );

            expect(result.elapsed_ms).toBeLessThan(30_000);
            expect(driver.hasEvent("task_complete")).toBe(true);
            expect(result.aborted).toBe(false);
            expect(existsSync(blockedFile)).toBe(false);
        });

        it("should preserve context when continuing after a read-only write attempt", async () => {
            driver = new CodexDriver();
            await driver.connect();

            await driver.send(
                'The project name we are working on is "blue-falcon-42". Confirm by repeating the project name. Do NOT use any tools or run any commands.',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath },
            );
            expect(driver.getMessages().join(" ").toLowerCase()).toContain("blue-falcon-42");

            driver.clearEvents();
            const blockedFile = uniqueBlockedFile("codex-sdk-context-blocked");
            createdFiles.push(blockedFile);
            const blockedTurn = await driver.continue(
                `Create a file called ${blockedFile} with the text "test". Use a shell command.`,
                { approvalPolicy: "on-request", sandbox: "read-only" },
            );
            expect(driver.hasEvent("task_complete")).toBe(true);
            expect(blockedTurn.aborted).toBe(false);
            expect(existsSync(blockedFile)).toBe(false);

            driver.clearEvents();
            await driver.continue(
                "What was the project name I mentioned earlier? Reply with just the name.",
            );

            const text = driver.getMessages().join(" ").toLowerCase();
            expect(text).toContain("blue-falcon-42");
        });

        it("should abort a long-running shell turn", async () => {
            driver = new CodexDriver();
            await driver.connect();

            const turnPromise = driver.send(
                'Run this exact shell command and do not do anything else: sleep 20 && echo "interrupt-test-finished".',
                { approvalPolicy: "never", sandbox: "danger-full-access", cwd: integrationEnv.projectPath },
            );

            await driver.waitForEvent("exec_command_begin");
            await driver.interrupt();

            const result = await turnPromise;
            expect(result.elapsed_ms).toBeLessThan(30_000);
            expect(result.aborted).toBe(true);
            expect(driver.hasEvent("turn_aborted")).toBe(true);
        });

        it("should preserve context after backend reconnect and thread/resume", async () => {
            driver = new CodexDriver();
            await driver.connect();

            await driver.send(
                'The project codename is "steady-orchid-19". Confirm by repeating the project codename. Do NOT use any tools or run any commands.',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath },
            );
            expect(driver.getMessages().join(" ").toLowerCase()).toContain("steady-orchid-19");

            driver.clearEvents();
            await driver.restartBackendAndResume();

            driver.clearEvents();
            await driver.continue(
                "What was the project codename I mentioned earlier? Reply with just the codename.",
            );

            const text = driver.getMessages().join(" ").toLowerCase();
            expect(text).toContain("steady-orchid-19");
        });

        it("should preserve context when continuing after interruptTurn abort", async () => {
            driver = new CodexDriver();
            await driver.connect();

            await driver.send(
                'The project codename is "golden-phoenix-77". Confirm by repeating the project codename. Do NOT use any tools or run any commands.',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath },
            );
            expect(driver.getMessages().join(" ").toLowerCase()).toContain("golden-phoenix-77");

            driver.clearEvents();
            const abortedTurn = driver.continue(
                'Run this exact shell command and do not do anything else: sleep 20 && echo "interrupt-context-finished".',
                { approvalPolicy: "never", sandbox: "danger-full-access" },
            );

            await driver.waitForEvent("exec_command_begin");
            await driver.interrupt();
            const result = await abortedTurn;
            expect(result.elapsed_ms).toBeLessThan(30_000);
            expect(result.aborted).toBe(true);

            driver.clearEvents();
            await driver.continue(
                "What was the project codename I mentioned earlier? Reply with just the codename.",
            );

            const text = driver.getMessages().join(" ").toLowerCase();
            expect(text).toContain("golden-phoenix-77");
        });
    },
);
