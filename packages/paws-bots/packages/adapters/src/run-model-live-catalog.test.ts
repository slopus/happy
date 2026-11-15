import { expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import type * as ModelSelectionModule from "./model-selection.js";
import { resolveConnectedModelKey } from "./run-model.js";

const { validate } = vi.hoisted(() => ({ validate: vi.fn(async () => "stop-before-credentials") }));
vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelSelectionModule>()),
  validateConnectedModelChoice: validate,
}));
it("validates live-only models against the caller's account catalog before reading credentials", async () => {
  const catalog = { read: vi.fn() };
  const deps = {
    prisma: {},
    secretStore: {},
    billingEnabled: false,
    codexCatalog: catalog,
  } as unknown as ExecutorDeps;
  const scope = { userId: "fixture-user", spaceId: "fixture-space" };
  await expect(
    resolveConnectedModelKey(
      deps,
      scope,
      "openai-codex",
      "fixture-live-only",
      undefined,
      true,
      "fixture-connection",
    ),
  ).rejects.toThrow("stop-before-credentials");
  expect(validate).toHaveBeenCalledWith(
    deps.prisma,
    deps.secretStore,
    scope,
    "openai-codex",
    "fixture-live-only",
    expect.objectContaining({ credentialId: "fixture-connection", codexCatalog: catalog }),
  );
});
