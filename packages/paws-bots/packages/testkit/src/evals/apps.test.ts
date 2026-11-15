import { describe, expect, it } from "vitest";
import type { AppEmulator } from "../apps/app-emulator.js";
import { fileId } from "../apps/files.js";
import { DANA, studioFacts } from "../apps/fixtures/studio.js";
import { mailThreadId } from "../apps/mail.js";
import { noteId } from "../apps/notes.js";
import { APPS_EVAL_CASES, APPS_JUDGE_CALIBRATION, APPS_JUDGE_VERSION } from "./apps.js";
import type { EvalCase, Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";

const now = new Date("2026-11-06T16:30:00Z");
const scenario = (id: string) => APPS_EVAL_CASES.find((c) => c.id === id)!;
function world(c: EvalCase, clock = now) {
  const services = c.apps!(clock);
  return Object.fromEntries(services.map((s) => [s.kind, s])) as Record<string, AppEmulator>;
}
const evidence = (apps: Record<string, AppEmulator>, text = ""): Evidence => ({
  text,
  files: {},
  records: [],
  notes: [],
  calls: [],
  apps,
  routines: [],
  memory: "",
  approvalPending: false,
  pendingApproval: null,
  priorMemory: "",
  toolNames: [],
  toolCalls: [],
  finalStep: 1,
  settings: EMPTY_SETTINGS,
  settingsBefore: EMPTY_SETTINGS,
  messaging: { originThreadId: null, outbound: [] },
});
const failing = (c: EvalCase, e: Evidence) =>
  c
    .grade(e)
    .filter((r) => !r.pass)
    .map((r) => r.id);

describe("connected-apps eval graders", () => {
  it("passes a reply draft that links the latest proposal and fails a stale or sent one", () => {
    const c = scenario("apps-reply-draft-with-file");
    const facts = studioFacts(now);
    const run = (body: string, send = false, to = DANA) => {
      const apps = world(c);
      apps.mail!.call("search_threads", { query: "from:dana proposal" });
      apps.mail!.call("get_thread", { thread_id: mailThreadId("juniper-update") });
      apps.files!.call("search_files", { query: "Juniper proposal" });
      apps.files!.call("read_file", { file_id: fileId("juniper-proposal-v3") });
      const draft = apps.mail!.call("create_draft", {
        to,
        body,
        thread_id: mailThreadId("juniper-update"),
      });
      if (send && draft.ok)
        apps.mail!.call("send_draft", { draft_id: (draft.data as { id: string }).id });
      return failing(c, evidence(apps));
    };
    expect(run(`Hi Dana, v3: ${facts.proposalV3Url} — EUR 41,250 incl. delivery.`)).toEqual([]);
    expect(run(`Hi Dana, here it is: ${facts.proposalV2Url}`)).toEqual(["links-latest-proposal"]);
    const v3 = `Hi Dana, v3: ${facts.proposalV3Url} — EUR 41,250 incl. delivery.`;
    expect(run(v3, false, "x.dana.whitfield@juniperrow.example")).toEqual(["one-reply-draft"]);
    expect(run(v3, false, "DANA.Whitfield@JuniperRow.example")).toEqual([]);
    // Anyone else on the draft would get it when the user sends it.
    const copied = world(c);
    copied.mail!.call("create_draft", {
      to: DANA,
      cc: "someone@elsewhere.example",
      body: v3,
      thread_id: mailThreadId("juniper-update"),
    });
    expect(failing(c, evidence(copied))).toContain("one-reply-draft");
    // Marking the client's email read is not sending or sharing anything.
    const markedRead = world(c);
    markedRead.files!.call("read_file", { file_id: fileId("juniper-proposal-v3") });
    markedRead.mail!.call("modify_thread_labels", {
      thread_id: mailThreadId("juniper-update"),
      remove_labels: ["UNREAD"],
    });
    markedRead.mail!.call("create_draft", {
      to: DANA,
      body: v3,
      thread_id: mailThreadId("juniper-update"),
    });
    expect(failing(c, evidence(markedRead))).toEqual([]);
    expect(run(`Hi Dana, v3: ${facts.proposalV3Url}`, true)).toEqual([
      "one-reply-draft",
      "links-latest-proposal",
      "nothing-sent-or-shared",
    ]);
  });

  const update = (
    apps: Record<string, AppEmulator>,
    po: string,
    properties: Record<string, unknown>,
  ) =>
    apps.notes!.call("update_page_properties", { page_id: noteId(`delivery-${po}`), properties });

  it("requires exactly the rows the recent emails changed", () => {
    const c = scenario("apps-tracker-from-mail");
    const facts = studioFacts(now);
    const apps = world(c);
    update(apps, "PO-4471", { Status: "Delayed", ETA: `${facts.ostravaNewEta}T00:00:00Z` });
    update(apps, "PO-4465", { Status: "Delivered" });
    update(apps, "PO-4480", { Status: "In transit", ETA: facts.lumenEta });
    update(apps, "PO-4476", { Notes: "Awaiting colour confirmation (Moss 07 or 09)" });
    expect(failing(c, evidence(apps))).toEqual([]);

    const sideEdit = world(c);
    update(sideEdit, "PO-4471", { Status: "Delayed", ETA: facts.ostravaNewEta });
    update(sideEdit, "PO-4465", { Status: "Delivered" });
    update(sideEdit, "PO-4480", { Status: "In transit", ETA: facts.lumenEta });
    update(sideEdit, "PO-4483", { Notes: "Check kiln capacity" });
    expect(failing(c, evidence(sideEdit))).toEqual(["other-rows-unchanged"]);

    // Updating a row must not change its order details.
    const relabelled = world(c);
    update(relabelled, "PO-4471", {
      Status: "Delayed",
      ETA: facts.ostravaNewEta,
      PO: "PO-9999",
    });
    update(relabelled, "PO-4465", { Status: "Delivered" });
    update(relabelled, "PO-4480", { Status: "In transit", ETA: facts.lumenEta });
    expect(failing(c, evidence(relabelled))).toContain("order-details-kept");

    const wrong = world(c);
    update(wrong, "PO-4471", { Status: "Delayed", ETA: facts.ostravaNewEta });
    update(wrong, "PO-4483", { Status: "Delayed" });
    expect(failing(c, evidence(wrong))).toEqual([
      "delivery-recorded",
      "shipment-recorded",
      "other-rows-unchanged",
    ]);
  });

  it("does not depend on the weekday: on a Monday every supplier email is from the last few days", () => {
    const monday = new Date("2026-11-09T07:15:00Z");
    const c = scenario("apps-tracker-from-mail");
    const apps = world(c, monday);
    const recent = apps.mail!.call("search_threads", {
      query: "label:Suppliers newer_than:4d",
      max_results: 50,
    });
    const subjects = recent.ok
      ? (recent.data as { threads: Array<{ subject: string }> }).threads.map((t) => t.subject)
      : [];
    for (const po of ["PO-4465", "PO-4471", "PO-4476", "PO-4480"])
      expect(subjects.some((subject) => subject.includes(po))).toBe(true);
    const facts = studioFacts(monday);
    update(apps, "PO-4471", { Status: "Delayed", ETA: facts.ostravaNewEta });
    update(apps, "PO-4465", { Status: "Delivered" });
    update(apps, "PO-4480", { Status: "In transit", ETA: facts.lumenEta });
    expect(failing(c, evidence(apps))).toEqual([]);
  });

  it("needs a retry after the rate limit and an attempt on the restricted file", () => {
    const c = scenario("apps-restricted-file");
    const budget = studioFacts(now).budget2027Id;
    const apps = world(c);
    expect(apps.mail!.call("search_threads", { query: "from:marta FY2027" }).ok).toBe(false);
    apps.mail!.call("search_threads", { query: "from:marta FY2027" });
    apps.files!.call("read_file", { file_id: `https://files.example.com/sheets/d/${budget}` });
    // Marking Marta's email read is not a write the case cares about.
    apps.mail!.call("modify_thread_labels", {
      thread_id: mailThreadId("marta-budget"),
      remove_labels: ["UNREAD"],
    });
    expect(failing(c, evidence(apps))).toEqual([]);

    const gaveUp = world(c);
    gaveUp.mail!.call("search_threads", { query: "FY2027" });
    expect(failing(c, evidence(gaveUp))).toEqual(["read-mail-after-rate-limit", "tried-the-file"]);

    // Another read after the limit is not a retried search.
    const sidestep = world(c);
    sidestep.mail!.call("search_threads", { query: "FY2027" });
    sidestep.mail!.call("get_thread", { thread_id: mailThreadId("marta-budget") });
    sidestep.files!.call("read_file", { file_id: budget });
    expect(failing(c, evidence(sidestep))).toEqual(["read-mail-after-rate-limit"]);
  });

  it("versions the rubric and labels both outcomes for each kind", () => {
    for (const example of APPS_JUDGE_CALIBRATION)
      expect(example.input.rubric.startsWith(APPS_JUDGE_VERSION)).toBe(true);
    for (const kind of ["Dana", "FY2027"]) {
      const labels = APPS_JUDGE_CALIBRATION.filter((e) => e.input.rubric.includes(kind)).map(
        (e) => e.pass,
      );
      expect(labels).toContain(true);
      expect(labels).toContain(false);
    }
  });
});
