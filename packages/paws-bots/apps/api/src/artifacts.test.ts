import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { attachmentComputerPath } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactListCursorError,
  createOwnedArtifact,
  deleteArtifactFamily,
  getOwnedArtifact,
  getSpaceArtifact,
  getSpaceArtifactById,
  listArtifactVersions,
  listSpaceArtifacts,
  resolveGroupSendAttachments,
  resolveSendAttachments,
  storeInboundAttachment,
} from "./artifacts.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: false,
};

function listRow(id: string, familyId: string, createdAt = "2026-09-01T00:00:00.000Z") {
  return {
    id,
    familyId,
    botId: "bot-1",
    groupId: null,
    runId: null,
    name: familyId,
    description: null,
    mimeType: "text/markdown",
    size: 12,
    version: 1,
    createdAt: new Date(createdAt),
    versionCount: 1,
  };
}

function cursor(input: { createdAt: string; id: string; botId: string | null; asOf?: string }) {
  return `v1.${Buffer.from(
    JSON.stringify({
      createdAt: input.createdAt,
      id: input.id,
      botId: input.botId,
      madeByBots: false,
      asOf: input.asOf ?? "2026-09-20T00:00:00.000Z",
    }),
    "utf8",
  ).toString("base64url")}`;
}

function statement(query: { strings: string[] }) {
  return query.strings.join(" ");
}

function scopedClause(query: { strings: string[] }) {
  const text = statement(query);
  return text.slice(text.indexOf("WITH scoped"), text.indexOf("latest AS"));
}

describe("listSpaceArtifacts", () => {
  it("pages families in the database instead of slicing a fixed newest-row snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    try {
      const queryRaw = vi
        .fn()
        .mockResolvedValue([
          listRow("version-a", "family-a"),
          listRow("version-b", "family-b"),
          listRow("version-c", "family-c"),
        ]);
      const page = await listSpaceArtifacts(
        {
          prisma: { artifact: { findFirst: vi.fn() }, $queryRaw: queryRaw } as unknown as Pick<
            PrismaClient,
            "artifact" | "$queryRaw"
          >,
        },
        actor,
        { limit: 2 },
      );

      const sql = queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] };
      const text = statement(sql);
      expect(text).toContain("DISTINCT ON");
      expect(text).toContain("LIMIT");
      expect(text).not.toMatch(/\b500\b/);
      expect(scopedClause(sql)).toContain('"createdAt" <=');
      expect(sql.values).toContain(3);
      expect(sql.values).toContainEqual(new Date("2026-09-20T12:00:00.000Z"));
      expect(page.items.map((item) => item.id)).toEqual(["family-a", "family-b"]);
      expect(page.nextCursor).toBe(
        cursor({
          createdAt: "2026-09-01T00:00:00.000Z",
          id: "version-b",
          botId: null,
          asOf: "2026-09-20T12:00:00.000Z",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unseen family on a later page when it gains a version after page one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    try {
      const queryRaw = vi
        .fn()
        .mockResolvedValueOnce([
          listRow("version-a", "family-a", "2026-09-03T00:00:00.000Z"),
          listRow("version-b", "family-b", "2026-09-02T00:00:00.000Z"),
          listRow("version-c", "family-c", "2026-09-01T00:00:00.000Z"),
        ])
        .mockResolvedValueOnce([listRow("version-c", "family-c", "2026-09-01T00:00:00.000Z")]);
      const deps = {
        prisma: { artifact: { findFirst: vi.fn() }, $queryRaw: queryRaw } as unknown as Pick<
          PrismaClient,
          "artifact" | "$queryRaw"
        >,
      };
      const first = await listSpaceArtifacts(deps, actor, { limit: 2 });
      vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
      const second = await listSpaceArtifacts(deps, actor, {
        cursor: first.nextCursor ?? undefined,
        limit: 2,
      });

      const continuation = queryRaw.mock.calls[1]?.[0] as { strings: string[]; values: unknown[] };
      expect(scopedClause(continuation)).toContain('"createdAt" <=');
      expect(continuation.values).toContainEqual(new Date("2026-09-20T12:00:00.000Z"));
      expect(continuation.values).not.toContainEqual(new Date("2026-09-21T12:00:00.000Z"));
      expect(continuation.values).toContain("version-b");
      expect(second.items.map((item) => item.id)).toEqual(["family-c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a cursor that has no version snapshot", async () => {
    const legacy = `v1.${Buffer.from(
      JSON.stringify({
        createdAt: "2026-08-01T00:00:00.000Z",
        id: "version-b",
        botId: null,
      }),
      "utf8",
    ).toString("base64url")}`;
    const queryRaw = vi.fn();
    await expect(
      listSpaceArtifacts(
        {
          prisma: { artifact: { findFirst: vi.fn() }, $queryRaw: queryRaw } as unknown as Pick<
            PrismaClient,
            "artifact" | "$queryRaw"
          >,
        },
        actor,
        { cursor: legacy, limit: 2 },
      ),
    ).rejects.toBeInstanceOf(ArtifactListCursorError);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("keeps paging from a cursor whose row was deleted", async () => {
    const pageCursor = cursor({
      createdAt: "2026-08-01T00:00:00.000Z",
      id: "version-b",
      botId: null,
    });
    const findFirst = vi.fn();
    const queryRaw = vi.fn().mockResolvedValue([]);
    await listSpaceArtifacts(
      {
        prisma: { artifact: { findFirst }, $queryRaw: queryRaw } as unknown as Pick<
          PrismaClient,
          "artifact" | "$queryRaw"
        >,
      },
      actor,
      { cursor: pageCursor, limit: 2 },
    );

    expect(findFirst).not.toHaveBeenCalled();
    const sql = queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] };
    expect(statement(sql)).toContain('latest."createdAt", latest.id');
    expect(scopedClause(sql)).toContain('"createdAt" <=');
    expect(sql.values).toContainEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(sql.values).toContainEqual(new Date("2026-09-20T00:00:00.000Z"));
    expect(sql.values).toContain("version-b");
  });

  it("rejects a cursor from a different bot filter instead of replaying the first page", async () => {
    const queryRaw = vi.fn();
    await expect(
      listSpaceArtifacts(
        {
          prisma: { artifact: { findFirst: vi.fn() }, $queryRaw: queryRaw } as unknown as Pick<
            PrismaClient,
            "artifact" | "$queryRaw"
          >,
        },
        actor,
        {
          botId: "bot-2",
          cursor: cursor({
            createdAt: "2026-08-01T00:00:00.000Z",
            id: "version-b",
            botId: "bot-1",
          }),
        },
      ),
    ).rejects.toBeInstanceOf(ArtifactListCursorError);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("reads a cursor issued before the made-by-bots filter as the full list", async () => {
    const issuedBefore = `v1.${Buffer.from(
      JSON.stringify({
        createdAt: "2026-08-01T00:00:00.000Z",
        id: "version-b",
        botId: null,
        asOf: "2026-09-20T00:00:00.000Z",
      }),
      "utf8",
    ).toString("base64url")}`;
    const queryRaw = vi.fn().mockResolvedValue([]);
    const deps = {
      prisma: { artifact: { findFirst: vi.fn() }, $queryRaw: queryRaw } as unknown as Pick<
        PrismaClient,
        "artifact" | "$queryRaw"
      >,
    };
    await listSpaceArtifacts(deps, actor, { cursor: issuedBefore });
    expect(queryRaw.mock.calls[0]?.[0].values).toContain("version-b");
    await expect(
      listSpaceArtifacts(deps, actor, { madeByBots: true, cursor: issuedBefore }),
    ).rejects.toBeInstanceOf(ArtifactListCursorError);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("applies a bot-scoped cursor with that bot filter", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const pageCursor = cursor({
      createdAt: "2026-08-01T00:00:00.000Z",
      id: "version-b",
      botId: "bot-1",
    });
    await listSpaceArtifacts(
      {
        prisma: { artifact: { findFirst: vi.fn() }, $queryRaw: queryRaw } as unknown as Pick<
          PrismaClient,
          "artifact" | "$queryRaw"
        >,
      },
      actor,
      { botId: "bot-1", cursor: pageCursor, limit: 2 },
    );

    const sql = queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] };
    const text = sql.strings.join(" ");
    expect(text).toContain('"botId"');
    expect(text).not.toContain('"botId" IS NULL');
    expect(sql.values).toContain("bot-1");
    expect(sql.values).toContain("version-b");
  });
});

describe("deleteArtifactFamily", () => {
  function familyClient(listings: Array<Array<{ id: string; storageKey: string; botId: string }>>) {
    const calls: string[] = [];
    let read = 0;
    let rootChecks = 0;
    const deferRootDeletes = { count: 0 };
    const prisma = {
      artifact: {
        findFirst: vi.fn(async () => ({ id: "root", rootArtifactId: null, botId: "bot-1" })),
        findMany: vi.fn(async () => {
          const page = listings[Math.min(read, listings.length - 1)] ?? [];
          read += 1;
          return page;
        }),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          calls.push(`delete:${where.id}`);
        }),
      },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<void>) => {
        await run({
          $queryRaw: vi.fn(async () => [{ id: "root" }]),
          artifact: {
            findFirst: vi.fn(async () => {
              rootChecks += 1;
              return rootChecks <= deferRootDeletes.count ? { id: "v2" } : null;
            }),
            delete: vi.fn(async ({ where }: { where: { id: string } }) => {
              calls.push(`delete:${where.id}`);
            }),
          },
        });
      }),
    };
    return { calls, deferRootDeletes, prisma: prisma as unknown as PrismaClient };
  }

  it("removes each blob before its row and versions before the root", async () => {
    const client = familyClient([
      [
        { id: "root", storageKey: "blob-root", botId: "bot-1" },
        { id: "v2", storageKey: "blob-v2", botId: "bot-1" },
      ],
      [{ id: "root", storageKey: "blob-root", botId: "bot-1" }],
      [],
    ]);
    const remove = vi.fn(async (id: string) => {
      client.calls.push(`remove:${id}`);
    });

    await expect(
      deleteArtifactFamily(
        {
          prisma: client.prisma,
          artifacts: { remove } as unknown as ArtifactStore,
        },
        actor,
        { familyId: "root" },
      ),
    ).resolves.toEqual({ ok: true });

    expect(client.calls).toEqual([
      "remove:blob-v2",
      "delete:v2",
      "remove:blob-root",
      "delete:root",
    ]);
  });

  it("leaves the row in place when blob removal fails", async () => {
    const client = familyClient([[{ id: "root", storageKey: "blob-root", botId: "bot-1" }]]);
    const remove = vi.fn(async () => {
      throw new Error("storage down");
    });

    await expect(
      deleteArtifactFamily(
        {
          prisma: client.prisma,
          artifacts: { remove } as unknown as ArtifactStore,
        },
        actor,
        { familyId: "root" },
      ),
    ).rejects.toThrow("storage down");
    expect(client.calls).toEqual([]);
  });

  it("does not remove the root blob when a version appears before the root is deleted", async () => {
    const client = familyClient([
      [{ id: "root", storageKey: "blob-root", botId: "bot-1" }],
      [
        { id: "root", storageKey: "blob-root", botId: "bot-1" },
        { id: "v2", storageKey: "blob-v2", botId: "bot-1" },
      ],
      [{ id: "root", storageKey: "blob-root", botId: "bot-1" }],
      [],
    ]);
    client.deferRootDeletes.count = 1;
    const remove = vi.fn(async (id: string) => {
      client.calls.push(`remove:${id}`);
    });

    await deleteArtifactFamily(
      {
        prisma: client.prisma,
        artifacts: { remove } as unknown as ArtifactStore,
      },
      actor,
      { familyId: "root" },
    );

    expect(client.calls).toEqual([
      "remove:blob-v2",
      "delete:v2",
      "remove:blob-root",
      "delete:root",
    ]);
  });

  it("finishes a retry when the blob was already removed", async () => {
    const client = familyClient([[{ id: "root", storageKey: "blob-root", botId: "bot-1" }]]);
    const remove = vi.fn(async (id: string) => {
      client.calls.push(`remove:${id}`);
      const missing = new Error("missing");
      Object.assign(missing, { code: "ENOENT" });
      throw missing;
    });

    await expect(
      deleteArtifactFamily(
        {
          prisma: client.prisma,
          artifacts: { remove } as unknown as ArtifactStore,
        },
        actor,
        { familyId: "root" },
      ),
    ).resolves.toEqual({ ok: true });
    expect(client.calls).toEqual(["remove:blob-root", "delete:root"]);
  });
});

describe("configured artifact upload limit", () => {
  it("normalizes uploads before validation/storage", async () => {
    const reachedStorage = new Error("reached storage");
    const put = vi.fn().mockRejectedValue(reachedStorage);
    const deps = { prisma: {} as PrismaClient, artifacts: { put } as unknown as ArtifactStore };
    await expect(
      createOwnedArtifact(deps, actor, {
        botId: "bot-1",
        name: "song.m4a",
        mimeType: "audio/aac",
        contentBase64: "YXVkaW8=",
      }),
    ).rejects.toBe(reachedStorage);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "audio/mp4" }),
      expect.anything(),
    );
    put.mockClear();
    await expect(
      createOwnedArtifact(deps, actor, {
        botId: "bot-1",
        name: "song.flac",
        mimeType: "audio/flac",
        contentBase64: "YXVkaW8=",
      }),
    ).rejects.toThrow("Unsupported attachment type");
    expect(put).not.toHaveBeenCalled();
  });
  it("rejects oversized attachments before storage and accepts uploads above the old cap", async () => {
    const stored = new Error("reached storage");
    const put = vi.fn().mockRejectedValue(stored);
    const deps = {
      prisma: {} as PrismaClient,
      artifacts: { put } as unknown as ArtifactStore,
      maxUploadSizeBytes: 12 * 1024 * 1024,
    };
    const upload = (size: number) =>
      createOwnedArtifact(deps, actor, {
        botId: "bot-1",
        name: "notes.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.alloc(size).toString("base64"),
      });
    await expect(upload(deps.maxUploadSizeBytes + 1)).rejects.toThrow("12 MiB limit");
    expect(put).not.toHaveBeenCalled();
    await expect(upload(deps.maxUploadSizeBytes)).rejects.toBe(stored);
    expect(put).toHaveBeenCalledOnce();
  });
});

describe("storeInboundAttachment", () => {
  const reachedStorage = new Error("reached storage");
  function setup(existing: unknown = null) {
    const put = vi.fn().mockRejectedValue(reachedStorage);
    const findFirst = vi.fn(async () => existing);
    const deps = {
      prisma: { artifact: { findFirst } } as unknown as PrismaClient,
      artifacts: { put } as unknown as ArtifactStore,
      maxUploadSizeBytes: 8,
    };
    const store = (
      attachment: Parameters<typeof storeInboundAttachment>[2]["attachment"],
      downloadDeadline?: number,
    ) =>
      storeInboundAttachment(deps, actor, {
        botId: "bot-1",
        attachment,
        clientNonce: "nonce-1",
        downloadDeadline,
      });
    return { put, store, findFirst };
  }

  it("bounds a stalled download and does not store its late result", async () => {
    vi.useFakeTimers();
    try {
      const { put, store } = setup();
      let finish!: (bytes: Uint8Array) => void;
      const download = new Promise<Uint8Array>((resolve) => {
        finish = resolve;
      });
      const result = store({ name: "a.png", mimeType: "image/png", fetch: () => download });
      const rejected = expect(result).rejects.toThrow("Attachment download timed out");
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      finish(new Uint8Array(3));
      await Promise.resolve();
      expect(put).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start another download after the shared deadline", async () => {
    const { put, store } = setup();
    const fetch = vi.fn(async () => new Uint8Array(3));
    await expect(
      store({ name: "a.png", mimeType: "image/png", fetch }, Date.now() - 1),
    ).rejects.toThrow("Attachment download timed out");
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("skips the download when the platform reports an oversize file", async () => {
    const { put, store } = setup();
    const fetch = vi.fn(async () => new Uint8Array(4));
    await expect(store({ name: "a.png", mimeType: "image/png", size: 9, fetch })).rejects.toThrow(
      "limit",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("stores a CSV that a chat platform labelled as Excel as CSV", async () => {
    const { put, store } = setup();
    const fetch = vi.fn(async () => new Uint8Array(4));
    await expect(
      store({ name: "sales.csv", mimeType: "application/vnd.ms-excel", fetch }),
    ).rejects.toBe(reachedStorage);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "text/csv" }),
      expect.anything(),
    );
  });

  it("rejects unsupported types and oversize downloads before storage", async () => {
    const { put, store } = setup();
    const fetch = vi.fn(async () => new Uint8Array(9));
    await expect(
      store({ name: "a.exe", mimeType: "application/x-msdownload", fetch }),
    ).rejects.toThrow("Unsupported");
    await expect(store({ name: "a.png", mimeType: "image/png", fetch })).rejects.toThrow("limit");
    expect(put).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(new Uint8Array(8));
    await expect(store({ name: "a.png", mimeType: "image/png", fetch })).rejects.toBe(
      reachedStorage,
    );
  });

  it("reuses the artifact an earlier delivery of the same file stored", async () => {
    const { put, store, findFirst } = setup({
      id: "artifact-1",
      botId: "bot-1",
      groupId: null,
      runId: null,
      name: "a.png",
      description: null,
      mimeType: "image/png",
      size: 3,
      version: 1,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    const fetch = vi.fn(async () => new Uint8Array(3));
    const replayed = await store({ name: "a.png", mimeType: "image/png", fetch }, Date.now() - 1);
    expect(replayed).toMatchObject({
      id: "artifact-1",
    });
    expect(replayed.bytes).toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith({
      where: { spaceId: actor.spaceId, userId: actor.userId, clientNonce: "nonce-1" },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("returns the downloaded bytes with a freshly stored artifact", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const row = {
      id: "artifact-9",
      botId: "bot-1",
      groupId: null,
      runId: null,
      name: "voice.oga",
      description: null,
      mimeType: "audio/ogg",
      size: bytes.byteLength,
      version: 1,
      createdAt: new Date(0),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      artifact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(row),
      },
    };
    const deps = {
      prisma: {
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      } as unknown as PrismaClient,
      artifacts: { put: vi.fn().mockResolvedValue({ id: "store-1" }) } as unknown as ArtifactStore,
    };
    const stored = await storeInboundAttachment(deps, actor, {
      botId: "bot-1",
      attachment: { name: "voice.oga", mimeType: "audio/ogg", fetch: async () => bytes },
      clientNonce: "nonce-2",
    });
    expect(stored).toMatchObject({ id: "artifact-9", mimeType: "audio/ogg" });
    expect(stored.bytes).toBe(bytes);
  });

  it("stores a WhatsApp voice note whose MIME type carries parameters", async () => {
    // WhatsApp Cloud API reports voice notes as "audio/ogg; codecs=opus"
    // with a parameter-less file name, so the type must be normalized
    // before it is matched against the allowlist.
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const row = {
      id: "artifact-11",
      botId: "bot-1",
      groupId: null,
      runId: null,
      name: "voice",
      description: null,
      mimeType: "audio/ogg",
      size: bytes.byteLength,
      version: 1,
      createdAt: new Date(0),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      artifact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(row),
      },
    };
    const deps = {
      prisma: {
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      } as unknown as PrismaClient,
      artifacts: { put: vi.fn().mockResolvedValue({ id: "store-2" }) } as unknown as ArtifactStore,
    };
    const stored = await storeInboundAttachment(deps, actor, {
      botId: "bot-1",
      attachment: { name: "voice", mimeType: "audio/ogg; codecs=opus", fetch: async () => bytes },
      clientNonce: "nonce-3",
    });
    expect(stored).toMatchObject({ id: "artifact-11", mimeType: "audio/ogg" });
    expect(attachmentComputerPath(stored.id, stored.mimeType)).toBe(`attachments/${stored.id}.ogg`);
    expect(stored.bytes).toBe(bytes);
  });

  it("stores a standalone file apart from a same-name file's versions", async () => {
    const existing = { id: "owner-report", rootArtifactId: null, version: 2 };
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: "artifact-10",
      runId: null,
      description: null,
      createdAt: new Date(0),
    }));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      artifact: {
        // The nonce replay check finds nothing; the version lookup finds the owner's file.
        findFirst: vi.fn(async ({ where }: { where: { clientNonce?: string } }) =>
          where.clientNonce ? null : existing,
        ),
        create,
      },
    };
    const deps = {
      prisma: {
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      } as unknown as PrismaClient,
      artifacts: { put: vi.fn().mockResolvedValue({ id: "store-2" }) } as unknown as ArtifactStore,
    };
    const store = (standalone: boolean) =>
      storeInboundAttachment(deps, actor, {
        botId: "bot-1",
        attachment: {
          name: "report.pdf",
          mimeType: "application/pdf",
          fetch: async () => new Uint8Array([1]),
        },
        clientNonce: "nonce-3",
        standalone,
      });

    await store(true);
    await store(false);

    expect(create.mock.calls.map(([{ data }]) => [data.rootArtifactId, data.version])).toEqual([
      [null, 1],
      ["owner-report", 3],
    ]);
  });
});

describe("send attachment count", () => {
  it.each(["bot", "group"])("enforces the deployment limit for %s attachments", async (target) => {
    const findMany = vi.fn().mockImplementation(async ({ where }) =>
      where.id.in.map((id: string) => ({
        id,
        name: `${id}.txt`,
        mimeType: "text/plain",
        size: 1,
        storageKey: id,
      })),
    );
    const prisma = { artifact: { findMany } } as unknown as PrismaClient;
    const send = (maxAttachmentsPerMessage: number | undefined, count: number) => {
      const deps = { prisma, maxAttachmentsPerMessage };
      const ids = Array.from({ length: count }, (_, i) => `artifact-${i}`);
      return target === "bot"
        ? resolveSendAttachments(deps, actor, "bot-1", ids)
        : resolveGroupSendAttachments(deps, actor, "group-1", ["bot-1"], ids);
    };
    for (const limit of [undefined, 1, 8, 100]) {
      findMany.mockClear();
      const effective = limit ?? 4;
      await expect(send(limit, effective + 1)).rejects.toThrow(
        `At most ${effective} attachments per message`,
      );
      expect(findMany).not.toHaveBeenCalled();
      await expect(send(limit, effective)).resolves.toMatchObject({ blocks: expect.any(Array) });
      expect(findMany).toHaveBeenCalledOnce();
    }
  });
});

describe("a reply's kept screenshot", () => {
  it("cannot be opened from a client, by a group member or anyone else", async () => {
    const row = {
      id: "shot-1",
      botId: "bot-1",
      groupId: "group-1",
      runId: "run-1",
      storageKey: "stored-shot",
      name: "screenshot",
      description: null,
      mimeType: "image/png;profile=step-screenshot",
      size: 3,
      version: 1,
      createdAt: new Date(),
    };
    const get = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const deps = {
      prisma: { artifact: { findFirst: vi.fn(async () => row) } } as unknown as PrismaClient,
      artifacts: { get } as unknown as ArtifactStore,
    };
    const member: Actor = { ...actor, userId: "member-1" };
    await expect(
      getSpaceArtifact(deps, member, {
        artifactId: "shot-1",
        groupId: "group-1",
        contextBotId: "bot-1",
      }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      getSpaceArtifactById(deps, member, { artifactId: "shot-1" }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      getOwnedArtifact(deps, actor, { artifactId: "shot-1", botId: "bot-1" }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(get).not.toHaveBeenCalled();
  });

  it("is neither listed as a file's versions nor deletable from a client", async () => {
    const findFirst = vi.fn(async () => null);
    const prisma = { artifact: { findFirst, findMany: vi.fn() } } as unknown as PrismaClient;
    await expect(
      listArtifactVersions({ prisma }, actor, { familyId: "shot-1" }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      deleteArtifactFamily({ prisma, artifacts: {} as ArtifactStore }, actor, {
        familyId: "shot-1",
      }),
    ).rejects.toBeInstanceOf(IsolationError);
    for (const [query] of findFirst.mock.calls as unknown as Array<[{ where: unknown }]>)
      expect(query.where).toMatchObject({
        mimeType: { notIn: expect.arrayContaining(["image/png;profile=step-screenshot"]) },
      });
  });
});
