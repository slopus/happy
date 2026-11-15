import { describe, expect, it } from "vitest";
import { resolveSandboxProvider, sandboxProviderOptionsFromEnv } from "./sandbox-provider-env.js";

describe("resolveSandboxProvider", () => {
  it("defaults to docker", () => {
    expect(resolveSandboxProvider({})).toBe("docker");
  });

  it("keeps explicit none", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "none" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "" })).toBe("none");
  });

  it("falls back to none when a remote provider key is missing", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "e2b" })).toBe("none");
    expect(
      resolveSandboxProvider({ SANDBOX_PROVIDER: "novita", E2B_API_KEY: "test-e2b-key" }),
    ).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "daytona" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "createos" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "boat" })).toBe("none");
    const wuying = {
      SANDBOX_PROVIDER: "wuying",
      WUYING_ACCESS_KEY_ID: "test-id",
      WUYING_ACCESS_KEY_SECRET: "test-secret",
      WUYING_DESKTOP_ID: "ecd-test",
      WUYING_END_USER_ID: "test-user",
      WUYING_MCP_URL: "https://gateway.example.com/mcp",
      WUYING_MCP_TOKEN: "test-token",
    };
    expect(resolveSandboxProvider(wuying)).toBe("wuying");
    expect(resolveSandboxProvider({ ...wuying, WUYING_MCP_TOKEN: " " })).toBe("none");
  });

  it("loads Novita credentials and the shared template setting", () => {
    const env = {
      SANDBOX_PROVIDER: "novita",
      NOVITA_API_KEY: " test-novita-key ",
      SANDBOX_TEMPLATE: " custom-desktop ",
    };
    expect(resolveSandboxProvider(env)).toBe("novita");
    expect(sandboxProviderOptionsFromEnv(env)).toMatchObject({
      novitaApiKey: "test-novita-key",
      sandboxTemplate: "custom-desktop",
    });
  });

  it("requires both Railway credentials and an environment", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "railway" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "railway", RAILWAY_API_TOKEN: "test" })).toBe(
      "none",
    );
    const env = {
      SANDBOX_PROVIDER: "railway",
      RAILWAY_API_TOKEN: "test",
      RAILWAY_ENVIRONMENT_ID: "environment",
      RAILWAY_MAX_WORKSPACE_FILE_BYTES: "1024",
    };
    expect(resolveSandboxProvider(env)).toBe("railway");
    expect(sandboxProviderOptionsFromEnv(env)).toMatchObject({
      railwayApiToken: "test",
      railwayEnvironmentId: "environment",
      railwayMaxWorkspaceFileBytes: "1024",
    });
  });

  it("keeps boxd when its API key is set, with an optional organization", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "boxd" })).toBe("none");
    const env = { SANDBOX_PROVIDER: "boxd", BOXD_API_KEY: "test-boxd-key", BOXD_ORG: "team" };
    expect(resolveSandboxProvider(env)).toBe("boxd");
    expect(sandboxProviderOptionsFromEnv(env)).toMatchObject({
      boxdApiKey: "test-boxd-key",
      boxdOrg: "team",
    });
  });

  it("keeps instabox when its API key is set", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "instabox" })).toBe("none");
    const env = { SANDBOX_PROVIDER: "instabox", INSTABOX_API_KEY: "test-instabox-key" };
    expect(resolveSandboxProvider(env)).toBe("instabox");
    expect(sandboxProviderOptionsFromEnv(env)).toMatchObject({
      instaboxApiKey: "test-instabox-key",
    });
  });

  it("keeps CreateOS when its API key is set", () => {
    expect(
      resolveSandboxProvider({
        SANDBOX_PROVIDER: "createos",
        CREATEOS_SANDBOX_API_KEY: "test-createos-key",
      }),
    ).toBe("createos");
  });

  it("keeps Kubernetes without any provider key", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "kubernetes" })).toBe("kubernetes");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "kubernetes", NODE_ENV: "production" })).toBe(
      "kubernetes",
    );
  });

  it("keeps Incus only when its address and client certificate are set", () => {
    const configured = {
      SANDBOX_PROVIDER: "incus",
      INCUS_SANDBOX_URL: "https://incus.example.test:8443",
      INCUS_SANDBOX_CLIENT_CERT: "test-cert",
      INCUS_SANDBOX_CLIENT_KEY: "test-key",
    };
    expect(resolveSandboxProvider(configured)).toBe("incus");
    for (const key of [
      "INCUS_SANDBOX_URL",
      "INCUS_SANDBOX_CLIENT_CERT",
      "INCUS_SANDBOX_CLIENT_KEY",
    ])
      expect(resolveSandboxProvider({ ...configured, [key]: " " })).toBe("none");
  });

  it("falls back to none in production when Docker has no supervisor token", () => {
    expect(
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
      }),
    ).toBe("none");
  });

  it("keeps docker in production when a supervisor token is set", () => {
    expect(
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-enough-length",
      }),
    ).toBe("docker");
  });
});

describe("sandboxProviderOptionsFromEnv", () => {
  it("loads CreateOS settings from the shared env contract", () => {
    expect(
      sandboxProviderOptionsFromEnv({
        CREATEOS_SANDBOX_API_KEY: "test-createos-key",
        CREATEOS_SANDBOX_BASE_URL: "https://api.example.test",
        CREATEOS_SANDBOX_SHAPE: "s-4vcpu-8gb",
        CREATEOS_SANDBOX_ROOTFS: "desktop:2",
      }),
    ).toMatchObject({
      createosApiKey: "test-createos-key",
      createosBaseUrl: "https://api.example.test",
      createosShape: "s-4vcpu-8gb",
      createosRootfs: "desktop:2",
    });
  });

  it("loads the Railway sandbox region", () => {
    expect(
      sandboxProviderOptionsFromEnv({ RAILWAY_SANDBOX_REGION: "asia-southeast1-eqsg3a" }),
    ).toMatchObject({ railwaySandboxRegion: "asia-southeast1-eqsg3a" });
  });

  it.each(["", "  "])("leaves a blank Railway sandbox region unset: %j", (region) => {
    expect(
      sandboxProviderOptionsFromEnv({ RAILWAY_SANDBOX_REGION: region }).railwaySandboxRegion,
    ).toBeUndefined();
  });

  it("loads Kubernetes settings and parses labels, annotations and the ready timeout", () => {
    expect(
      sandboxProviderOptionsFromEnv({
        KUBERNETES_SANDBOX_NAMESPACE: " rakazo-computers ",
        KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME: "kata",
        KUBERNETES_SANDBOX_COMPUTER_IMAGE: "ghcr.io/elie222/rakazo/computer@sha256:abc",
        KUBERNETES_SANDBOX_CPU_LIMIT: "2",
        KUBERNETES_SANDBOX_MEMORY_LIMIT: "4Gi",
        KUBERNETES_SANDBOX_POD_LABELS: '{"team":"bots"}',
        KUBERNETES_SANDBOX_POD_ANNOTATIONS: '{"example.test/owner":"rakazo"}',
        KUBERNETES_SANDBOX_READY_TIMEOUT_MS: "90000",
      }),
    ).toMatchObject({
      kubernetesNamespace: "rakazo-computers",
      kubernetesRuntimeClassName: "kata",
      kubernetesComputerImage: "ghcr.io/elie222/rakazo/computer@sha256:abc",
      kubernetesCpuLimit: "2",
      kubernetesMemoryLimit: "4Gi",
      kubernetesPodLabels: { team: "bots" },
      kubernetesPodAnnotations: { "example.test/owner": "rakazo" },
      kubernetesReadyTimeoutMs: 90_000,
    });
    expect(sandboxProviderOptionsFromEnv({}).kubernetesNamespace).toBeUndefined();
  });

  it("loads Incus settings and accepts certificates with escaped newlines", () => {
    expect(
      sandboxProviderOptionsFromEnv({
        INCUS_SANDBOX_URL: " https://incus.example.test:8443 ",
        INCUS_SANDBOX_CLIENT_CERT: "client-cert-line-1\\nclient-cert-line-2",
        INCUS_SANDBOX_CLIENT_KEY: "client-key-line-1\nclient-key-line-2",
        INCUS_SANDBOX_SERVER_CERT: "server-cert-line-1\\nserver-cert-line-2",
        INCUS_SANDBOX_PROJECT: "rakazo",
        INCUS_SANDBOX_COMPUTER_IMAGE: "ghcr.io/elie222/rakazo/computer:v1.2.3",
        INCUS_SANDBOX_CPU_LIMIT: "1",
        INCUS_SANDBOX_MEMORY_LIMIT: "1536MiB",
        INCUS_SANDBOX_PROCESS_LIMIT: "1024",
      }),
    ).toMatchObject({
      incusUrl: "https://incus.example.test:8443",
      incusClientCert: "client-cert-line-1\nclient-cert-line-2",
      incusClientKey: "client-key-line-1\nclient-key-line-2",
      incusServerCert: "server-cert-line-1\nserver-cert-line-2",
      incusProject: "rakazo",
      incusComputerImage: "ghcr.io/elie222/rakazo/computer:v1.2.3",
      incusCpuLimit: "1",
      incusMemoryLimit: "1536MiB",
      incusProcessLimit: "1024",
    });
    expect(sandboxProviderOptionsFromEnv({}).incusServerCert).toBeUndefined();
  });

  it("loads the Kubernetes home claim and its pod-affinity target", () => {
    expect(
      sandboxProviderOptionsFromEnv({
        KUBERNETES_SANDBOX_HOME_CLAIM: "rakazo-data",
        KUBERNETES_SANDBOX_HOME_COLOCATE_NAMESPACE: "rakazo",
        KUBERNETES_SANDBOX_HOME_COLOCATE_LABELS: '{"app":"rakazo-api"}',
      }),
    ).toMatchObject({
      kubernetesHomeClaim: "rakazo-data",
      kubernetesHomeColocateNamespace: "rakazo",
      kubernetesHomeColocateLabels: { app: "rakazo-api" },
    });
    expect(() =>
      sandboxProviderOptionsFromEnv({ KUBERNETES_SANDBOX_HOME_COLOCATE_LABELS: "rakazo-api" }),
    ).toThrow("KUBERNETES_SANDBOX_HOME_COLOCATE_LABELS must be a JSON object of string values");
  });

  it("rejects malformed Kubernetes label maps and timeouts", () => {
    expect(() =>
      sandboxProviderOptionsFromEnv({ KUBERNETES_SANDBOX_POD_LABELS: '["bots"]' }),
    ).toThrow("KUBERNETES_SANDBOX_POD_LABELS must be a JSON object of string values");
    expect(() =>
      sandboxProviderOptionsFromEnv({ KUBERNETES_SANDBOX_POD_ANNOTATIONS: "{" }),
    ).toThrow("KUBERNETES_SANDBOX_POD_ANNOTATIONS must be a JSON object of string values");
    expect(() =>
      sandboxProviderOptionsFromEnv({ KUBERNETES_SANDBOX_READY_TIMEOUT_MS: "0" }),
    ).toThrow("KUBERNETES_SANDBOX_READY_TIMEOUT_MS must be a positive integer");
  });
  it("keeps object-backed Kubernetes homes on the copy path", () => {
    expect(
      sandboxProviderOptionsFromEnv({
        OBJECT_STORAGE_BUCKET: "test-homes",
        KUBERNETES_SANDBOX_HOME_CLAIM: "data",
        KUBERNETES_SANDBOX_HOME_COLOCATE_NAMESPACE: "test",
        KUBERNETES_SANDBOX_HOME_COLOCATE_LABELS: '{"app":"api"}',
      }).kubernetesHomeClaim,
    ).toBeUndefined();
  });
});
