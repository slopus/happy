import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { AgentImportCreateInput } from "@rakazo/contracts";
import { findBotTemplate } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { templateAppCards } from "./bot-templates.js";
import { managedAppCatalog } from "./onboarding.js";

const entry = (connectorId: string, slug: string, name: string, connected: boolean) =>
  ({ connectorId, slug, name, logo: null, connected, noAuth: false }) as ConnectionCatalogItem;

describe("templateAppCards", () => {
  const briefing = findBotTemplate("morning-briefing")!;

  it("asks only for apps no provider has connected, and skips apps the server lacks", () => {
    const cards = templateAppCards(briefing, [
      // One provider lists Gmail as not connected before another that has it connected.
      entry("first", "gmail", "Gmail", false),
      entry("second", "gmail", "Gmail", true),
      entry("first", "googlecalendar", "Google Calendar", false),
    ]);
    expect(cards).toEqual([
      expect.objectContaining({ kind: "app_connect", name: "Google Calendar", status: "pending" }),
    ]);
    expect(templateAppCards(briefing, [])).toEqual([]);
  });
});

it("keeps template import keys out of agent imports", () => {
  const request = {
    files: [{ path: "SOUL.md", content: "Calm." }],
    name: "Imported",
    selection: { instructions: [], memory: [], skills: [] },
  };
  expect(AgentImportCreateInput.safeParse({ ...request, importKey: "import-1234" }).success).toBe(
    true,
  );
  expect(
    AgentImportCreateInput.safeParse({ ...request, importKey: "template:morning-briefing" })
      .success,
  ).toBe(false);
});

it("leaves out a managed provider whose catalog never answers", async () => {
  const gmail = entry("second", "gmail", "Gmail", false);
  const connectors = {
    managedProviders: () => [
      { catalog: () => new Promise<never>(() => undefined) },
      { catalog: async () => [gmail] },
    ],
  } as never;
  const actor = { spaceId: "space-1", userId: "user-1" } as never;
  await expect(managedAppCatalog(connectors, actor, "test", undefined, 20)).resolves.toEqual([
    gmail,
  ]);
});
