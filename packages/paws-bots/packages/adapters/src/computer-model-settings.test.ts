import type { AgentRunModel } from "@rakazo/adapter-kit";
import type { ModelRoleChoice } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { computerCheckpointResolver, resolveComputerRunModel } from "./computer-model-settings.js";

const main: AgentRunModel = {
  provider: "openai",
  id: "gpt-4o",
  connectionId: "account-a",
  apiKey: "fake",
  acceptsImages: true,
};
const scope = { userId: "user", spaceId: "space" };
function setup(choices: ModelRoleChoice[] = [], unavailable: string[] = []) {
  const prisma = {
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: {
      findMany: vi.fn(async () =>
        choices.map((choice, position) => ({
          ...choice,
          credentialId: choice.credentialId ?? null,
          thinkingLevel: choice.thinkingLevel ?? null,
          position,
        })),
      ),
    },
  } as unknown as PrismaClient;
  const resolve = vi.fn(
    async (provider: string, id: string, connectionId?: string, thinkingLevel?: string) => {
      if (unavailable.includes(id)) throw new Error("Connect that model provider again.");
      return { ...main, provider, id, connectionId, thinkingLevel } as AgentRunModel;
    },
  );
  const connectionFor = vi.fn(async () => "account-a" as string | undefined);
  return { prisma, resolve, connectionFor };
}
const vision = { provider: "anthropic", modelId: "claude-sonnet-4-5", credentialId: "account-b" };
describe("computer-use model resolution", () => {
  it("switches to nothing when the member chose no computer model", async () => {
    const deps = setup();
    expect(await resolveComputerRunModel(deps, scope, main)).toBeUndefined();
    expect(deps.resolve).not.toHaveBeenCalled();
  });
  it("runs the chosen model on its own connection", async () => {
    const deps = setup([vision]);
    expect(await resolveComputerRunModel(deps, scope, main)).toMatchObject({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      connectionId: "account-b",
    });
  });
  it("does not switch when the chosen model is the main model on its connection", async () => {
    const deps = setup([{ provider: main.provider, modelId: main.id }]);
    expect(await resolveComputerRunModel(deps, scope, main)).toBeUndefined();
    expect(deps.connectionFor).toHaveBeenCalledWith(main.provider, main.id);
  });
  it("runs the main model's id on another account the member chose", async () => {
    const deps = setup([{ provider: main.provider, modelId: main.id, credentialId: "account-b" }]);
    expect(await resolveComputerRunModel(deps, scope, main)).toMatchObject({
      id: main.id,
      connectionId: "account-b",
    });
  });
  it("runs a choice saved without a connection on the one that serves it", async () => {
    const deps = setup([{ provider: "anthropic", modelId: "claude-sonnet-4-5" }]);
    deps.connectionFor.mockResolvedValueOnce("account-c");
    expect(await resolveComputerRunModel(deps, scope, main)).toMatchObject({
      connectionId: "account-c",
    });
  });
  it("takes the next choice when one is unavailable or cannot see", async () => {
    const deps = setup(
      [
        { ...vision, modelId: "gone" },
        { provider: "deepseek", modelId: "deepseek-chat", credentialId: "account-c" },
        { provider: "openai", modelId: "gpt-4o-mini", credentialId: "account-a" },
      ],
      ["gone"],
    );
    expect(await resolveComputerRunModel(deps, scope, main)).toMatchObject({ id: "gpt-4o-mini" });
  });
  it("skips a model computer mode would refuse, such as one with no key", async () => {
    const deps = setup([vision]);
    deps.resolve.mockResolvedValueOnce({
      ...main,
      ...{ provider: "anthropic", id: "claude-sonnet-4-5" },
      apiKey: undefined,
      connectionId: "account-b",
    });
    expect(await resolveComputerRunModel(deps, scope, main)).toBeUndefined();
  });
  it("leaves the main model on the screen when no choice works", async () => {
    const deps = setup([{ ...vision, modelId: "gone" }], ["gone"]);
    expect(await resolveComputerRunModel(deps, scope, main)).toBeUndefined();
  });
  it("leaves a hosted main model without a computer model, since a pause could not resume it", async () => {
    const deps = setup([vision]);
    const hosted = { ...main, connectionId: undefined };
    expect(await resolveComputerRunModel(deps, scope, hosted)).toBeUndefined();
  });
});
it("leaves legacy checkpoint compatibility to the existing executor, including provider changes", () => {
  expect(
    computerCheckpointResolver(
      JSON.stringify({ version: 1, provider: "anthropic", model: "old", messages: [] }),
      main,
      vi.fn(),
    ),
  ).toBeUndefined();
});
it("checkpoint resolution permits only saved identities, even after settings were cleared", async () => {
  const resolve = vi.fn(async (provider: string, id: string, connectionId?: string) => ({
    ...main,
    provider,
    id,
    connectionId,
  }));
  const checkpoint = JSON.stringify({
    version: 1,
    provider: main.provider,
    model: main.id,
    systemPrompt: "",
    pendingToolCallId: "call",
    messages: [],
    computerMode: {
      version: 1,
      mode: "computer",
      main: { provider: main.provider, id: main.id, connectionId: "account-a", auth: "api-key" },
      computer: {
        provider: "openai",
        id: "gpt-4o-mini",
        connectionId: "account-b",
        auth: "api-key",
      },
    },
  });
  const resolver = computerCheckpointResolver(checkpoint, main, resolve);
  expect(await resolver?.("openai", "gpt-4o-mini", "account-b")).toMatchObject({
    connectionId: "account-b",
  });
  await expect(resolver?.("openai", "gpt-4o-mini", "other")).rejects.toThrow(/pinned/);
});
