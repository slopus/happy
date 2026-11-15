import { createRouterClient } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { BUILTIN_AGENT_SKILLS, previewPluginInstall } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { installPlugin, setPluginParts } from "./plugin-installs.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-test",
  userId: "user-test",
  email: "user@example.test",
  isDeploymentOwner: false,
};
const source = "https://github.com/example/plugin";
const sha = "a".repeat(40);
const fetcher = async () => ({
  resolvedSha: sha,
  files: [
    { path: ".grok-plugin/plugin.json", content: JSON.stringify({ name: "example-plugin" }) },
    {
      path: "skills/example/SKILL.md",
      content: "---\nname: example-skill\ndescription: Example skill\n---\n\nUse the tools.\n",
    },
    {
      path: ".mcp.json",
      content: JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://tools.example.test/mcp",
            headers: { "X-Tenant": "package-tenant" },
          },
        },
      }),
    },
  ],
});
function setup() {
  const prisma = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ bypass: null }]),
    capabilityInstall: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => ({ ...data, id: "install-test", createdAt: new Date(0) })),
      update: vi.fn(async ({ data }) => ({
        id: "install-test",
        name: "Example",
        source,
        version: sha,
        digest: null,
        createdAt: new Date(0),
        ...data,
      })),
    },
    agentSkill: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }) => ({ ...data, id: "skill-test" })),
      deleteMany: vi.fn(),
    },
    agentSkillSpace: { createMany: vi.fn() },
    mcpServer: {
      create: vi.fn(async ({ data }) => ({ ...data, id: "server-test" })),
      findMany: vi.fn().mockResolvedValue([]),
    },
    mcpServerSpace: { createMany: vi.fn() },
    secret: { create: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    botSecret: { count: vi.fn().mockResolvedValue(0) },
    vaultCredential: { count: vi.fn().mockResolvedValue(0) },
    integrationProviderConfig: { count: vi.fn().mockResolvedValue(0) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (run) => run(prisma));
  const secrets = {
    put: vi.fn().mockResolvedValue({ id: "secret-test", ciphertext: "encrypted-header-material" }),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as SecretStore;
  return {
    prisma,
    secrets,
    deps: {
      prisma: prisma as never,
      secrets,
      fetcher,
      assertEndpoint: vi.fn().mockResolvedValue(undefined),
    },
  };
}
async function input() {
  return {
    source,
    name: "Example",
    config: {},
    pluginDigest: (await previewPluginInstall({ source, fetcher })).digest,
  };
}

describe("confirmed plugin installation", () => {
  it("persists read-only skills and native MCP rows atomically, not credentials in config", async () => {
    const { deps, prisma, secrets } = setup();
    const result = await installPlugin(deps, actor, await input());
    expect(result).toMatchObject({ kind: "plugin", version: sha });
    expect(JSON.stringify(result)).not.toContain("package-tenant");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.agentSkill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        allSpaces: true,
        source: "plugin",
        installId: "install-test",
        name: "example-skill",
      }),
    });
    expect(secrets.put).toHaveBeenCalledWith(
      JSON.stringify({ env: {}, headers: { "X-Tenant": "package-tenant" } }),
      expect.objectContaining({ userId: actor.userId }),
    );
    expect(prisma.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        installId: "install-test",
        allSpaces: true,
        secretId: "secret-test",
        headers: { "X-Tenant": true },
        transport: "streamable_http",
      }),
    });
    // A connector available in every space keeps its credential on the account.
    expect(prisma.secret.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: "secret-test", spaceId: null, userId: actor.userId }),
    });
    expect(deps.assertEndpoint).toHaveBeenCalledWith("https://tools.example.test/mcp");
  });
  it("does not write anything without confirmation or after changed content", async () => {
    const { deps, prisma } = setup();
    const args = await input();
    await expect(
      installPlugin(deps, actor, { ...args, pluginDigest: undefined }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      installPlugin(deps, actor, { ...args, pluginDigest: `sha256:${"0".repeat(64)}` }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("refuses variables and pasted credentials rather than saving plaintext config", async () => {
    const { deps, prisma, secrets } = setup();
    const args = await input();
    await expect(
      installPlugin(deps, actor, { ...args, config: { variables: { TOKEN: "fake-token" } } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      installPlugin(deps, actor, { ...args, credential: "fake-token" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(secrets.put).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("rejects duplicates and skill clashes without renaming or overwriting", async () => {
    const { deps, prisma } = setup();
    prisma.capabilityInstall.findFirst.mockResolvedValueOnce({ id: "existing" } as never);
    await expect(installPlugin(deps, actor, await input())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // A same-named skill in any of the user's spaces clashes, since the plugin reaches them all.
    prisma.agentSkill.findMany.mockResolvedValueOnce([
      { spaceId: "other-space", allSpaces: false, availableIn: [] },
    ] as never);
    await expect(installPlugin(deps, actor, await input())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(prisma.capabilityInstall.create).not.toHaveBeenCalled();
    expect(prisma.agentSkill.create).not.toHaveBeenCalled();
  });
  it("installs the other skills when one repeats a built-in skill", async () => {
    const { deps, prisma } = setup();
    const builtin = BUILTIN_AGENT_SKILLS[0]!;
    deps.fetcher = async () => ({
      resolvedSha: sha,
      files: [
        { path: ".cursor-plugin/plugin.json", content: JSON.stringify({ name: "example-plugin" }) },
        { path: "skills/builtin/SKILL.md", content: builtin.content },
        {
          path: "skills/example/SKILL.md",
          content: "---\nname: example-skill\ndescription: Example skill\n---\n\nUse it.\n",
        },
      ],
    });
    const digest = (await previewPluginInstall({ source, fetcher: deps.fetcher })).digest;
    await installPlugin(deps, actor, { source, name: "Example", config: {}, pluginDigest: digest });
    expect(prisma.agentSkill.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentSkill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "example-skill" }),
    });
  });
  it("refuses a plugin whose only skill repeats a built-in one, before writing", async () => {
    const { deps, prisma } = setup();
    deps.fetcher = async () => ({
      resolvedSha: sha,
      files: [
        { path: ".cursor-plugin/plugin.json", content: JSON.stringify({ name: "example-plugin" }) },
        { path: "skills/builtin/SKILL.md", content: BUILTIN_AGENT_SKILLS[0]!.content },
      ],
    });
    const digest = (await previewPluginInstall({ source, fetcher: deps.fetcher })).digest;
    await expect(
      installPlugin(deps, actor, { source, name: "Example", config: {}, pluginDigest: digest }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("cleans prepared secret references when a later encryption fails", async () => {
    const { deps, prisma, secrets } = setup();
    deps.fetcher = async () => ({
      resolvedSha: sha,
      files: [
        { path: ".grok-plugin/plugin.json", content: JSON.stringify({ name: "example-plugin" }) },
        {
          path: ".mcp.json",
          content: JSON.stringify({
            mcpServers: {
              first: {
                type: "http",
                url: "https://tools.example.test/first",
                headers: { "X-Tenant": "one" },
              },
              second: {
                type: "http",
                url: "https://tools.example.test/second",
                headers: { "X-Tenant": "two" },
              },
            },
          }),
        },
      ],
    });
    vi.mocked(secrets.put)
      .mockResolvedValueOnce({
        id: "secret-test",
        ref: "encrypted-header-material",
        ciphertext: "encrypted-header-material",
      })
      .mockRejectedValueOnce(new Error("store unavailable"));
    prisma.secret.count.mockResolvedValue(0);
    const digest = (await previewPluginInstall({ source, fetcher: deps.fetcher })).digest;
    await expect(
      installPlugin(deps, actor, { source, name: "Example", config: {}, pluginDigest: digest }),
    ).rejects.toThrow("store unavailable");
    expect(secrets.delete).toHaveBeenCalledWith("encrypted-header-material", "secret-test");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("blocks endpoints before writing", async () => {
    const { deps, prisma } = setup();
    deps.assertEndpoint.mockRejectedValueOnce(new Error("private endpoint"));
    await expect(installPlugin(deps, actor, await input())).rejects.toThrow("private endpoint");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("plugin RPC boundary", () => {
  function client(currentActor: Actor | null = actor) {
    const { deps, prisma } = setup();
    const router = createRouter({
      prisma: deps.prisma,
      secrets: deps.secrets,
      pluginRepoFetcher: deps.fetcher,
      remoteConnectors: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
      dataDir: "/tmp/plugin-rpc-test",
    } as unknown as RouterDeps);
    return { rpc: createRouterClient(router, { context: { actor: currentActor } }), prisma };
  }
  it("requires authentication for preview", async () => {
    await expect(client(null).rpc.capabilities.pluginPreview({ source })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("returns summaries without sensitive material and requires digest at install", async () => {
    const { rpc, prisma } = client();
    const result = await rpc.capabilities.pluginPreview({ source });
    expect(result.resolvedSha).toBe(sha);
    expect(JSON.stringify(result)).not.toContain("package-tenant");
    expect(JSON.stringify(result)).not.toContain("Use the tools");
    await expect(
      rpc.capabilities.install({ kind: "plugin", source, name: "Example", config: {} }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.capabilityInstall.create).not.toHaveBeenCalled();
  });
  it("adds only the chosen parts and records them", async () => {
    const { deps, prisma, secrets } = setup();
    const result = await installPlugin(deps, actor, {
      ...(await input()),
      pluginParts: ["skills"],
    });
    expect(result.config).toMatchObject({ parts: ["skills"] });
    expect(prisma.agentSkill.create).toHaveBeenCalledTimes(1);
    expect(prisma.mcpServer.create).not.toHaveBeenCalled();
    expect(secrets.put).not.toHaveBeenCalled();
  });
  it("adds a part later from the pinned commit and removes one on its own", async () => {
    const { deps, prisma } = setup();
    const digest = (await input()).pluginDigest;
    const installed = {
      id: "install-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      allSpaces: true,
      availableIn: [],
      kind: "plugin",
      source,
      version: sha,
      digest,
      config: { parts: ["skills"] },
    };
    prisma.capabilityInstall.findFirst.mockResolvedValue(installed as never);
    const fetchPinned = vi.fn(fetcher);
    const removeServer = vi.fn();
    const both = await setPluginParts({ ...deps, fetcher: fetchPinned, removeServer }, actor, {
      id: installed.id,
      parts: ["skills", "connector"],
    });
    expect(fetchPinned).toHaveBeenCalledWith(
      expect.objectContaining({ gitUrl: source, ref: sha }),
      undefined,
    );
    expect(prisma.mcpServer.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentSkill.create).not.toHaveBeenCalled();
    expect(both?.config).toMatchObject({ parts: ["skills", "connector"] });

    prisma.capabilityInstall.findFirst.mockResolvedValue({
      ...installed,
      config: { parts: ["skills", "connector"] },
    } as never);
    prisma.mcpServer.findMany.mockResolvedValue([{ id: "server-1", secretId: null }] as never);
    const skillsOnly = await setPluginParts({ ...deps, removeServer }, actor, {
      id: installed.id,
      parts: ["skills"],
    });
    expect(removeServer).toHaveBeenCalledWith(prisma, { id: "server-1", secretId: null });
    expect(skillsOnly?.config).toMatchObject({ parts: ["skills"] });
    expect(
      await setPluginParts({ ...deps, removeServer }, actor, { id: installed.id, parts: [] }),
    ).toBeNull();
  });
  it("lists only the skills that installed when skills are added later", async () => {
    const { deps, prisma } = setup();
    deps.fetcher = async () => ({
      resolvedSha: sha,
      files: [
        ...(await fetcher()).files,
        { path: "skills/builtin/SKILL.md", content: BUILTIN_AGENT_SKILLS[0]!.content },
      ],
    });
    const digest = (await previewPluginInstall({ source, fetcher: deps.fetcher })).digest;
    // Saved by a connector-only install from before built-in names were left out.
    const stalePreview = [{ name: BUILTIN_AGENT_SKILLS[0]!.name }, { name: "example-skill" }];
    prisma.capabilityInstall.findFirst.mockResolvedValue({
      id: "install-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      allSpaces: true,
      availableIn: [],
      kind: "plugin",
      source,
      version: sha,
      digest,
      config: { parts: ["connector"], skills: stalePreview },
    } as never);
    const result = await setPluginParts({ ...deps, removeServer: vi.fn() }, actor, {
      id: "install-test",
      parts: ["connector", "skills"],
    });
    expect(prisma.agentSkill.create).toHaveBeenCalledTimes(1);
    expect(result?.config.skills).toEqual([expect.objectContaining({ name: "example-skill" })]);
  });
  it("refuses to add a part when the pinned content no longer matches", async () => {
    const { deps, prisma } = setup();
    prisma.capabilityInstall.findFirst.mockResolvedValue({
      id: "install-test",
      kind: "plugin",
      source,
      version: sha,
      digest: `sha256:${"0".repeat(64)}`,
      config: { parts: ["skills"] },
    } as never);
    await expect(
      setPluginParts({ ...deps, removeServer: vi.fn() }, actor, {
        id: "install-test",
        parts: ["skills", "connector"],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
