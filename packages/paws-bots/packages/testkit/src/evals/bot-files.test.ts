import { describe, expect, it } from "vitest";
import { BOT_FILES_EVAL_CASES } from "./bot-files.js";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";

type Calls = Array<{ name: string; args: Record<string, unknown> }>;
type Deliveries = NonNullable<Evidence["deliveries"]>;

function evidence(calls: Calls, deliveries: Deliveries = []): Evidence {
  return {
    deliveries,
    peerHome: "bots/coder",
    text: "",
    files: {},
    records: [],
    notes: [],
    calls: [],
    routines: [],
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: [],
    toolCalls: calls.map((call) => ({ step: 1, ...call })),
    finalStep: 1,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
  };
}

const failed = (id: string, calls: Calls, deliveries: Deliveries = []) =>
  BOT_FILES_EVAL_CASES.find((c) => c.id === id)!
    .grade(evidence(calls, deliveries))
    .filter((criterion) => !criterion.pass)
    .map((criterion) => criterion.id);

const shared = (kind: "message" | "handoff") => ({
  kind,
  text: "Deploy\n\nFiles on our shared computer:\n- bots/coder/site",
  files: [],
});

describe("bot files eval", () => {
  it("passes a folder sent by path and fails one pasted into the message", () => {
    expect(
      failed(
        "send-folder-on-shared-computer",
        [{ name: "message_bot", args: { bot_id: "servo", message: "Deploy", files: ["site"] } }],
        [shared("message")],
      ),
    ).toEqual([]);
    expect(
      failed(
        "send-folder-on-shared-computer",
        [
          {
            name: "message_bot",
            args: {
              bot_id: "servo",
              message:
                "export function renderLaunchCards(cards) {\n  return cards.filter((card) => card.ready).map(renderCard);\n}",
            },
          },
        ],
        [{ kind: "message", text: "export function renderLaunchCards", files: [] }],
      ),
    ).toHaveLength(3);
  });

  it("fails a send the tool rejected, even when the call looked right", () => {
    expect(
      failed("send-folder-on-shared-computer", [
        { name: "message_bot", args: { bot_id: "servo", message: "Deploy", files: ["site"] } },
      ]),
    ).toEqual(["servo received the site's shared paths"]);
  });

  it("needs the zip to reach a teammate with its own computer, even after a refused folder", () => {
    const calls = [
      { name: "message_bot", args: { message: "Deploy", files: ["site"] } },
      { name: "message_bot", args: { message: "Deploy", files: ["site.zip"] } },
    ];
    expect(
      failed("send-zip-to-own-computer", calls, [
        { kind: "message", text: "Deploy", files: ["site.zip"] },
      ]),
    ).toEqual([]);
    expect(failed("send-zip-to-own-computer", calls.slice(0, 1))).toEqual([
      'calls message_bot({"files":"~site.zip"})',
      "servo received site.zip",
    ]);
  });

  it("grades a group pass-off on the handoff, and a question on sending nothing", () => {
    expect(
      failed(
        "hand-off-folder-in-group",
        [{ name: "handoff_to_bot", args: { message: "Deploy", files: ["site"] } }],
        [shared("handoff")],
      ),
    ).toEqual([]);
    expect(
      failed(
        "question-sends-no-files",
        [{ name: "message_bot", args: { message: "Is it up?", files: ["site"] } }],
        [shared("message")],
      ),
    ).toEqual([
      'does not call message_bot({"files":"~site"})',
      "servo received the question without files",
    ]);
  });

  it("delivers the receiving case as a teammate's message naming the peer's folder", () => {
    const receiver = BOT_FILES_EVAL_CASES.find((c) => c.id === "receive-shared-path")!;
    expect(receiver.steps).toEqual([{ fromPeer: expect.stringContaining("{peerHome}/site") }]);
    expect(receiver.computerFiles?.every((file) => file.owner === "peer")).toBe(true);
  });

  it("needs the receiver to open the site at the peer's exact path", () => {
    const opened = (name: string, path: string) =>
      failed("receive-shared-path", [{ name, args: { path } }]);
    expect(opened("list_files", "bots/coder/site")).toEqual([]);
    expect(opened("list_files", "/bots/coder/site/")).toEqual([]);
    expect(opened("read_file", "~/bots/coder/site/app.js")).toEqual([]);
    const missed = ["opened the site at the peer's path"];
    // Reading the folder as a file, the subject's own folder, or a look-alike path fails.
    expect(opened("read_file", "bots/coder/site")).toEqual(missed);
    expect(opened("list_files", "site")).toEqual(missed);
    expect(opened("read_file", "bots/coder/website/app.js")).toEqual(missed);
  });
});
