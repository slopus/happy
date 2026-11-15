import type { AccountExportRecord } from "@rakazo/contracts";
import {
  ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES,
  AccountExportManifestSchema,
  AccountExportRecordSchema,
  accountExportPaths,
} from "@rakazo/contracts";
import type { AccountExportSource } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { Unzip, UnzipInflate } from "fflate";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AccountExportStores } from "./account-export.js";
import { accountArchiveFiles, mountAccountExportRoute, zipStream } from "./account-export.js";

const decoder = new TextDecoder();

/** One pass with the streaming reader, as an import does. */
async function unzipStream(stream: ReadableStream<Uint8Array>) {
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  const unzip = new Unzip((file) => {
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      chunks.push(chunk);
      if (final) entries.push({ name: file.name, data: Buffer.concat(chunks) });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for await (const chunk of stream) unzip.push(chunk);
  unzip.push(new Uint8Array(0), true);
  return entries;
}

async function* generate<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}

const createdAt = "2026-01-02T03:04:05.000Z";
const botRecord = (id: string): Extract<AccountExportRecord, { type: "bot" }> => ({
  type: "bot",
  id,
  name: "Chief",
  description: "",
  instructions: "Be brief",
  color: "blue",
  avatarSet: "rakazo",
  notifyOnFinish: true,
  pinned: false,
  position: 0,
  sectionId: null,
  archivedAt: null,
  parentBotId: null,
  memoryScope: null,
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  disabledBuiltinTools: [],
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  crossSpaceCommunication: false,
  dailyCheckIns: false,
  fleetManagement: true,
  replyMode: "chat",
  createdAt,
});

function source(): AccountExportSource {
  const space = (
    id: string,
    records: AccountExportRecord[],
    artifacts: string[],
    bots: string[],
  ) => ({
    id,
    name: `Space ${id}`,
    createdAt,
    records: () => generate(records),
    artifacts: () =>
      generate(
        artifacts.map((artifactId) => ({ id: artifactId, storageKey: `key-${artifactId}` })),
      ),
    homes: async () =>
      bots.map((botId) => ({ botId, homeKey: `home-${botId}`, computerScope: "dedicated" })),
  });
  return {
    userId: "user-1",
    user: { name: "Ada", email: "ada@example.test", timezone: null },
    spaces: [
      space(
        "space-a",
        [
          botRecord("bot-1"),
          {
            type: "thread",
            id: "thread-1",
            botId: "bot-1",
            groupId: null,
            historyCompactedUpToSeq: null,
            historyCompactionSummary: null,
            createdAt,
          },
          {
            type: "message",
            id: "message-1",
            threadId: "thread-1",
            seq: 0,
            role: "user",
            blocks: [{ kind: "text", text: "hi" }],
            botId: null,
            replyToMessageId: null,
            replyQuote: null,
            createdAt,
          },
        ],
        ["artifact-1", "artifact-missing"],
        ["bot-1"],
      ),
      space("space-b", [], [], []),
    ],
  };
}

function stores(): AccountExportStores & { contexts: unknown[] } {
  const contexts: unknown[] = [];
  return {
    contexts,
    artifacts: {
      get: vi.fn(async (key: string) => {
        contexts.push(currentDbContext());
        if (key === "key-artifact-missing") throw new Error("not found");
        return new TextEncoder().encode(`bytes of ${key}`);
      }),
    },
    home: {
      exportHome: async function* () {
        contexts.push(currentDbContext());
        yield { path: "notes/todo.md", content: new TextEncoder().encode("ship it") };
        yield { path: "empty.txt", content: new Uint8Array(0) };
      },
    },
  };
}

describe("account export archive", () => {
  it("preserves the check-in opt-out and defaults older archives to on", () => {
    expect(AccountExportRecordSchema.parse(botRecord("bot-1"))).toMatchObject({
      dailyCheckIns: false,
    });
    const { dailyCheckIns: _dailyCheckIns, ...olderRecord } = botRecord("bot-1");
    expect(AccountExportRecordSchema.parse(olderRecord)).toMatchObject({ dailyCheckIns: true });
  });

  it("streams manifest, then each space's records, artifacts and homes", async () => {
    const fakes = stores();
    const entries = await unzipStream(
      zipStream(accountArchiveFiles(source(), fakes, { now: new Date(createdAt) })),
    );
    expect(entries.map((entry) => entry.name)).toEqual([
      "manifest.json",
      accountExportPaths.records("space-a"),
      accountExportPaths.artifact("space-a", "artifact-1"),
      accountExportPaths.homeFile("space-a", "bot-1", "notes/todo.md"),
      accountExportPaths.homeFile("space-a", "bot-1", "empty.txt"),
      accountExportPaths.records("space-b"),
    ]);
    const manifest = AccountExportManifestSchema.parse(
      JSON.parse(decoder.decode(entries[0]!.data)),
    );
    expect(manifest).toMatchObject({
      exportedAt: createdAt,
      user: { name: "Ada", email: "ada@example.test" },
      spaces: [{ id: "space-a" }, { id: "space-b" }],
    });
    const lines = decoder.decode(entries[1]!.data).trimEnd().split("\n");
    expect(lines.map((line) => AccountExportRecordSchema.parse(JSON.parse(line)).type)).toEqual([
      "bot",
      "thread",
      "message",
    ]);
    expect(decoder.decode(entries[2]!.data)).toBe("bytes of key-artifact-1");
    expect(decoder.decode(entries[3]!.data)).toBe("ship it");
    expect(entries[4]!.data).toHaveLength(0);
    expect(entries[5]!.data).toHaveLength(0);
    expect(fakes.contexts).toEqual(
      Array(3).fill({ kind: "tenant", spaceId: "space-a", userId: "user-1" }),
    );
  });

  it("leaves out workspace files over the import limit", async () => {
    const fakes = stores();
    fakes.home.exportHome = async function* () {
      yield { path: "big.bin", content: new Uint8Array(ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES + 1) };
      yield { path: "small.txt", content: new TextEncoder().encode("kept") };
    };
    const entries = await unzipStream(zipStream(accountArchiveFiles(source(), fakes)));
    expect(entries.map((entry) => entry.name)).toContain(
      accountExportPaths.homeFile("space-a", "bot-1", "small.txt"),
    );
    expect(entries.map((entry) => entry.name)).not.toContain(
      accountExportPaths.homeFile("space-a", "bot-1", "big.bin"),
    );
  });

  it("lists executable workspace files after them", async () => {
    const fakes = stores();
    fakes.home.exportHome = async function* () {
      yield { path: "run.sh", content: new TextEncoder().encode("echo hi"), executable: true };
      yield { path: "notes.md", content: new TextEncoder().encode("plain") };
    };
    const entries = await unzipStream(zipStream(accountArchiveFiles(source(), fakes)));
    const names = entries.map((entry) => entry.name);
    const listed = names.indexOf(accountExportPaths.executables("space-a"));
    expect(listed).toBeGreaterThan(
      names.indexOf(accountExportPaths.homeFile("space-a", "bot-1", "notes.md")),
    );
    expect(JSON.parse(decoder.decode(entries[listed]!.data))).toEqual([
      { botId: "bot-1", path: "run.sh" },
    ]);
    expect(names).not.toContain(accountExportPaths.executables("space-b"));
  });

  it("compresses files that start with zero bytes into data that reads back", async () => {
    // Leading zeros (fonts, many binary formats) let unpatched streaming deflate refer back
    // into its empty window, which every inflater rejects as an invalid distance.
    const content = new Uint8Array(4 + 2048);
    for (let i = 4; i < content.length; i++) content[i] = i % 37 < 8 ? (i * 11) & 0xff : 0;
    const entries = await unzipStream(zipStream(generate([{ path: "font.ttf", data: [content] }])));
    expect(entries).toEqual([{ name: "font.ttf", data: Buffer.from(content) }]);
  });

  it("fails instead of writing an archive past the zip size limit", async () => {
    const reader = zipStream(accountArchiveFiles(source(), stores()), {
      maxBytes: 200,
    }).getReader();
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return;
      })(),
    ).rejects.toThrow("zip size limit");
  });

  it("reports a size-limit failure as a failure even after the request aborts", async () => {
    const error = vi.spyOn(getLogger(), "error");
    const controller = new AbortController();
    controller.abort();
    const reader = zipStream(accountArchiveFiles(source(), stores()), {
      maxBytes: 200,
      signal: controller.signal,
    }).getReader();
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return;
      })(),
    ).rejects.toThrow("zip size limit");
    expect(error).toHaveBeenCalledWith("account.export.failed", expect.anything());
    error.mockRestore();
  });

  it("reads only as fast as it is consumed, and stops when cancelled", async () => {
    let produced = 0;
    let stopped = false;
    async function* endless(): AsyncGenerator<AccountExportRecord> {
      try {
        for (;;) {
          produced += 1;
          yield {
            ...botRecord(`bot-${produced}`),
            instructions: Math.random().toString(36).repeat(50),
          };
        }
      } finally {
        stopped = true;
      }
    }
    const archive = source();
    archive.spaces[0]!.records = endless;
    const reader = zipStream(accountArchiveFiles(archive, stores())).getReader();
    while (produced === 0) expect((await reader.read()).done).toBe(false);
    const afterReads = produced;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(produced).toBe(afterReads);
    await reader.cancel();
    expect(stopped).toBe(true);
  });

  it("ends quietly when the download is cancelled while a file is being read", async () => {
    const error = vi.spyOn(getLogger(), "error");
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slow(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(1);
      await waiting;
      yield new Uint8Array(1);
    }
    const reader = zipStream(generate([{ path: "slow.bin", data: slow() }])).getReader();
    const read = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancelled = reader.cancel();
    release();
    await cancelled;
    await expect(read).resolves.toEqual({ done: true, value: undefined });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("reports an aborted request as a warning, not a failure", async () => {
    const error = vi.spyOn(getLogger(), "error");
    const warn = vi.spyOn(getLogger(), "warn");
    const controller = new AbortController();
    controller.abort("Client connection prematurely closed.");
    const reader = zipStream(
      accountArchiveFiles(source(), stores(), { signal: controller.signal }),
      { signal: controller.signal },
    ).getReader();
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return;
      })(),
    ).rejects.toBe("Client connection prematurely closed.");
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("account.export.aborted", expect.anything());
    error.mockRestore();
    warn.mockRestore();
  });
});

describe("GET /api/account/export", () => {
  it("refuses a token that does not name a user", async () => {
    const app = new Hono();
    const consumeAccountExportToken = vi.fn(async () => null);
    mountAccountExportRoute(app, {
      ...stores(),
      prisma: {} as never,
      auth: { consumeAccountExportToken },
    });
    const response = await app.request("/api/account/export?token=used");
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(consumeAccountExportToken).toHaveBeenCalledWith("used");
  });
});
