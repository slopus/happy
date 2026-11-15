import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { listPiCatalog } from "./pi-models.js";

describe("funding selects credentials without deleting saved connections", () => {
  describe.each([false, true])("with stored-secret requirement=%s", (requireStoredSecret) => {
    it.each([
      { billingEnabled: true, mode: "credits", provider: "openrouter", hosted: false },
      {
        billingEnabled: true,
        mode: "credits",
        balanceMicros: 1_000_000n,
        provider: "openrouter",
        hosted: false,
      },
      {
        billingEnabled: true,
        mode: "credits",
        provider: "openrouter",
        hosted: true,
        personal: false,
      },
      {
        billingEnabled: true,
        mode: "byok",
        provider: "openrouter",
        hosted: false,
        personal: false,
        rejected: true,
      },
      { billingEnabled: true, mode: "byok", provider: "openrouter", hosted: false },
      // A balance pays until the member connects the provider themselves.
      {
        billingEnabled: true,
        mode: "byok",
        balanceMicros: 1n,
        provider: "openrouter",
        hosted: true,
        personal: false,
      },
      {
        billingEnabled: true,
        mode: "byok",
        balanceMicros: 1n,
        provider: "openrouter",
        hosted: false,
      },
      { billingEnabled: false, mode: "credits", provider: "openrouter", hosted: false },
      { billingEnabled: true, mode: "credits", provider: "openai", hosted: false },
    ])(
      "$mode funding for $provider with billing=$billingEnabled",
      async ({
        billingEnabled,
        mode,
        balanceMicros = 0n,
        provider,
        hosted,
        personal = true,
        rejected = false,
      }) => {
        vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
        vi.stubEnv("OPENROUTER_API_KEY", "fixture-deployment-key");
        try {
          const model = listPiCatalog().find((entry) => entry.provider === provider)!;
          const load = vi.fn().mockResolvedValue("fixture-personal-key");
          const executor = createRunExecutor({
            billingEnabled,
            deploymentModelKey: "fixture-deployment-key",
            secretStore: { load, put: vi.fn() },
            prisma: {
              deploymentSettings: {
                findUnique: async () => ({ modelCreditsEnabled: billingEnabled }),
              },
              userModelPreference: {
                findFirst: async () =>
                  personal
                    ? {
                        credential: { id: "personal", provider, secretId: "personal-secret" },
                        modelId: model.id,
                      }
                    : null,
              },
              userModelCredential: {
                findFirst: async () => (personal ? { id: "personal" } : null),
              },
              secret: {
                findFirst: async () => ({
                  id: "personal-secret",
                  ciphertext: "fixture-ciphertext",
                }),
              },
              space: {
                findFirst: async () => ({
                  organization: { modelCredits: { mode, balanceMicros } },
                }),
                findUnique: async () => ({ organizationId: "org" }),
              },
              member: { findUnique: async () => ({ role: "owner" }) },
              billingAccount: { findUnique: async () => null },
              modelCreditAccount: { upsert: async () => ({ mode, balanceMicros }) },
            },
          } as unknown as Parameters<typeof createRunExecutor>[0]);
          if (rejected) {
            await expect(
              executor.resolveConnectedModel(
                { userId: "user", spaceId: "space" },
                provider,
                model.id,
                undefined,
                requireStoredSecret,
              ),
            ).rejects.toThrow("Connect that model provider first");
            expect(load).not.toHaveBeenCalled();
            return;
          }
          const resolved = await executor.resolveConnectedModel(
            { userId: "user", spaceId: "space" },
            provider,
            model.id,
            undefined,
            requireStoredSecret,
          );
          expect(resolved.apiKey).toBe(hosted ? "fixture-deployment-key" : "fixture-personal-key");
          expect(Boolean(resolved.callObserver)).toBe(hosted);
          expect(load.mock.calls.length).toBe(hosted ? 0 : 1);
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );
  });
});
