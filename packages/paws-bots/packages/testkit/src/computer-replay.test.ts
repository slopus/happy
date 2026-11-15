import { FakeSandboxProvider } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { computerReplayContext, controlsInTree, runComputerReplay } from "./computer-replay.js";
import {
  CONTACTS_CSV,
  CONTACTS_PATH,
  ContactsBrowserFixture,
  EXPORT_FIXTURE_URL,
  EXPORT_RECEIPT_PATH,
} from "./computer-replay-fixture.js";

describe("computer replay with real Pi and stateful offline computer", () => {
  it("exports contacts through fresh page refs and verifies the resulting artifact", async () => {
    const sandbox = new FakeSandboxProvider();
    const context = computerReplayContext();
    const computer = await sandbox.provision(
      { botId: "fixture-bot", homePath: "/fixture" },
      context,
    );
    const browser = new ContactsBrowserFixture(sandbox);
    try {
      const result = await runComputerReplay(sandbox, browser, computer, context);
      expect(result.usedTools).toContain("computer_observe");
      expect(result.modelRequests).toBe(9);
      expect(
        new TextDecoder().decode(await sandbox.readFile(computer, CONTACTS_PATH, context)),
      ).toBe(CONTACTS_CSV);
      expect(
        new TextDecoder().decode(await sandbox.readFile(computer, EXPORT_RECEIPT_PATH, context)),
      ).toBe("1");
    } finally {
      browser.close();
      await sandbox.destroy(computer, context);
    }
  });

  it("rejects an empty action batch without invalidating the current page refs", async () => {
    const sandbox = new FakeSandboxProvider();
    const context = computerReplayContext();
    const computer = await sandbox.provision(
      { botId: "fixture-bot", homePath: "/fixture" },
      context,
    );
    const browser = new ContactsBrowserFixture(sandbox);
    try {
      await browser.navigate(computer, { url: EXPORT_FIXTURE_URL }, context);
      const snapshot = await browser.snapshot(computer, {}, context);
      const exportRef = snapshot.elements.find((node) => node.name === "Export contacts")!.ref;
      expect(await browser.act(computer, { actions: [] }, context)).toMatchObject({
        ok: false,
        completed: 0,
        error: "actions is required",
        fallback: "computer_act",
      });
      expect(
        await browser.act(computer, { actions: [{ kind: "click", ref: exportRef }] }, context),
      ).toMatchObject({ ok: true, completed: 1 });
      await expect(sandbox.readFile(computer, CONTACTS_PATH, context)).rejects.toThrow();
      await expect(sandbox.readFile(computer, EXPORT_RECEIPT_PATH, context)).rejects.toThrow();
    } finally {
      browser.close();
      await sandbox.destroy(computer, context);
    }
  });

  it("does not create an artifact after stale, incorrect, or cancelled actions", async () => {
    const sandbox = new FakeSandboxProvider();
    const context = computerReplayContext();
    const computer = await sandbox.provision(
      { botId: "fixture-bot", homePath: "/fixture" },
      context,
    );
    const browser = new ContactsBrowserFixture(sandbox);
    try {
      await browser.navigate(computer, { url: EXPORT_FIXTURE_URL }, context);
      expect(
        await browser.act(computer, { actions: [{ kind: "click", ref: "missing" }] }, context),
      ).toMatchObject({ ok: false, completed: 0 });
      await expect(sandbox.readFile(computer, CONTACTS_PATH, context)).rejects.toThrow();
      const first = await browser.snapshot(computer, {}, context);
      const originalRef = first.elements.find((node) => node.name === "Export contacts")!.ref;
      expect(
        await browser.act(computer, { actions: [{ kind: "click", ref: originalRef }] }, context),
      ).toMatchObject({ ok: true });
      expect(
        await browser.act(computer, { actions: [{ kind: "click", ref: originalRef }] }, context),
      ).toMatchObject({ ok: false, completed: 0 });
      const dialog = await browser.snapshot(computer, {}, context);
      const downloadRef = dialog.elements.find((node) => node.name === "Download CSV")!.ref;
      const cancelRef = dialog.elements.find((node) => node.name === "Cancel")!.ref;
      expect(
        await browser.act(computer, { actions: [{ kind: "click", ref: cancelRef }] }, context),
      ).toMatchObject({ ok: true });
      expect(
        await browser.act(computer, { actions: [{ kind: "click", ref: downloadRef }] }, context),
      ).toMatchObject({ ok: false });
      await expect(sandbox.readFile(computer, CONTACTS_PATH, context)).rejects.toThrow();
      await expect(sandbox.readFile(computer, EXPORT_RECEIPT_PATH, context)).rejects.toThrow();
    } finally {
      browser.close();
      await sandbox.destroy(computer, context);
    }
  });
});

describe("controls read back from a snapshot tree", () => {
  it("reads names with quotes, backslashes, line breaks, Hebrew and emoji", () => {
    const names = [
      'Export "2024"',
      "C:\\temp",
      "two\nlines",
      "הצג תשואות",
      "Save \u{1F4BE}",
      "plain",
    ];
    const tree = [
      "Some page text",
      ...names.map((name, index) =>
        index % 2
          ? `${index % 3 ? "" : "  "}- link ${JSON.stringify(name)} [ref=e${index + 7}]: x`
          : `- checkbox ${JSON.stringify(name)} [${index % 4 ? "checked=false, ref=" : ""}e${index + 7}]`,
      ),
      "- not a control line",
    ].join("\n");
    expect(controlsInTree(tree)).toEqual(
      names.map((name, index) => ({ name, ref: `e${index + 7}` })),
    );
  });
});
