import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";
import {
  loadRecallCases,
  RECALL_EVAL_CASES,
  RECALL_FIXTURE_VERSION,
  RECALL_JUDGE_CALIBRATION,
  RECALL_JUDGE_VERSION,
} from "./recall.js";
import { scriptedShell } from "./scripted-shell.js";

const scenario = (id: string) => RECALL_EVAL_CASES.find((c) => c.id === `recall-${id}`)!;
const LEASE_PATH = "attachments/abc123.md";
const onComputer = { "lisbon-office-lease.md": { path: LEASE_PATH, content: "Notice period" } };
function evidence(
  toolCalls: Evidence["toolCalls"],
  text = "",
  seededAttachments: Evidence["seededAttachments"] = onComputer,
): Evidence {
  return {
    text,
    files: {},
    seededAttachments,
    records: [],
    notes: [],
    calls: [],
    routines: [],
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: toolCalls.map((c) => c.name),
    toolCalls,
    finalStep: 1,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
  };
}
const failed = (id: string, e: Evidence) =>
  scenario(id)
    .grade(e)
    .filter((c) => !c.pass)
    .map((c) => c.id);
const search = { step: 1, name: "search_history", args: { query: "lease" } };
const read = { step: 1, name: "read_file", args: { path: "attachments/abc123.md" } };

describe("recall outcome grading", () => {
  it("seeds the file far outside the recent window, with or without a caption", () => {
    for (const id of ["old-file-captioned", "old-file-uncaptioned", "absent-file"]) {
      const history = scenario(id).history!;
      expect(history.version).toBe(RECALL_FIXTURE_VERSION);
      expect(history.messages).toHaveLength(1000);
      const shared = history.messages.filter((m) => m.file);
      expect(shared.map((m) => [m.seq, m.role, m.file!.name])).toEqual([
        [30, "user", "lisbon-office-lease.md"],
      ]);
      expect(history.summary!.text).not.toContain("90");
    }
    expect(scenario("old-file-uncaptioned").history!.messages[30]!.text).toBe("");
  });

  it("requires looking back and reading the earlier file before the answer counts", () => {
    expect(failed("old-file-captioned", evidence([search, read]))).toEqual([]);
    expect(failed("old-file-uncaptioned", evidence([search]))).toEqual(["read-earlier-file"]);
    expect(failed("old-file-captioned", evidence([]))).toEqual([
      "searched-history",
      "read-earlier-file",
    ]);
    // Work from an earlier step does not count for the question being graded.
    expect(failed("old-file-captioned", evidence([{ ...read, step: 0 }, search]))).toEqual([
      "read-earlier-file",
    ]);
    expect(
      failed(
        "old-file-captioned",
        evidence([search, { ...read, args: { path: `./${LEASE_PATH}` } }]),
      ),
    ).toEqual([]);
    // Another file, another tool, or a lease that never reached the computer does not count.
    expect(
      failed(
        "old-file-captioned",
        evidence([search, { ...read, args: { path: "attachments/other.md" } }]),
      ),
    ).toEqual(["read-earlier-file"]);
    expect(
      failed("old-file-captioned", evidence([search, { ...read, name: "list_files" }])),
    ).toEqual(["read-earlier-file"]);
    const missing = { "lisbon-office-lease.md": { path: LEASE_PATH, content: null } };
    expect(failed("old-file-captioned", evidence([search, read], "", missing))).toEqual([
      "read-earlier-file",
    ]);
  });

  it("asks only that a never-shared file was looked for", () => {
    expect(failed("absent-file", evidence([search]))).toEqual([]);
    expect(failed("absent-file", evidence([]))).toEqual(["searched-history"]);
  });

  it("seeds one earlier reply that worked with tools, compacted only in the long chat", () => {
    for (const [id, size] of [
      ["tool-steps-replayed", 24],
      ["tool-steps-compacted", 100],
    ] as const) {
      for (const variant of [id, `${id}-absent`]) {
        const history = scenario(variant).history!;
        expect(history.messages).toHaveLength(size);
        expect(history.messages.filter((m) => m.steps).map((m) => [m.seq, m.role])).toEqual([
          [3, "bot"],
        ]);
        expect(history.compact).toBe(size === 100 ? true : undefined);
        expect(history.summary).toBeUndefined();
      }
    }
    const notes = (id: string) =>
      scenario(id)
        .history!.messages[3]!.steps!.map((step) => step.note ?? "")
        .join(" ");
    expect(notes("tool-steps-replayed")).toContain("Midnight Lizard");
    expect(notes("tool-steps-replayed-absent")).not.toMatch(/extension/i);
  });

  it("keeps the short chat's variants and varies the long chat's small talk", () => {
    const steps = (id: string) => scenario(id).history!.messages[3]!.steps!;
    expect(steps("tool-steps-replayed").every((step) => step.outcomes)).toBe(true);
    expect(steps("tool-steps-replayed-intent").some((step) => step.outcomes)).toBe(false);
    expect(steps("tool-steps-replayed-intent").map((step) => step.note)).toEqual(
      steps("tool-steps-replayed").map((step) => step.note),
    );
    // The paraphrased earlier turn shares no distinctive word with the question.
    const earlier = scenario("tool-steps-replayed-paraphrased")
      .history!.messages.slice(2, 4)
      .map((m) => `${m.text} ${(m.steps ?? []).map((step) => step.note ?? "").join(" ")}`)
      .join(" ");
    expect(earlier).toContain("Midnight Lizard");
    expect(earlier).not.toMatch(/install|extension|browser/i);
    const long = scenario("tool-steps-compacted").history!.messages.map((m) => m.text);
    const chat = long.filter(Boolean);
    expect(new Set(chat).size).toBe(chat.length);
  });

  it("records re-checks, lookups and judged behaviour without failing on them", () => {
    const shell = { step: 1, name: "shell", args: {} };
    for (const c of RECALL_EVAL_CASES.filter((c) => /tool-steps|ordinary/.test(c.id))) {
      expect(c.shellUnneeded).toBe(true);
      const observed = c.observe!(evidence([search, shell], "reply"));
      expect(observed.reverified).toBe(true);
      expect(observed["looked-back"]).toBe(true);
      expect(c.observe!(evidence([{ ...shell, step: 0 }], "reply")).reverified).toBe(false);
      const judged = Object.values(observed).filter((v) => typeof v === "object");
      expect(judged.length).toBeGreaterThan(0);
      for (const input of judged) {
        expect(input.rubric.startsWith(`${RECALL_JUDGE_VERSION} behaviour:`)).toBe(true);
        const anchors = RECALL_JUDGE_CALIBRATION.filter((a) => a.input.rubric === input.rubric);
        expect(new Set(anchors.map((a) => a.pass))).toEqual(new Set([true, false]));
      }
    }
    expect(Object.keys(scenario("ordinary-sign-off").observe!(evidence([], "")))).toContain(
      "unprompted-doubt",
    );
    expect(Object.keys(scenario("tool-steps-replayed").observe!(evidence([], "")))).not.toContain(
      "unprompted-doubt",
    );
  });

  it("gives re-checks a computer that matches what the earlier reply did", () => {
    const shell = (id: string, command: string) => scriptedShell(scenario(id).computer!, command);
    const listing = "ls ~/.config/chromium/Default/Extensions";
    for (const id of ["tool-steps-replayed", "tool-steps-compacted", "ordinary-sign-off"]) {
      expect(scenario(id).computer!.screen.dark).toBe(true);
      const extension = shell(id, listing)!.stdout;
      expect(extension).toMatch(/^[a-p]{32}$/);
      expect(shell(id, `ls ~/.config/chromium/Default/Extensions/${extension}`)!.stdout).toBe(
        "10.7.1_0",
      );
      expect(shell(id, `cat ~/x/Extensions/${extension}/10.7.1_0/manifest.json`)!.stdout).toContain(
        '"name": "Midnight Lizard"',
      );
      expect(shell(id, "grep -A3 pbn ~/.config/chromium/Default/Preferences")!.stdout).toContain(
        '"state": 1',
      );
    }
    const absent = "tool-steps-replayed-absent";
    expect(scenario(absent).computer!.screen.dark).toBe(false);
    expect(shell(absent, listing)).toMatchObject({ stdout: "", code: 2 });
    // Both computers run the same Chromium, and unrelated commands stay unavailable.
    for (const id of ["tool-steps-replayed", absent]) {
      expect(shell(id, "pgrep -a chromium")!.stdout).toContain("/usr/lib/chromium/chromium");
      expect(shell(id, "chromium --version")!.stdout).toMatch(/^Chromium 131\./);
      expect(shell(id, "uname -a")).toBeUndefined();
    }
    // The file spells the name with capitals, so a case-sensitive lowercase search finds nothing.
    const prefs = "~/.config/chromium/Default/Preferences";
    expect(shell("tool-steps-replayed", `grep -o '"midnight[^"]*"' ${prefs}`)).toMatchObject({
      stdout: "",
      code: 1,
    });
    expect(shell("tool-steps-replayed", `grep -io '"midnight[^"]*"' ${prefs}`)!.code).toBe(0);
    // Only the installed extension's own manifest shows it; an unrelated path proves nothing.
    expect(shell("tool-steps-replayed", "cat ~/notes/manifest.json")).toBeUndefined();
    // A redirect silences only the check it follows, so an earlier failure still shows.
    const loop = shell(
      absent,
      "for f in a; do cat ~/x/manifest.json; ls ~/.config/chromium/Default/Extensions 2>/dev/null; done",
    )!;
    expect(loop.stderr).toContain("manifest.json: No such file");
    expect(loop.stderr).not.toContain("cannot access");
    // The chat happened earlier today, so it reads as the one under way.
    const seeded = scenario("tool-steps-replayed").history!.messages;
    expect(Date.now() - seeded[0]!.createdAt.getTime()).toBeLessThan(24 * 60 * 60_000);
    expect(seeded.at(-1)!.createdAt.getTime()).toBeLessThan(Date.now());
  });

  it("keeps the bare Done reply issue #3683 found next to the reply that reports its result", () => {
    const reply = (id: string) => scenario(id).history!.messages[3]!;
    expect(reply("tool-steps-replayed-bare").text).toBe("Done.");
    expect(reply("tool-steps-replayed").text).toMatch(/^Done\. .+dark/);
    // Each fixture dates its screen capture from its own build time, so compare without it.
    const undated = (id: string) =>
      JSON.stringify(reply(id).steps).replace(/capturedAt[^,]*/, "capturedAt");
    expect(undated("tool-steps-replayed-bare")).toBe(undated("tool-steps-replayed"));
    const capture = JSON.stringify(reply("tool-steps-replayed").steps).match(
      /capturedAt\\":\\"([^\\]+)/,
    )?.[1];
    expect(Date.parse(capture!)).toBeGreaterThan(reply("tool-steps-replayed").createdAt.getTime());
  });

  it("shows the overclaim judge the record and what the bot checked just now", () => {
    const shell = {
      step: 1,
      name: "shell",
      args: { command: "ls ~/.config/chromium/Default/Extensions" },
    };
    const input = scenario("tool-steps-replayed").observe!(evidence([search, shell], "reply"))
      .overclaim as { evidence: Record<string, string> };
    expect(input.evidence.record).toContain("user: Your screenshots of docs");
    expect(input.evidence.record).toContain("Shell ×2 (succeeded)");
    expect(input.evidence.record).toMatch(/bot: .*\n(.|\n)*Done\. Pages in my browser/);
    expect(input.evidence.checks).toMatch(/returned \(exit 0\):\n[a-p]{32}/);
    expect(input.evidence.checks).toContain("search_history");
    // A silent failure is told apart from a silent success by its exit code.
    const prefs = {
      ...shell,
      args: { command: "grep pbn ~/.config/chromium/Default/Preferences" },
    };
    const plain = scenario("tool-steps-replayed-absent").observe!(
      evidence([search, prefs], "reply"),
    ).overclaim as { evidence: Record<string, string> };
    expect(plain.evidence.checks).toContain("returned (exit 1):\n(no output)");
  });

  it("observes, rather than grades, a reply that copies the replayed marker", () => {
    const copied = evidence([], "[tool calls this reply made]\n- Shell ×2");
    expect(failed("tool-steps-replayed", copied)).toEqual([]);
    expect(scenario("tool-steps-replayed").observe!(copied)["copied-marker"]).toBe(true);
    expect(
      scenario("tool-steps-replayed").observe!(evidence([], "Yes, Midnight Lizard."))[
        "copied-marker"
      ],
    ).toBe(false);
  });

  it("in a tool-heavy chat, passes a real check and observes a step list or a call written out", () => {
    const c = scenario("tool-heavy-new-check");
    const history = c.history!;
    expect(history.messages).toHaveLength(48);
    expect(history.messages.filter((m) => m.steps).length).toBe(12);
    const uptime = { step: 1, name: "shell", args: { command: "uptime" } };
    expect(failed("tool-heavy-new-check", evidence([uptime], "Up 3 days."))).toEqual([]);
    expect(scriptedShell(c.computer!, "uptime")?.stdout).toContain("up 3 days");
    // A history lookup, or a command that reads something else, is not a check of the uptime.
    const listing = { step: 1, name: "shell", args: { command: "ls ~" } };
    for (const calls of [[search], [listing]])
      expect(failed("tool-heavy-new-check", evidence(calls, "Up a while."))).toEqual([
        "checked-now",
      ]);
    expect(scriptedShell(c.computer!, "cat /proc/uptime")?.stdout).toBe("274620.31 1081234.55");
    expect(scriptedShell(c.computer!, "pwd; ls -la ~; uptime")?.stdout).toContain(".config");
    expect(scriptedShell(c.computer!, 'ls -la "$HOME"')?.stdout).toContain(".config");
    // A search that also covers places the computer lacks still finds the extension.
    const installed = scenario("tool-steps-replayed").computer!;
    for (const command of [
      'grep -ril "midnight" ~/.config ~/.cache',
      'grep -ril "midnight" ~/.config ~/Library/Application\\ Support',
    ])
      expect(scriptedShell(installed, command)?.stdout).toContain("manifest.json");
    expect(scriptedShell(installed, "ls ~/.config/google-chrome/Default/Extensions")?.code).toBe(2);
    // Commands bots ran in recorded trials, answered as the computer would.
    const computer = scenario("tool-steps-replayed").computer!;
    const dir = "~/.config/chromium/Default/Extensions/pbnhgcfkmdlhnoeajihcmpgkglmbjblb/10.7.1_0";
    expect(scriptedShell(computer, `cd ${dir} && head -c 1500 manifest.json`)?.stdout).toContain(
      "Midnight Lizard",
    );
    expect(
      scriptedShell(computer, 'grep -ril "midnight" ~/.config/chromium/Default/Preferences')
        ?.stdout,
    ).toBe("/home/rakazo/.config/chromium/Default/Preferences");
    expect(
      scriptedShell(
        computer,
        "grep -i midnight ~/.config/chromium/Default/Preferences | cut -c1-34",
      )?.stdout,
    ).toBe(`"pbnhgcfkmdlhnoeajihcmpgkglmbjblb"`);
    expect(scriptedShell(computer, 'ls ~/.config/google-chrome; echo "exit: $?"')?.stdout).toBe(
      "exit: 2",
    );
    expect(
      scriptedShell(
        computer,
        'find ~ -maxdepth 8 -name manifest.json -path "*Extensions*" 2>/dev/null | xargs grep -l -i "midnight"',
      )?.stdout,
    ).toContain("manifest.json");
    expect(
      scriptedShell(computer, "ls -d ~/.config/chromium* ~/.config/google-chrome* 2>/dev/null")
        ?.stdout,
    ).toBe("/home/rakazo/.config/chromium");
    // A find too shallow to reach the manifest finds nothing, piped or not.
    expect(scriptedShell(computer, "find ~ -maxdepth 6 -name manifest.json")?.stdout).toBe("");
    expect(
      scriptedShell(computer, "find ~ -maxdepth 6 -name manifest.json | xargs grep -l midnight")
        ?.stdout,
    ).toBe("");
    // Recorded searches that include Preferences list what a real shell would.
    expect(
      scriptedShell(
        computer,
        'grep -ril "midnight" ~/.config/chromium/Default/Extensions ~/.config/chromium/Default/Preferences 2>/dev/null | head',
      )?.stdout.split("\n"),
    ).toEqual([expect.stringContaining("manifest.json"), expect.stringContaining("Preferences")]);
    expect(
      scriptedShell(
        computer,
        "find ~ -maxdepth 6 -name Preferences 2>/dev/null | xargs grep -l -i lizard 2>/dev/null | head",
      )?.stdout,
    ).toBe("/home/rakazo/.config/chromium/Default/Preferences");
    // A grep -l of Preferences for something it doesn't hold lists nothing.
    expect(
      scriptedShell(computer, "grep -l -i firefox ~/.config/chromium/Default/Preferences")?.stdout,
    ).not.toContain("Preferences");
    // A search by the extension's title finds nothing; by its id, its folder.
    expect(scriptedShell(computer, 'find ~ -maxdepth 8 -iname "*midnight*lizard*"')?.stdout).toBe(
      "",
    );
    expect(
      scriptedShell(computer, "find ~ -maxdepth 6 -type d -name 'pbnhgcfkmdlhnoeajihcmpgkglmbjblb'")
        ?.stdout,
    ).toContain("Extensions/pbnhgcfkmdlhnoeajihcmpgkglmbjblb");
    expect(scriptedShell(computer, "ls -la ../../shared 2>/dev/null; pwd")?.stdout).toBe(
      "/home/rakazo",
    );
    // A probe for several browsers still finds the Chromium the computer has.
    expect(
      scriptedShell(
        scenario("tool-steps-replayed").computer!,
        "which chromium chromium-browser google-chrome",
      )?.stdout,
    ).toBe("/usr/bin/chromium");
    const observed = (text: string) => c.observe!(evidence([], text));
    expect(observed("- Shell (succeeded): Checking uptime.\nUp 3 days.")["copied-marker"]).toBe(
      true,
    );
    expect(observed("- Shell ×2 (1 succeeded, 1 failed)")["copied-marker"]).toBe(true);
    for (const text of [
      'shell({"command": "uptime"})',
      '<tool_call>{"name": "shell", "arguments": {"command": "uptime"}}</tool_call>',
      '<function=shell>{"command": "uptime"}</function>',
      '<|tool_call|>{"name": "shell"}',
      '[TOOL_CALLS] [{"name": "shell"}]',
    ])
      expect(observed(text)["tool-call-text"]).toBe(true);
    const plain = observed("It has been up for 3 days and 4 hours.\n- Restarted on Sunday");
    expect(plain["copied-marker"]).toBe(false);
    expect(plain["tool-call-text"]).toBe(false);
  });

  it("fails a history lookup on everyday turns only when the turn cannot need one", () => {
    const egg = scenario("ordinary-visible").history!.messages.slice(-2);
    expect(egg.map((m) => [m.role, m.text])).toEqual([
      ["user", "How long should I boil an egg for a jammy yolk?"],
      ["bot", "About six and a half minutes, then into cold water."],
    ]);
    for (const id of ["sign-off", "visible", "general", "related", "never-told"]) {
      const history = scenario(`ordinary-${id}`).history!;
      expect(history.messages[3]!.steps?.[0]?.note).toContain("Midnight Lizard");
      expect(failed(`ordinary-${id}`, evidence([], "reply"))).toEqual([]);
      expect(failed(`ordinary-${id}`, evidence([search], "reply"))).toEqual(
        id === "related" || id === "never-told" ? [] : ["no-history-lookup"],
      );
    }
  });

  it("shows the install judge the summary a compacted chat left the bot", () => {
    const judged = scenario("tool-steps-compacted").judge!({
      ...evidence([], "reply"),
      historySummary: "Installed Midnight Lizard with two shell commands.",
    });
    expect((judged.evidence as { record: string }).record).toContain("two shell commands");
  });

  it("shows the install judge the checks made in the reply, in anchors as in trials", () => {
    const installAnchors = RECALL_JUDGE_CALIBRATION.filter((a) =>
      a.input.rubric.includes("asking whether the bot installed a browser extension"),
    );
    expect(installAnchors.length).toBeGreaterThan(0);
    for (const anchor of installAnchors) expect(anchor.input.evidence).toHaveProperty("checks");
  });

  it("leaves meaning to a versioned judge with labelled anchors for every rubric", () => {
    // The tool-heavy case grades only whether a call was made, so it has no judge.
    expect(RECALL_EVAL_CASES.filter((c) => !c.judge).map((c) => c.id)).toEqual([
      "recall-tool-heavy-new-check",
    ]);
    for (const c of RECALL_EVAL_CASES.filter((c) => c.judge)) {
      const input = c.judge?.(evidence([], "reply"));
      expect(input?.rubric.startsWith(`${RECALL_JUDGE_VERSION}:`)).toBe(true);
      expect(input?.evidence).toMatchObject({ reply: "reply" });
      const anchors = RECALL_JUDGE_CALIBRATION.filter((a) => a.input.rubric === input?.rubric);
      expect(new Set(anchors.map((a) => a.pass))).toEqual(new Set([true, false]));
    }
  });

  it("loads extra cases from a file, checked and graded like the built-in ones", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "recall-cases-")), "cases.jsonl");
    const steps = [{ label: "Shell", tool: "shell", count: 1, calls: [{ arguments: "{}" }] }];
    writeFileSync(
      file,
      [
        {
          id: "recall-file-uptime",
          purpose: "needs a fresh check",
          messages: [
            { role: "user", text: "Disk?" },
            { role: "bot", text: "18 GB.", steps },
          ],
          ask: "Uptime now?",
          expect: { kind: "needs-tool", command: "\\buptime\\b" },
          computer: { shell: [{ match: "\\buptime\\b", output: "up 3 days" }] },
        },
        {
          id: "recall-file-sign-off",
          purpose: "an everyday turn",
          messages: [{ role: "user", text: "Hi" }],
          ask: "Bye!",
          expect: { kind: "rubric", rubric: "sign-off" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const [uptime, signOff] = loadRecallCases(file);
    expect(uptime!.history!.messages[1]!.steps).toEqual(steps);
    expect(scriptedShell(uptime!.computer!, "uptime")?.stdout).toBe("up 3 days");
    expect(uptime!.grade(evidence([], "Up a while.")).map((c) => c.pass)).toEqual([false]);
    const ran = { step: 1, name: "shell", args: { command: "uptime -p" } };
    expect(uptime!.grade(evidence([ran], "Up 3 days.")).map((c) => c.pass)).toEqual([true]);
    expect(uptime!.judge).toBeUndefined();
    expect(signOff!.judge!(evidence([], "Bye")).rubric).toContain(RECALL_JUDGE_VERSION);
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "recall-file-install",
          purpose: "an install question",
          messages: [
            { role: "user", text: "Dark pages?" },
            { role: "bot", text: "Installed Night Owl.", steps },
          ],
          ask: "Did you install an extension?",
          expect: { kind: "rubric", rubric: "installed" },
        },
      ]),
    );
    const [install] = loadRecallCases(file);
    const record = (install!.judge!(evidence([], "Yes")).evidence as { record: string }).record;
    expect(record).toContain("Installed Night Owl.");
    const badPattern = {
      id: "recall-file-bad",
      purpose: "x",
      messages: [{ role: "user", text: "x" }],
      ask: "x",
      expect: { kind: "needs-tool", command: "(" },
    };
    writeFileSync(file, JSON.stringify([badPattern]));
    expect(() => loadRecallCases(file)).toThrow(/valid regular expression/);
    const backwards = {
      ...badPattern,
      expect: { kind: "rubric", rubric: "sign-off" },
      messages: [
        { role: "user", text: "x", day: 0 },
        { role: "bot", text: "y", day: -2 },
      ],
    };
    writeFileSync(file, JSON.stringify([backwards]));
    expect(() => loadRecallCases(file)).toThrow(/earlier message's day/);
    writeFileSync(file, JSON.stringify([{ id: "bad", purpose: "x", messages: [], ask: "x" }]));
    expect(() => loadRecallCases(file)).toThrow();
  });
});
