import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { ComputerRef } from "@rakazo/adapter-kit";
import {
  ComputerBrowserProvider,
  DockerSandboxProvider,
  FakeSandboxProvider,
} from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import {
  assertContactsExport,
  createContactsRecorder,
  createContactsReplayBrowser,
  executeContactsJourney,
  replayContactsRecording,
} from "./computer-recording.js";
import { computerReplayContext, runComputerReplay, waitForReplayFile } from "./computer-replay.js";
import {
  CONTACTS_CSV,
  CONTACTS_PATH,
  EXPORT_RECEIPT_PATH,
  installContactsFixture,
} from "./computer-replay-fixture.js";

describe.skipIf(process.env.RUN_COMPUTER_REPLAY_DOCKER !== "1")(
  "computer replay with real Docker Chrome and emulated model",
  () => {
    it("downloads a CSV through real page actions and captures an actual screenshot", async () => {
      if (!process.env.DATA_DIR || !process.env.SANDBOX_SUPERVISOR_TOKEN) {
        throw new Error(
          "Run through the computer-replay CLI to create an isolated supervisor environment",
        );
      }
      const { supervisorApp } = await import("@rakazo/sandbox-supervisor");
      const server = serve({
        fetch: supervisorApp.fetch,
        hostname: "127.0.0.1",
        port: 0,
      }) as Server;
      try {
        if (!server.listening)
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.once("listening", () => {
              server.off("error", reject);
              resolve();
            });
          });
        const port = (server.address() as AddressInfo).port;
        const sandbox = new DockerSandboxProvider(
          `http://127.0.0.1:${port}`,
          process.env.SANDBOX_SUPERVISOR_TOKEN,
        );
        const context = {
          ...computerReplayContext(),
          botId: `replay-${randomUUID()}`,
          signal: AbortSignal.timeout(240_000),
        };
        const homePath = path.join(process.env.DATA_DIR, "homes", context.botId);
        await mkdir(homePath, { recursive: true });
        let computer: ComputerRef | undefined;
        let ownedNetwork: string | undefined;
        try {
          // Optional escape hatch for a daemon whose automatic address pool is full.
          // Docker rejects overlapping subnets; only this test's unique network is touched.
          if (process.env.COMPUTER_REPLAY_SUBNET) {
            const { computerNetworkNameFor } = await import(
              "@rakazo/sandbox-supervisor/computer-spec"
            );
            const name = computerNetworkNameFor(context.botId);
            execFileSync(
              "docker",
              ["network", "create", "--subnet", process.env.COMPUTER_REPLAY_SUBNET, name],
              { stdio: "pipe" },
            );
            ownedNetwork = name;
          }
          computer = await sandbox.provision({ botId: context.botId, homePath }, context);
          await sandbox.prepare(computer, context);
          await installContactsFixture(sandbox, computer, context);
          if (process.env.COMPUTER_RECORD_OUTPUT) {
            if (!process.env.OPENROUTER_API_KEY)
              throw new Error("A manual capture requires an OpenRouter key");
            const recorder = createContactsRecorder(
              sandbox,
              new ComputerBrowserProvider({ sandbox }),
              computer,
              context,
            );
            try {
              await executeContactsJourney(
                {
                  provider: "openrouter",
                  id: "openai/gpt-5.6-luna",
                  apiKey: process.env.OPENROUTER_API_KEY,
                },
                recorder,
                context,
              );
            } finally {
              // Retain safe decisions for failed attempts too, without promoting a failed fixture.
              console.log(
                JSON.stringify({ source: "luna-openrouter-docker", steps: recorder.decisions() }),
              );
            }
            const recording = recorder.recording("luna-openrouter-docker");
            await assertContactsExport(sandbox, computer, context);
            const offlineSandbox = new FakeSandboxProvider();
            const offlineContext = computerReplayContext();
            const offlineComputer = await offlineSandbox.provision(
              { botId: "fixture-bot", homePath: "/fixture" },
              offlineContext,
            );
            const offlineBrowser = createContactsReplayBrowser(offlineSandbox, recording);
            try {
              await replayContactsRecording(
                recording,
                offlineSandbox,
                offlineBrowser,
                offlineComputer,
                offlineContext,
              );
              await assertContactsExport(offlineSandbox, offlineComputer, offlineContext);
              // Only sanitized intent leaves memory, after both artifact checks pass.
              await writeFile(
                process.env.COMPUTER_RECORD_OUTPUT,
                `${JSON.stringify(recording, null, 2)}\n`,
                { flag: "wx" },
              );
            } finally {
              offlineBrowser.close();
              await offlineSandbox.destroy(offlineComputer, offlineContext);
            }
            return;
          }
          const result = await runComputerReplay(
            sandbox,
            new ComputerBrowserProvider({ sandbox }),
            computer,
            context,
          ).catch((error: unknown) => {
            // This offline fixture contains only fake contacts. A read-only
            // snapshot distinguishes browser failures from command transport failures.
            let diagnostic = "unavailable";
            try {
              diagnostic = execFileSync(
                "docker",
                [
                  "exec",
                  computer!.id,
                  "bash",
                  "-c",
                  "/usr/local/bin/rakazo-page-browser snapshot; tail -40 /tmp/rakazo/screen-1-browser.log",
                ],
                { encoding: "utf8", timeout: 40_000 },
              );
            } catch (diagnosticError: unknown) {
              // Diagnostics are best-effort; keep any snapshot stdout and the replay cause.
              if (
                diagnosticError &&
                typeof diagnosticError === "object" &&
                "stdout" in diagnosticError &&
                typeof (diagnosticError as { stdout: unknown }).stdout === "string" &&
                (diagnosticError as { stdout: string }).stdout.trim()
              ) {
                diagnostic = (diagnosticError as { stdout: string }).stdout;
              }
            }
            throw new Error(`Computer replay failed; direct browser snapshot: ${diagnostic}`, {
              cause: error,
            });
          });
          expect(result.modelRequests).toBe(9);
          // These reads are independent of the agent's reply and tool-result assertions.
          expect(await waitForReplayFile(sandbox, computer, context, CONTACTS_PATH)).toBe(
            CONTACTS_CSV,
          );
          expect(await waitForReplayFile(sandbox, computer, context, EXPORT_RECEIPT_PATH)).toBe(
            "1",
          );
          const files = await sandbox.listFiles(computer, "Downloads", context);
          expect(files.filter((file) => file.path.endsWith(".csv"))).toHaveLength(1);
        } finally {
          try {
            if (computer)
              await sandbox.destroy(computer, { ...context, signal: AbortSignal.timeout(30_000) });
          } finally {
            if (ownedNetwork) {
              // Successful destroy already removes it. A failed provision may leave it behind.
              execFileSync("docker", ["network", "rm", "--force", ownedNetwork], {
                stdio: "pipe",
                timeout: 30_000,
              });
            }
          }
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error && (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING")
              ? reject(error)
              : resolve(),
          );
          server.closeAllConnections();
        });
      }
    }, 300_000);
  },
);
