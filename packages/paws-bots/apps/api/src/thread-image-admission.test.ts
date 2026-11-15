import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

// Exercise the shared production send entrypoint with an owned stored image.
// No model transport or credential material is needed to reject known text-only input.
function fixture(group = false) {
  const model = { modelProvider: "openrouter", modelId: "deepseek/deepseek-v4-pro" };
  const tx = {
    space: { findUnique: vi.fn(async () => null) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "synthetic" }) },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    chatGroup: {
      findFirst: vi.fn().mockResolvedValue({
        members: [
          { bot: { id: "bot-1", name: "First", color: "blue" } },
          { bot: { id: "bot-2", name: "Second", color: "blue" } },
        ],
      }),
    },
    thread: {
      update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
        data.nextMessageSeq ? { nextMessageSeq: 1 } : { nextEventSeq: 1 },
      ),
    },
    artifact: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: "image-1", name: "picture.png", mimeType: "image/png", size: 4 },
        ]),
    },
    bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot-1", ...model }) },
    userModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
    userModelRoleChoice: { findMany: vi.fn().mockResolvedValue([]) },
    spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
    userModelCredential: {
      findFirst: vi.fn().mockResolvedValue({
        id: "credential-1",
        provider: "openrouter",
        secretId: "secret-1",
        supportsImages: false,
      }),
    },
    deploymentSettings: {
      findUnique: vi.fn().mockResolvedValue({
        defaultModelProvider: model.modelProvider,
        defaultModelId: model.modelId,
      }),
    },
    message: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "message-1", seq: 1 }),
      update: vi.fn(),
    },
    run: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
      create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
    },
    task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
    steeringMessage: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    event: {
      create: vi.fn().mockResolvedValue({ seq: 1 }),
      findFirst: vi.fn().mockResolvedValue({ seq: 1, payload: {} }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  } as unknown as PrismaClient;
  const notify = vi.fn().mockResolvedValue(undefined);
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const releaseTakeover = vi.fn().mockResolvedValue(undefined);
  const send = (
    imageAdmission?: Parameters<typeof sendThreadMessage>[0]["imageAdmission"],
    imageHandling: "confirm" | "file" | null = "confirm",
  ) =>
    sendThreadMessage(
      {
        prisma,
        sandbox: {} as never,
        events: { notify } as never,
        jobs: { enqueue } as never,
        imageAdmission,
      },
      { userId: "user-1", spaceId: "space-1" } as Actor,
      (group
        ? { kind: "group", groupId: "group-1", threadId: "thread-1" }
        : {
            kind: "bot",
            botId: "bot-1",
            threadId: "thread-1",
            bot: { id: "bot-1", ...model, computer: null },
          }) as ThreadTarget,
      {
        text: "Read this picture",
        artifactIds: ["image-1"],
        clientNonce: "image-send-1",
        imageHandling: imageHandling ?? undefined,
        mentions: group ? ["bot-1", "bot-2"] : undefined,
      } as Parameters<typeof sendThreadMessage>[3],
      releaseTakeover,
    );
  return { tx, send, notify, enqueue, releaseTakeover };
}

describe("current image send admission", () => {
  it("preserves legacy clients that omit image handling", async () => {
    const { tx, send } = fixture();
    await expect(send(undefined, null)).resolves.toMatchObject({ runId: "run-1" });
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: expect.arrayContaining([
            { kind: "image", artifactId: "image-1", name: "picture.png", mimeType: "image/png" },
          ]),
        }),
      }),
    );
  });
  it("accepts explicit file intent without losing the image artifact", async () => {
    const { tx, send } = fixture();
    await expect(send(undefined, "file")).resolves.toMatchObject({ runId: "run-1" });
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: expect.arrayContaining([
            {
              kind: "file",
              artifactId: "image-1",
              name: "picture.png",
              mimeType: "image/png",
              size: 4,
            },
          ]),
        }),
      }),
    );
  });

  it.each([false, true])("honors scoped custom image configuration (%s)", async (images) => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openai-compatible",
      modelId: "custom-model",
    });
    tx.userModelCredential.findFirst.mockResolvedValue({
      id: "credential-1",
      provider: "openai-compatible",
      secretId: "secret-1",
      supportsImages: false,
    });
    const configuration = {
      deployment: null,
      secrets: {
        load: vi.fn(async () =>
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://model.example.test/v1",
            enabledModelIds: ["custom-model"],
            visionModelIds: images ? ["custom-model"] : [],
          }),
        ),
      },
    };
    if (images) await expect(send(configuration)).resolves.toMatchObject({ runId: "run-1" });
    // A custom endpoint is never known to be text-only; image input is just not turned on.
    else
      await expect(send(configuration)).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Image input is not configured for this model.",
      });
  });

  it.each([true, false])(
    "uses the Codex account catalog for a live-only model's image input (%s)",
    async (supportsImages) => {
      const { tx, send } = fixture();
      tx.bot.findFirst.mockResolvedValue({
        id: "bot-1",
        modelProvider: "openai-codex",
        modelId: "gpt-6.1-terra",
      });
      tx.userModelCredential.findFirst.mockResolvedValue({
        id: "credential-1",
        provider: "openai-codex",
        secretId: "secret-1",
        defaultModel: "gpt-6.1-terra",
      });
      const configuration = {
        deployment: null,
        secrets: {
          load: vi.fn(async () =>
            JSON.stringify({
              type: "oauth",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 3_600_000,
              accountId: "acct-live",
            }),
          ),
        },
        codexCatalog: {
          read: vi.fn(async () => [
            {
              slug: "gpt-6.1-terra",
              reasoningEfforts: [],
              supportsImages,
              supportsFastTier: false,
            },
          ]),
        },
      };
      if (supportsImages) {
        await expect(send(configuration)).resolves.toMatchObject({ runId: "run-1" });
      } else {
        await expect(send(configuration)).rejects.toMatchObject({
          code: "CONFLICT",
          message: "This model cannot read images. Choose a model that supports images.",
        });
      }
      expect(configuration.codexCatalog.read).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ accountId: "acct-live" }),
        { waitMs: 0 },
      );
    },
  );

  it("keeps a bundled Codex model's images when the account omits input modalities", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openai-codex",
      modelId: "gpt-6.1-sol",
    });
    tx.userModelCredential.findFirst.mockResolvedValue({
      id: "credential-1",
      provider: "openai-codex",
      secretId: "secret-1",
      defaultModel: "gpt-6.1-sol",
    });
    const read = vi.fn(async () => [
      {
        slug: "gpt-6.1-sol",
        reasoningEfforts: [],
        supportsFastTier: false,
      },
    ]);
    await expect(
      send({
        deployment: null,
        secrets: {
          load: vi.fn(async () =>
            JSON.stringify({
              type: "oauth",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 3_600_000,
              accountId: "acct-live",
            }),
          ),
        },
        codexCatalog: { read },
      }),
    ).resolves.toMatchObject({ runId: "run-1" });
    expect(read).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ accountId: "acct-live" }),
      { waitMs: 0 },
    );
  });

  it("asks to configure image input for a legacy custom connection that never set it", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openai-compatible",
      modelId: "custom-model",
    });
    tx.userModelCredential.findFirst.mockResolvedValue({
      id: "credential-1",
      provider: "openai-compatible",
      secretId: "secret-1",
      supportsImages: false,
    });
    const configuration = {
      deployment: null,
      secrets: {
        load: vi.fn(async () =>
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://model.example.test/v1",
            enabledModelIds: ["custom-model"],
          }),
        ),
      },
    };
    await expect(send(configuration)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Image input is not configured for this model.",
    });
  });

  it("does not require image support for document attachments", async () => {
    const { tx, send } = fixture();
    tx.artifact.findMany.mockResolvedValue([
      { id: "image-1", name: "notes.txt", mimeType: "text/plain", size: 4 },
    ]);
    await expect(send()).resolves.toMatchObject({ runId: "run-1" });
    expect(tx.bot.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a mixed-capability group atomically", async () => {
    const { tx, send, enqueue } = fixture(true);
    tx.bot.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      modelProvider: "openrouter",
      modelId: where.id === "bot-1" ? "openai/gpt-4o" : "deepseek/deepseek-v4-pro",
    }));
    await expect(send()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.bot.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("replays an accepted nonce before validating attachments or current capabilities", async () => {
    const { tx, send } = fixture();
    tx.message.findUnique.mockResolvedValue({
      id: "accepted",
      seq: 7,
      sourceRuns: [{ id: "accepted-run", taskId: "accepted-task", status: "done" }],
    } as never);
    await expect(send()).resolves.toMatchObject({ seq: 7, runId: "accepted-run" });
    expect(tx.artifact.findMany).not.toHaveBeenCalled();
    expect(tx.bot.findFirst).not.toHaveBeenCalled();
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("uses a running text-only model even after the bot changes to vision", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openrouter",
      modelId: "openai/gpt-4o",
    });
    tx.run.findMany.mockResolvedValue([
      {
        id: "active",
        taskId: "task-active",
        status: "running",
        trigger: "user",
        userId: "user-1",
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        modelPinned: false,
      },
    ] as never);
    await expect(send()).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("matches a legacy image default with surrounding whitespace like the executor", async () => {
    const { tx, send } = fixture();
    const stored = " custom-model ";
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openai-compatible",
      modelId: stored,
    });
    tx.userModelPreference.findFirst.mockResolvedValue({
      id: "preference-1",
      modelId: stored,
      isDefault: true,
      thinkingLevel: null,
      updatedAt: new Date(0),
      credential: {
        id: "credential-1",
        userId: "user-1",
        provider: "openai-compatible",
        label: "Custom",
        secretId: "secret-1",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    } as never);
    tx.userModelCredential.findFirst.mockResolvedValue({
      id: "credential-1",
      provider: "openai-compatible",
      secretId: "secret-1",
      supportsImages: true,
    });
    // A running turn compares its stored model id directly with the saved default.
    tx.run.findMany.mockResolvedValue([
      {
        id: "active",
        taskId: "task-active",
        status: "running",
        trigger: "user",
        modelProvider: "openai-compatible",
        modelId: stored,
        modelPinned: false,
      },
    ] as never);
    const configuration = {
      deployment: null,
      secrets: {
        load: vi.fn(async () =>
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://model.example.test/v1",
            enabledModelIds: ["custom-model"],
          }),
        ),
      },
    };
    await send(configuration);
    expect(tx.message.create).toHaveBeenCalled();
  });

  it("uses a pinned waiting run rather than a vision bot setting", async () => {
    const { tx, send } = fixture();
    tx.message.findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "ask-1", blocks: [{ kind: "ask", text: "Question", status: "pending" }] },
      ]);
    tx.message.findFirst.mockResolvedValue({ id: "ask-1", role: "bot", blocks: [] } as never);
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openrouter",
      modelId: "openai/gpt-4o",
    });
    tx.run.findMany.mockResolvedValue([
      {
        id: "waiting",
        taskId: "task-waiting",
        status: "waiting_input",
        trigger: "routine",
        userId: "user-1",
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        modelPinned: true,
      },
    ] as never);
    await expect(send()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("does not use an obsolete waiting pin when the actual send starts a new turn", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openrouter",
      modelId: "openai/gpt-4o",
    });
    tx.run.findMany
      .mockResolvedValueOnce([
        {
          id: "obsolete",
          taskId: "obsolete-task",
          status: "waiting_input",
          userId: "user-1",
          trigger: "routine",
          modelProvider: "openrouter",
          modelId: "deepseek/deepseek-v4-pro",
          modelPinned: true,
        },
      ] as never)
      .mockResolvedValue([]);
    tx.run.findFirst = vi.fn().mockResolvedValue(null);
    await expect(send()).resolves.toMatchObject({ runId: "run-1" });
  });
  it("offers honest configuration confirmation for an unknown effective text-only transport", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openrouter",
      modelId: "fixture/future-model",
    });
    await expect(send()).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Image input is not configured for this model.",
    });
  });
  it("follows the member's main model when the bot has none", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({ id: "bot-1", modelProvider: null, modelId: null });
    // The deployment default can see images; the main model chosen by the member cannot.
    tx.deploymentSettings.findUnique.mockResolvedValue({
      defaultModelProvider: "openrouter",
      defaultModelId: "openai/gpt-4o",
    });
    tx.userModelRoleChoice.findMany.mockResolvedValue([
      {
        position: 0,
        provider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        thinkingLevel: null,
      },
    ]);
    await expect(send()).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("rejects a known text-only effective model before persisting or waking work", async () => {
    const { tx, send, notify, enqueue, releaseTakeover } = fixture();
    await expect(send()).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.thread.update).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(releaseTakeover).not.toHaveBeenCalled();
  });
});
