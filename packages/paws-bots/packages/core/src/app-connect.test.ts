import type { ConnectionCatalogItem, MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  appConnectCard,
  appConnectedInput,
  connectedAppBlocks,
  matchAppCatalog,
} from "./app-connect.js";

const entry: ConnectionCatalogItem = {
  connectorId: "catalog",
  slug: "googlecalendar",
  name: "Google Calendar",
  logo: null,
  connected: false,
  noAuth: false,
};
describe("inline app cards", () => {
  it("matches exact names, slugs, and featured aliases", () => {
    for (const query of ["GOOGLECALENDAR", "Google Calendar", "gcal"])
      expect(matchAppCatalog([entry], query)).toBe(entry);
    expect(matchAppCatalog([entry], "unknown")).toBeUndefined();
  });
  it("builds trusted card fields and preserves unrelated blocks", () => {
    const card = appConnectCard(entry);
    const other = { ...card, connectorId: "other" };
    const text: MessageBlock = { kind: "text", text: "hello" };
    expect(connectedAppBlocks([card, other, text], "catalog", "gcal")).toEqual([
      { ...card, status: "connected" },
      other,
      text,
    ]);
    expect(card.description).toBe("Search events and schedule meetings.");
    expect(appConnectedInput("bot", "group-thread", card)).toEqual({
      botId: "bot",
      threadId: "group-thread",
      connectorId: "catalog",
      provider: "googlecalendar",
    });
  });
});
