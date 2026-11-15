import { readFile } from "node:fs/promises";
import type { PortableFile } from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import type { ContactsRecordedStep, ContactsRecording } from "./computer-recording.js";
import {
  assertContactsExport,
  contactsReplaySteps,
  createContactsRecorder,
  createContactsReplayBrowser,
  executeContactsJourney,
  parseContactsRecording,
  replayContactsRecording,
} from "./computer-recording.js";
import { computerReplayContext } from "./computer-replay.js";
import {
  CONTACTS_PATH,
  ContactsBrowserFixture,
  EXPORT_FIXTURE_URL,
  EXPORT_RECEIPT_PATH,
} from "./computer-replay-fixture.js";
import { startModelEmulator } from "./model-emulator.js";

const openDialog: ContactsRecordedStep[] = [
  { op: "navigate", outcome: "ok" },
  { op: "snapshot", outcome: "ok" },
  { op: "click", target: "Export contacts", outcome: "ok" },
  { op: "snapshot", outcome: "ok" },
];
const recorded = (steps: ContactsRecordedStep[]): ContactsRecording => ({
  version: 1,
  scenario: "contacts-export",
  source: "authored",
  steps,
});

async function setup() {
  const sandbox = new FakeSandboxProvider();
  const context = computerReplayContext();
  const computer = await sandbox.provision({ botId: "fixture-bot", homePath: "/fixture" }, context);
  const browser = new ContactsBrowserFixture(sandbox);
  return {
    sandbox,
    context,
    computer,
    browser,
    async close() {
      browser.close();
      await sandbox.destroy(computer, context);
    },
  };
}

describe("sanitized real-model computer recordings", () => {
  it("replays the captured Luna/OpenRouter + Docker export with an independent artifact oracle", async () => {
    const recording = parseContactsRecording(
      JSON.parse(
        await readFile(new URL("./fixtures/contacts-luna-docker.json", import.meta.url), "utf8"),
      ),
    );
    expect(recording.source).toBe("luna-openrouter-docker");
    const fixture = await setup();
    try {
      await replayContactsRecording(
        recording,
        fixture.sandbox,
        fixture.browser,
        fixture.computer,
        fixture.context,
      );
      await assertContactsExport(fixture.sandbox, fixture.computer, fixture.context);
    } finally {
      await fixture.close();
    }
  });

  it("rejects raw metadata and unexpected operations instead of relying on secret-pattern matching", () => {
    const safe = recorded(openDialog);
    for (const extra of [
      "apiKey",
      "privateUrl",
      "screenshot",
      "modelText",
      "userId",
      "timestamp",
    ]) {
      expect(() =>
        parseContactsRecording({ ...safe, [extra]: "private fixture canary" }),
      ).toThrow();
      expect(() =>
        parseContactsRecording({
          ...safe,
          steps: [{ ...openDialog[0], [extra]: "private fixture canary" }],
        }),
      ).toThrow();
    }
    expect(() =>
      parseContactsRecording(
        recorded([{ op: "click", target: "private fixture canary", outcome: "ok" } as never]),
      ),
    ).toThrow();
    expect(() => parseContactsRecording({ ...safe, source: "private fixture canary" })).toThrow();
  });

  it("projects transient refs to fixed button names and refuses uncontrolled tool arguments before effects", async () => {
    const fixture = await setup();
    const recorder = createContactsRecorder(
      fixture.sandbox,
      fixture.browser,
      fixture.computer,
      fixture.context,
    );
    try {
      await expect(
        recorder.executeTool("browser_navigate", { url: "https://private.example.test/" }),
      ).rejects.toThrow();
      await expect(recorder.executeTool("read_file", { path: "secrets.txt" })).rejects.toThrow();
      await expect(recorder.executeTool("shell", { command: "echo private" })).rejects.toThrow();
      expect(recorder.decisions()).toEqual([]);
      await recorder.executeTool("browser_navigate", { url: EXPORT_FIXTURE_URL });
      const snapshot = (await recorder.executeTool("browser_snapshot", {})) as {
        elements: Array<{ name: string; ref: string }>;
      };
      const ref = snapshot.elements.find((node) => node.name === "Export contacts")!.ref;
      await recorder.executeTool("browser_act", { actions: [{ kind: "click", ref }] });
      const recording = recorder.recording("authored");
      expect(recording.steps).toEqual(openDialog.slice(0, 3));
      expect(JSON.stringify(recording)).not.toContain(ref);
      await expect(
        fixture.sandbox.readFile(fixture.computer, CONTACTS_PATH, fixture.context),
      ).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });

  it("reproduces captured download failures during promotion and exports exactly once", async () => {
    const fixture = await setup();
    const recording = recorded([
      ...openDialog,
      { op: "click", target: "Download CSV", outcome: "error" },
      { op: "snapshot", outcome: "ok" },
      { op: "click", target: "Download CSV", outcome: "ok" },
      { op: "read", outcome: "ok" },
    ]);
    const browser = createContactsReplayBrowser(fixture.sandbox, recording);
    try {
      await replayContactsRecording(
        recording,
        fixture.sandbox,
        browser,
        fixture.computer,
        fixture.context,
      );
      await assertContactsExport(fixture.sandbox, fixture.computer, fixture.context);
    } finally {
      browser.close();
      await fixture.close();
    }
  });

  it("cancels at the export dialog without producing a download or receipt", async () => {
    const fixture = await setup();
    try {
      await replayContactsRecording(
        recorded([
          ...openDialog,
          { op: "click", target: "Cancel", outcome: "ok" },
          { op: "snapshot", outcome: "ok" },
        ]),
        fixture.sandbox,
        fixture.browser,
        fixture.computer,
        fixture.context,
      );
      for (const path of [CONTACTS_PATH, EXPORT_RECEIPT_PATH]) {
        await expect(
          fixture.sandbox.readFile(fixture.computer, path, fixture.context),
        ).rejects.toThrow();
      }
    } finally {
      await fixture.close();
    }
  });

  it("aborts a real Pi HTTP stream after the download and resumes without repeating the side effect", async () => {
    const fixture = await setup();
    const controller = new AbortController();
    const interruptedContext = { ...fixture.context, signal: controller.signal };
    const prefix = recorded([
      ...openDialog,
      { op: "click", target: "Download CSV", outcome: "ok" },
    ]);
    const steps = contactsReplaySteps(prefix);
    let held = false;
    steps[steps.length - 1]!.response = {
      type: "hold",
      onOpen() {
        held = true;
        controller.abort();
      },
    };
    const emulator = await startModelEmulator({ steps });
    try {
      const recorder = createContactsRecorder(
        fixture.sandbox,
        fixture.browser,
        fixture.computer,
        interruptedContext,
      );
      await expect(
        executeContactsJourney(emulator.model, recorder, interruptedContext),
      ).rejects.toThrow(/aborted/i);
      emulator.assertComplete();
      expect(held).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(recorder.recording("authored")).toEqual(prefix);
      await assertContactsExport(fixture.sandbox, fixture.computer, fixture.context);
      await replayContactsRecording(
        recorded([
          { op: "snapshot", outcome: "ok" },
          { op: "observe", outcome: "ok" },
          { op: "read", outcome: "ok" },
        ]),
        fixture.sandbox,
        fixture.browser,
        fixture.computer,
        { ...fixture.context, operationId: "resumed-run" },
      );
      await assertContactsExport(fixture.sandbox, fixture.computer, fixture.context);
    } finally {
      await emulator.close();
      await fixture.close();
    }
  });

  it("restores a downloaded workspace into a replacement computer and verifies it without another export", async () => {
    const fixture = await setup();
    try {
      await replayContactsRecording(
        recorded([...openDialog, { op: "click", target: "Download CSV", outcome: "ok" }]),
        fixture.sandbox,
        fixture.browser,
        fixture.computer,
        fixture.context,
      );
      const files: PortableFile[] = [];
      for await (const file of fixture.sandbox.exportWorkspace(fixture.computer, fixture.context))
        files.push(file);
      await fixture.sandbox.destroy(fixture.computer, fixture.context);
      fixture.browser.close();
      const replacement = await fixture.sandbox.provision(
        { botId: "replacement-bot", homePath: "/replacement" },
        fixture.context,
      );
      const browser = new ContactsBrowserFixture(fixture.sandbox);
      try {
        expect(replacement.id).not.toBe(fixture.computer.id);
        await fixture.sandbox.importWorkspace(
          replacement,
          (async function* () {
            yield* files;
          })(),
          fixture.context,
        );
        await replayContactsRecording(
          recorded([{ op: "read", outcome: "ok" }]),
          fixture.sandbox,
          browser,
          replacement,
          fixture.context,
        );
        await assertContactsExport(fixture.sandbox, replacement, fixture.context);
        // A duplicate export after recovery must still be visible to the independent oracle.
        await replayContactsRecording(
          recorded([...openDialog, { op: "click", target: "Download CSV", outcome: "ok" }]),
          fixture.sandbox,
          browser,
          replacement,
          fixture.context,
        );
        await expect(
          assertContactsExport(fixture.sandbox, replacement, fixture.context),
        ).rejects.toThrow(/exactly once/);
      } finally {
        browser.close();
        await fixture.sandbox.destroy(replacement, fixture.context);
      }
    } finally {
      await fixture.close();
    }
  });
});
