import { createRouterClient } from "@orpc/server";
import type { PluginRepoFetcher } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-fixture",
  userId: "user-fixture",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};
const approved = {
  name: "Notes",
  description: "Reviewed notes.",
  logo: "https://example.test/notes.svg",
  website: null,
  source: "https://github.com/xai-org/plugin-marketplace#notes",
  pinnedSource: `https://github.com/xai-org/plugin-marketplace@${"b".repeat(40)}#notes`,
  hasConnector: false,
  skillCount: 1,
};
function setup(approvedRows: (typeof approved)[] = [], pluginRepoFetcher?: PluginRepoFetcher) {
  const read = vi.fn(async (url: string) => {
    if (url.includes("/git/trees/"))
      return JSON.stringify({ tree: [{ path: "notes/skills/plan/SKILL.md", type: "blob" }] });
    if (url.endsWith("plugin-index.json"))
      return JSON.stringify({ plugins: { notes: { components: { skills: [{}] } } } });
    if (url.endsWith("marketplace.json"))
      return JSON.stringify({ plugins: [{ name: "notes", source: "notes" }] });
    throw new Error("Not found");
  });
  const router = createRouter({
    prisma: {
      pluginSubmission: { findMany: async () => approvedRows },
      user: { findUnique: async () => ({ email: actor.email, emailVerified: true }) },
    } as never,
    pluginMarketplaceRead: read,
    pluginRepoFetcher,
    env: {
      webOrigin: "http://localhost:5173",
      defaultProvider: "fake",
      defaultModel: "fake",
      adminEmails: ["admin@example.test"],
    },
    dataDir: "/tmp/marketplace-rpc-test",
  } as unknown as RouterDeps);
  return {
    read,
    client: (current: Actor | null) => createRouterClient(router, { context: { actor: current } }),
  };
}
describe("marketplace RPC", () => {
  it("requires authentication before reading remote indexes", async () => {
    const { read, client } = setup();
    await expect(client(null).marketplace.catalog({ query: "" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("uses the bounded server catalog rather than a browser fetch", async () => {
    const { read, client } = setup();
    const result = await client(actor).marketplace.catalog({ query: "notes" });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((row) => row.registry)).toEqual(["Cursor", "xAI"]);
    const reads = read.mock.calls.length;
    expect((await client(actor).marketplace.catalog({ query: "missing" })).entries).toEqual([]);
    expect(read).toHaveBeenCalledTimes(reads);
  });
  it("lists reviewed submissions once, in place of the same plugin from another registry", async () => {
    const { client } = setup([approved]);
    const result = await client(actor).marketplace.catalog({ query: "notes" });
    expect(result.entries.map((row) => [row.registry, row.description])).toEqual([
      ["Rakazo", "Reviewed notes."],
      ["Cursor", ""],
    ]);
  });
  it("keeps listing a plugin whose preview leaves out a skill repeating a built-in one", async () => {
    const skill = (name: string) => `---\nname: ${name}\ndescription: Notes\n---\n\nUse it.\n`;
    const { client } = setup([], async () => ({
      resolvedSha: "c".repeat(40),
      files: [
        { path: "notes/.cursor-plugin/plugin.json", content: JSON.stringify({ name: "notes" }) },
        { path: "notes/skills/plan/SKILL.md", content: skill("plan") },
        { path: "notes/skills/interrogate/SKILL.md", content: skill("Interrogate") },
      ],
    }));
    const [entry] = (await client(actor).marketplace.catalog({ query: "notes" })).entries;
    const preview = await client(actor).capabilities.pluginPreview({ source: entry!.source });
    expect(preview.builtinNames).toEqual(["Interrogate"]);
    const after = await client(actor).marketplace.catalog({ query: "notes" });
    expect(after.entries.map((row) => row.source)).toContain(entry!.source);
  });
  it("keeps submissions to admins", async () => {
    const { client } = setup();
    await expect(
      client(actor).marketplace.submissions({ status: "pending" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
