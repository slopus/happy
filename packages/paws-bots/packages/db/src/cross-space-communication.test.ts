import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { crossSpaceCommunicationAllowed } from "./cross-space-communication.js";

const sender = {
  id: "sender",
  spaceId: "space-a",
  crossSpaceCommunication: true,
  archivedAt: null,
};
const recipient = {
  id: "recipient",
  spaceId: "space-b",
  crossSpaceCommunication: true,
  archivedAt: null,
};

describe("cross-space bot communication", () => {
  it.each([
    { name: "both opted in", bots: [sender, recipient], allowed: true },
    {
      name: "sender off",
      bots: [{ ...sender, crossSpaceCommunication: false }, recipient],
      allowed: false,
    },
    {
      name: "recipient off",
      bots: [sender, { ...recipient, crossSpaceCommunication: false }],
      allowed: false,
    },
    {
      name: "missing permission",
      bots: [sender, { ...recipient, crossSpaceCommunication: undefined }],
      allowed: false,
    },
    { name: "missing bot", bots: [sender], allowed: false },
    {
      name: "archived bot",
      bots: [sender, { ...recipient, archivedAt: new Date() }],
      allowed: false,
    },
    {
      name: "same space",
      bots: [
        { ...sender, crossSpaceCommunication: false },
        { ...recipient, spaceId: sender.spaceId, crossSpaceCommunication: false },
      ],
      allowed: true,
    },
  ])("$name", async ({ bots, allowed }) => {
    const prisma = { $queryRaw: vi.fn(async () => bots) };
    expect(
      await crossSpaceCommunicationAllowed(
        prisma as unknown as PrismaClient,
        sender.id,
        recipient.id,
      ),
    ).toBe(allowed);
  });
});
