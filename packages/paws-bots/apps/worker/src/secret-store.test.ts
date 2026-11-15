import { InMemoryRealtimeFanout } from "@rakazo/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { infisicalFake } from "../../../packages/adapters/src/secret-store-fake.js";
import { createWorkerSecretStore } from "./secret-store.js";

afterEach(() => vi.unstubAllGlobals());
const context = {
  operationId: "test",
  traceId: "test",
  userId: "test",
  spaceId: "test",
  signal: new AbortController().signal,
};
describe("worker secret storage startup", () => {
  it("starts degraded without blocking encrypted credentials and retries the configured remote later", async () => {
    const fake = infisicalFake();
    fake.offline = true;
    vi.stubGlobal("fetch", fake.fetcher);
    const realtime = new InMemoryRealtimeFanout();
    const store = await createWorkerSecretStore(
      {
        NODE_ENV: "test",
        ENCRYPTION_KEY: "fake-encryption-key-at-least-thirty-two-characters",
        SECRET_STORE: "infisical",
        INFISICAL_URL: fake.options.baseUrl,
        INFISICAL_CLIENT_ID: fake.options.clientId,
        INFISICAL_CLIENT_SECRET: fake.options.clientSecret,
        INFISICAL_PROJECT_ID: fake.options.projectId,
        INFISICAL_ENVIRONMENT: fake.options.environment,
        INFISICAL_FOLDER: fake.options.folder,
      },
      realtime,
    );
    try {
      expect(store.describe().capabilities.degraded).toBe(true);
      const local = await store.put("fake otp", context, { ephemeral: true });
      await expect(store.load(local.ref, local.id)).resolves.toBe("fake otp");
      fake.offline = false;
      const remote = await store.put("fake credential", context);
      expect(store.describe().capabilities.degraded).toBe(false);
      await expect(store.load(remote.ref, remote.id)).resolves.toBe("fake credential");
    } finally {
      await store.close();
      await realtime.close();
    }
  });
});
