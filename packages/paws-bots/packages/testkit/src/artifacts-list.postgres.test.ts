import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Listing = {
  items: { name: string; version: number; versionCount: number }[];
  nextCursor: string | null;
};

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("artifacts.listSpace made by bots", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-artifacts-list-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    prisma = asSystem(handles.prisma);
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("keeps files whose newest version a bot made, page by page", async () => {
    const cookie = await signup(app, `artifacts-list-${Date.now()}@rakazo.test`);
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Analyst",
      title: "Analyst",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const upload = (name: string) =>
      rpc<{ id: string }>(app, cookie, "artifacts/create", {
        botId: bot.id,
        name,
        mimeType: "text/plain",
        contentBase64: Buffer.from(name).toString("base64"),
      });
    const owner = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
    const madeByBot = (
      name: string,
      createdAt: Date,
      family?: { rootArtifactId: string; version: number },
    ) =>
      prisma.artifact.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: bot.id,
          runId: `run-${name}-${family?.version ?? 1}`,
          name,
          mimeType: "text/markdown",
          size: 6,
          hash: name,
          storageKey: `blob-${name}-${family?.version ?? 1}`,
          createdAt,
          ...family,
        },
      });

    await upload("my-upload.txt");
    await madeByBot("older-report.md", new Date("2026-01-01T00:00:00.000Z"));
    await madeByBot("newer-report.md", new Date("2026-01-02T00:00:00.000Z"));
    // A bot's file the user then uploads again under the same name.
    await madeByBot("plan.md", new Date("2026-01-03T00:00:00.000Z"));
    await upload("plan.md");
    // An upload a bot then writes a new version of.
    const draft = await upload("draft.md");
    await madeByBot("draft.md", new Date(), { rootArtifactId: draft.id, version: 2 });

    const list = (input: Record<string, unknown>) =>
      rpc<Listing>(app, cookie, "artifacts/listSpace", input);
    const shown = (listing: Listing) =>
      listing.items.map(({ name, version, versionCount }) => [name, version, versionCount]);

    const everything = await list({});
    expect(shown(everything)).toEqual([
      ["draft.md", 2, 2],
      ["plan.md", 2, 2],
      ["my-upload.txt", 1, 1],
      ["newer-report.md", 1, 1],
      ["older-report.md", 1, 1],
    ]);
    expect(shown(await list({ madeByBots: true }))).toEqual([
      ["draft.md", 2, 2],
      ["newer-report.md", 1, 1],
      ["older-report.md", 1, 1],
    ]);

    const first = await list({ madeByBots: true, limit: 2 });
    expect(first.items.map((item) => item.name)).toEqual(["draft.md", "newer-report.md"]);
    const second = await list({ madeByBots: true, limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.name)).toEqual(["older-report.md"]);
    expect(second.nextCursor).toBeNull();

    const firstOfAll = await list({ limit: 1 });
    await expect(list({ madeByBots: true, cursor: firstOfAll.nextCursor })).rejects.toThrow(
      "artifacts/listSpace 400",
    );
  });
});

async function signup(app: App, email: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name: "Artifacts User" }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const response = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const parsed = JSON.parse(await response.text()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${response.status}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}
