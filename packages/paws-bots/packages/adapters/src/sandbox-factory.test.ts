import { SandboxKind } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { NO_SANDBOX_MESSAGE } from "./none-sandbox.js";
import { createSandboxProvider } from "./sandbox-factory.js";

const ctx = {
  operationId: "op",
  traceId: "tr",
  spaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

describe("createSandboxProvider", () => {
  it("returns fake sandbox when explicitly requested", async () => {
    const sandbox = await createSandboxProvider("fake", {});
    expect(sandbox.describe().id).toBe("fake");
  });

  it("returns none when requested or when the kind is empty", async () => {
    expect((await createSandboxProvider("none", {})).describe().id).toBe("none");
    expect((await createSandboxProvider("", {})).describe().id).toBe("none");
    await expect(
      (await createSandboxProvider("none", {})).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(NO_SANDBOX_MESSAGE);
  });

  it("boots without a remote key and keeps computers unavailable", async () => {
    expect((await createSandboxProvider("e2b", {})).describe().id).toBe("none");
    expect((await createSandboxProvider("novita", {})).describe().id).toBe("none");
    expect((await createSandboxProvider("daytona", {})).describe().id).toBe("none");
    expect((await createSandboxProvider("createos", {})).describe().id).toBe("none");
    expect((await createSandboxProvider("boat", {})).describe().id).toBe("none");
    expect((await createSandboxProvider("boxd", {})).describe().id).toBe("none");
    expect((await createSandboxProvider("instabox", {})).describe().id).toBe("none");
    await expect(
      (await createSandboxProvider("e2b", {})).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(/E2B_API_KEY/);
    await expect(
      (await createSandboxProvider("createos", {})).provision(
        { botId: "b", homePath: "/tmp" },
        ctx,
      ),
    ).rejects.toThrow(/CREATEOS_SANDBOX_API_KEY/);
    expect(
      (await createSandboxProvider("createos", { createosApiKey: "test-createos-key" })).describe()
        .id,
    ).toBe("createos");
    expect(
      (await createSandboxProvider("boat", { boatApiKey: "test-boat-key" })).describe().id,
    ).toBe("boat");
    expect(
      (await createSandboxProvider("boxd", { boxdApiKey: "test-boxd-key" })).describe().id,
    ).toBe("boxd");
    expect(
      (await createSandboxProvider("instabox", { instaboxApiKey: "test-instabox-key" })).describe()
        .id,
    ).toBe("instabox");
  });

  it("refuses the desktop provider in a production server process", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(createSandboxProvider("desktop", {})).rejects.toThrow(
        "SANDBOX_PROVIDER=desktop runs bot commands directly on this host",
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await createSandboxProvider("desktop", {})).describe().id).toBe("desktop");
  });

  it("returns the Kubernetes provider without contacting the cluster", async () => {
    const sandbox = await createSandboxProvider("kubernetes", {
      kubernetesNamespace: "rakazo-computers",
      kubernetesRuntimeClassName: "kata",
    });
    expect(sandbox.describe()).toMatchObject({
      id: "kubernetes",
      capabilities: { graphical: true, pty: true, persistentHome: false },
    });
  });

  it("returns the Incus provider without contacting the server", async () => {
    const sandbox = await createSandboxProvider("incus", {
      incusUrl: "https://incus.example.test:8443",
      incusClientCert: "test-cert",
      incusClientKey: "test-key",
    });
    expect(sandbox.describe()).toMatchObject({
      id: "incus",
      capabilities: { graphical: true, pty: true, persistentHome: false },
    });
  });

  it("boots Incus as none until its address and client certificate are set", async () => {
    const sandbox = await createSandboxProvider("incus", {
      incusUrl: "https://incus.example.test:8443",
      incusClientCert: "test-cert",
    });
    expect(sandbox.describe().id).toBe("none");
    await expect(sandbox.provision({ botId: "b", homePath: "/unused" }, ctx)).rejects.toThrow(
      /INCUS_SANDBOX_CLIENT_KEY/,
    );
  });

  it("refuses an Incus API address without TLS", async () => {
    await expect(
      createSandboxProvider("incus", {
        incusUrl: "http://incus.example.test:8443",
        incusClientCert: "test-cert",
        incusClientKey: "test-key",
      }),
    ).rejects.toThrow("must use https");
  });

  it("returns the Wuying provider without contacting Alibaba Cloud", async () => {
    const sandbox = await createSandboxProvider("wuying", {
      wuyingAccessKeyId: "test-id",
      wuyingAccessKeySecret: "test-secret",
      wuyingDesktopId: "ecd-test",
      wuyingEndUserId: "test-user",
      wuyingMcpUrl: "https://gateway.example.com/mcp",
      wuyingMcpToken: "test-token",
    });
    expect(sandbox.describe()).toMatchObject({
      id: "wuying",
      capabilities: { graphical: true, takeover: true, persistentHome: true },
    });
    expect(
      (await createSandboxProvider("wuying", { wuyingAccessKeyId: "test-id" })).describe().id,
    ).toBe("none");
  });

  it("selects Novita without using E2B credentials", async () => {
    expect(
      (await createSandboxProvider("novita", { novitaApiKey: "test-novita-key" })).describe(),
    ).toMatchObject({
      id: "novita",
      capabilities: { graphical: true, persistentHome: true, multiScreen: true },
    });
    await expect(
      (await createSandboxProvider("novita", { e2bApiKey: "test-e2b-key" })).provision(
        { botId: "b", homePath: "/unused" },
        ctx,
      ),
    ).rejects.toThrow(/NOVITA_API_KEY/);
  });

  it("throws on unknown provider", async () => {
    await expect(createSandboxProvider("bogus", {})).rejects.toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use none | docker | e2b | novita | daytona | createos | boat | boxd | instabox | railway | kubernetes | incus | local-vm | wuying | desktop | fake.',
    );
  });

  it("accepts only sandbox kinds, including none", async () => {
    expect(SandboxKind.options).toContain("none");
    for (const kind of SandboxKind.options) {
      await expect(createSandboxProvider(kind, {})).resolves.toBeDefined();
    }
    await expect(createSandboxProvider("not-a-provider", {})).rejects.toThrow(
      /Unknown SANDBOX_PROVIDER/,
    );
  });
});
