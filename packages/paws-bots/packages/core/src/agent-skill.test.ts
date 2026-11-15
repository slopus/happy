import { describe, expect, it } from "vitest";
import {
  buildSkillMd,
  expandSkillReferencesInPrompt,
  extractForcedSkillName,
  extractRoutineSkillMentions,
  findSkillByName,
  formatSkillsCatalogInstruction,
  mergeBuiltinSkills,
  parseSkillMd,
  renameRoutineSkillMentions,
} from "./agent-skill.js";

describe("built-in skill merging", () => {
  it("uses the same normalized names for catalog precedence and prompt expansion", () => {
    const builtin = {
      name: "Interrogate",
      description: "Builtin review",
      content: "Builtin instructions",
      source: "builtin" as const,
      readOnly: true,
    };
    const saved = {
      ...builtin,
      name: " Interrogate ",
      content: "Saved instructions",
      source: "user" as const,
      readOnly: false,
    };
    const skills = mergeBuiltinSkills<typeof builtin | typeof saved>([builtin], [saved]);
    expect(skills).toEqual([saved]);
    expect(findSkillByName(skills, " INTERROGATE ")).toBe(saved);
    for (const prompt of ["/Interrogate\nreview this", "Use @Interrogate to review this"]) {
      expect(expandSkillReferencesInPrompt(prompt, skills)).toContain("Saved instructions");
      expect(expandSkillReferencesInPrompt(prompt, skills)).not.toContain("Builtin instructions");
      expect(expandSkillReferencesInPrompt(prompt, skills)).not.toContain("@Interrogate");
    }
    expect(mergeBuiltinSkills([builtin], [])).toEqual([builtin]);
  });
});

const SAMPLE = `---
name: Daily standup
description: Prepare a concise standup update from recent work. Use when the user asks for standup notes or a status summary.
compatibility: optional-extra
allowed-tools: [shell, read_file]
long-desc: >-
  Folded description that spans
  multiple lines with strip chomping.
literal: |+
  Keep trailing newlines

  And blank lines.
---

# Daily standup

1. Scan recent commits and open tasks.
2. Summarize wins, plans, and blockers.
`;

describe("parseSkillMd", () => {
  it("parses name, description, body, and extra frontmatter keys", () => {
    const parsed = parseSkillMd(SAMPLE);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.name).toBe("Daily standup");
    expect(parsed.description).toContain("standup");
    expect(parsed.body).toContain("# Daily standup");
    expect(parsed.frontmatter.compatibility).toBe("optional-extra");
    expect(parsed.frontmatter["allowed-tools"]).toEqual(["shell", "read_file"]);
    expect(String(parsed.frontmatter["long-desc"])).toBe(
      "Folded description that spans multiple lines with strip chomping.",
    );
    expect(String(parsed.frontmatter.literal)).toContain("Keep trailing newlines");
    expect(String(parsed.frontmatter.literal).endsWith("\n")).toBe(true);
  });

  it("accepts comments after block scalar headers without changing their values", () => {
    for (const header of [">", ">-", ">2", ">2-", ">-2", "|", "|+", "|2", "|2+", "|+2"]) {
      for (const separator of [" ", "\t"]) {
        const doc = (suffix: string) =>
          `---\nname: Example\ndescription: ${header}${suffix}\n  First # content\n  Second\n---\n\n# Body\n`;
        const expected = parseSkillMd(doc(""));
        const parsed = parseSkillMd(doc(`${separator}# header comment`));
        expect("error" in expected, header).toBe(false);
        expect(parsed, `${header}${separator}`).toEqual(expected);
        if ("error" in parsed) continue;
        expect(parsed.description, header).toBe(
          header.startsWith(">") ? "First # content Second" : "First # content\nSecond",
        );
        expect(parsed.body).toContain("# Body");
      }
    }
  });

  it("does not treat a hash without separation as a block header comment", () => {
    const parsed = parseSkillMd("---\nname: Example\ndescription: >#comment\n  text\n---\n");
    expect(parsed).toEqual({ error: "Unexpected indented frontmatter line without a key." });
  });

  it("preserves commas in quoted inline array items through save and reload", () => {
    const cases = [
      { input: '["sales, marketing", "ops"]', expected: ["sales, marketing", "ops"] },
      { input: "['sales, marketing', 'ops']", expected: ["sales, marketing", "ops"] },
      { input: "['we''re, ready', ops]", expected: ["we're, ready", "ops"] },
      {
        input: `[${JSON.stringify('say "hi, team"')}, ${JSON.stringify("path\\part, rest")}]`,
        expected: ['say "hi, team"', "path\\part, rest"],
      },
      { input: "[alpha, beta, gamma]", expected: ["alpha", "beta", "gamma"] },
    ];
    for (const { input, expected } of cases) {
      const parsed = parseSkillMd(`---\nname: Example\ndescription: Test\ntags: ${input}\n---\n`);
      expect("error" in parsed, input).toBe(false);
      if ("error" in parsed) continue;
      expect(parsed.frontmatter.tags, input).toEqual(expected);
      const reloaded = parseSkillMd(buildSkillMd(parsed));
      expect("error" in reloaded, input).toBe(false);
      if (!("error" in reloaded)) expect(reloaded.frontmatter.tags, input).toEqual(expected);
    }
  });

  it("keeps existing handling of unquoted scalar array items", () => {
    const parsed = parseSkillMd(
      "---\nname: Example\ndescription: Test\ntags: [plain, true, 2.5]\n---\n",
    );
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) expect(parsed.frontmatter.tags).toEqual(["plain", true, 2.5]);
  });

  it("parses block scalar indicators with chomping and indent hints", () => {
    const doc = `---
name: Folded
description: >-
  Multi-line description
  that folds.
notes: |+
  Keep trailing newlines.


indent: |2
  Indented block
chomp-indent: |-2
  Chomp then indent
---

# Body
`;
    const parsed = parseSkillMd(doc);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.description).toBe("Multi-line description that folds.");
    expect(parsed.frontmatter.notes).toBe("Keep trailing newlines.\n\n\n");
    expect(parsed.frontmatter.indent).toBe("Indented block\n");
    expect(parsed.frontmatter["chomp-indent"]).toBe("Chomp then indent");
  });

  it("preserves more-indented lines inside folded scalars", () => {
    const cases: Array<{ label: string; detail: string; expected: string }> = [
      {
        label: "adjacent indented fragment",
        detail: `>
  Intro line
  continues here
    more indented
    also indented
  outro line
`,
        // Matches yaml@2.9 folded semantics: newline separation, not space-fold.
        expected: "Intro line continues here\n  more indented\n  also indented\noutro line\n",
      },
      {
        label: "blank lines around indented list",
        detail: `>
  paragraph one
  still one

    - list item
    - two

  paragraph two
`,
        expected: "paragraph one still one\n\n  - list item\n  - two\n\nparagraph two\n",
      },
      {
        label: "indented block without surrounding blanks",
        detail: `>
  before
    code block
    line two
  after
`,
        expected: "before\n  code block\n  line two\nafter\n",
      },
    ];

    for (const { label, detail, expected } of cases) {
      const parsed = parseSkillMd(`---
name: Fold indent
description: Folded with indented fragment
detail: ${detail}---

# Body
`);
      expect("error" in parsed, label).toBe(false);
      if ("error" in parsed) return;
      expect(parsed.frontmatter.detail, label).toBe(expected);
    }
  });

  it("requires name and description", () => {
    expect(parseSkillMd("---\nname: x\n---\nbody")).toEqual({
      error: "SKILL.md frontmatter requires description.",
    });
    expect(parseSkillMd("no frontmatter")).toMatchObject({ error: expect.any(String) });
  });

  it("rejects overlong names", () => {
    const name = "N".repeat(81);
    expect(parseSkillMd(`---\nname: ${name}\ndescription: ok\n---\nbody`)).toEqual({
      error: "Skill name must be at most 80 characters.",
    });
  });
});

describe("buildSkillMd", () => {
  it("round-trips and preserves extra keys", () => {
    const parsed = parseSkillMd(SAMPLE);
    if ("error" in parsed) throw new Error(parsed.error);
    const rebuilt = buildSkillMd(parsed);
    const again = parseSkillMd(rebuilt);
    if ("error" in again) throw new Error(again.error);
    expect(again.name).toBe(parsed.name);
    expect(again.description).toBe(parsed.description);
    expect(again.frontmatter.compatibility).toBe("optional-extra");
    expect(again.body.trim()).toBe(parsed.body.trim());
  });

  it("round-trips keep-chomp and strip-chomp block scalars", () => {
    const doc = `---
name: Chomp
description: Round-trip chomp
notes: |+
  Keep trailing newlines.


strip: |-
  No trailing newline
clip: |
  One trailing newline
---

# Body
`;
    const parsed = parseSkillMd(doc);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.frontmatter.notes).toBe("Keep trailing newlines.\n\n\n");
    expect(parsed.frontmatter.strip).toBe("No trailing newline");
    expect(parsed.frontmatter.clip).toBe("One trailing newline\n");
    const rebuilt = buildSkillMd(parsed);
    const again = parseSkillMd(rebuilt);
    if ("error" in again) throw new Error(again.error);
    expect(again.frontmatter.notes).toBe(parsed.frontmatter.notes);
    expect(again.frontmatter.strip).toBe(parsed.frontmatter.strip);
    expect(again.frontmatter.clip).toBe(parsed.frontmatter.clip);
  });

  it("rejects overlong structured names", () => {
    expect(() => buildSkillMd({ name: "N".repeat(81), description: "ok", body: "body" })).toThrow(
      /at most 80 characters/,
    );
  });

  it.each([2, 3])(
    "round-trips multiline keep-chomp values with %i trailing newlines",
    (trailing) => {
      const notes = `First step\n\n  Nested step\nLast step${"\n".repeat(trailing)}`;
      const parsed = parseSkillMd(`---
name: Release notes
description: Prepare release notes
notes: |+
  First step

    Nested step
  Last step${"\n".repeat(trailing)}---

Write the notes.
`);
      if ("error" in parsed) throw new Error(parsed.error);
      expect(parsed.frontmatter.notes).toBe(notes);

      const again = parseSkillMd(buildSkillMd(parsed));
      if ("error" in again) throw new Error(again.error);
      expect(again.frontmatter.notes).toBe(notes);
    },
  );
});

describe("skill prompt helpers", () => {
  it("extracts forced /Name and Use skill: Name", () => {
    expect(extractForcedSkillName("/Daily standup\nplease")).toEqual({
      name: "Daily standup",
      rest: "please",
    });
    expect(extractForcedSkillName("Use skill: Weekly review")).toEqual({
      name: "Weekly review",
      rest: "",
    });
    expect(extractForcedSkillName("/Settings: General")).toBeNull();
  });

  it("extracts @skill mentions from routine prompts", () => {
    expect(extractRoutineSkillMentions("Run @Daily standup, then post to Slack")).toEqual([
      "Daily standup",
    ]);
    expect(extractRoutineSkillMentions("ping @everyone then @Weekly review")).toEqual([
      "Weekly review",
    ]);
  });

  it.each([
    ["@garden tools", ["garden tools"]],
    ["@garden", ["garden"]],
    ["@garden then @garden tools", ["garden tools", "garden"]],
    ["@garden tools then @garden", ["garden tools", "garden"]],
    ["(@GARDEN TOOLS), @garden tools. @GARDEN", ["garden tools", "garden"]],
    ["Email@garden tools and @gardener", []],
  ])("matches the longest catalog name at each mention in %j", (prompt, expected) => {
    expect(extractRoutineSkillMentions(prompt, ["garden", "garden tools"])).toEqual(expected);
  });

  it("escapes catalog names and ignores blank names", () => {
    expect(extractRoutineSkillMentions("@garden.tools", ["garden", "garden.tools"])).toEqual([
      "garden.tools",
    ]);
    expect(extractRoutineSkillMentions("@gardenXtools", ["garden.tools"])).toEqual([]);
    expect(extractRoutineSkillMentions("@garden", [" ", ""])).toEqual([]);
  });

  it.each(["，", "。", "、", "；", "：", "！", "？", "）", "】", "」", "』", "》"])(
    "loads a Chinese skill before %s without leaving its mention behind",
    (punctuation) => {
      const prompt = `@日报${punctuation}发送结果`;
      const skills = [
        {
          name: "日报",
          description: "Daily report",
          source: "user" as const,
          readOnly: false,
          content: "Report instructions.",
        },
      ];
      expect(extractRoutineSkillMentions(prompt, ["日", "日报"])).toEqual(["日报"]);
      const expanded = expandSkillReferencesInPrompt(prompt, skills);
      expect(expanded).toBe(`Use skill: 日报\n\nReport instructions.\n\n${punctuation}发送结果`);
      expect(expandSkillReferencesInPrompt(expanded, skills)).toBe(expanded);
      expect(renameRoutineSkillMentions(prompt, new Map([["日报", "日报 2"]]))).toBe(
        `@日报 2${punctuation}发送结果`,
      );
    },
  );

  it.each(["，", "。", "、", "；", "：", "！", "？", "（", "【", "「", "『", "《"])(
    "recognizes and renames a skill after %s",
    (punctuation) => {
      const prompt = `执行${punctuation}@日报。`;
      expect(extractRoutineSkillMentions(prompt, ["日报"])).toEqual(["日报"]);
      expect(renameRoutineSkillMentions(prompt, new Map([["日报", "日报 2"]]))).toBe(
        `执行${punctuation}@日报 2。`,
      );
      expect(extractRoutineSkillMentions(`Run${punctuation}@Report。`)).toEqual(["Report"]);
    },
  );

  it("keeps adjacent CJK mentions distinct and does not match inside words or email addresses", () => {
    expect(extractRoutineSkillMentions("@日报，@周报。", ["日报", "周报"])).toEqual([
      "日报",
      "周报",
    ]);
    for (const prompt of ["邮箱@日报。", "Email@日报。", "@日报扩展。", "@日报_扩展。"]) {
      expect(extractRoutineSkillMentions(prompt, ["日报"])).toEqual([]);
      expect(renameRoutineSkillMentions(prompt, new Map([["日报", "日报 2"]]))).toBe(prompt);
    }
  });

  it("keeps the catalog name when regex case matching differs from lowercasing", () => {
    expect(extractRoutineSkillMentions("@ς", ["Σ"])).toEqual(["Σ"]);
    expect(extractRoutineSkillMentions("@ς tools", ["Σ", "Σ tools"])).toEqual(["Σ tools"]);
    expect(extractRoutineSkillMentions("@ς @σ", ["Σ"])).toEqual(["Σ"]);
    expect(extractRoutineSkillMentions("@µ", ["μ"])).toEqual(["μ"]);
    expect(
      expandSkillReferencesInPrompt("@ς", [
        {
          name: "Σ",
          description: "Greek skill",
          source: "user",
          readOnly: false,
          content: "Greek instructions.",
        },
      ]),
    ).toBe("Use skill: Σ\n\nGreek instructions.");
  });

  it.each([
    ["Run @garden tools", false],
    ["Run @garden then @garden tools", true],
    ["Run @garden tools then @garden", true],
  ])("expands only the skills explicitly mentioned in %j", (prompt, includesShortSkill) => {
    const skills = ["garden", "garden tools"].map((name) => ({
      name,
      description: name,
      source: "user" as const,
      readOnly: false,
      content: `Instructions for ${name}.`,
    }));
    const expanded = expandSkillReferencesInPrompt(prompt, skills);
    expect(expanded.split("Instructions for garden tools.")).toHaveLength(2);
    expect(expanded.includes("Instructions for garden.")).toBe(includesShortSkill);
    expect(expanded.endsWith(includesShortSkill ? "Run then" : "Run")).toBe(true);
    expect(expanded).not.toContain("@");
    expect(expandSkillReferencesInPrompt(expanded, skills)).toBe(expanded);
  });

  it("expands forced and mentioned skills into the prompt", () => {
    const skills = [
      {
        name: "Daily standup",
        description: "standup",
        source: "user" as const,
        readOnly: false,
        content: SAMPLE,
      },
    ];
    const forced = expandSkillReferencesInPrompt("/Daily standup\nfocus on blockers", skills);
    expect(forced).toContain("Use skill: Daily standup");
    expect(forced).toContain(SAMPLE.trim());
    expect(forced).toContain("focus on blockers");

    const mentioned = expandSkillReferencesInPrompt("Run @Daily standup then email me", skills);
    expect(mentioned).toContain("Use skill: Daily standup");
    expect(mentioned).toContain("then email me");
    expect(mentioned).not.toMatch(/@Daily standup/i);

    // Fire-time expand then run-time expand must not duplicate the body.
    const again = expandSkillReferencesInPrompt(mentioned, skills);
    expect(again).toBe(mentioned);
    expect(again.split(SAMPLE.trim()).length - 1).toBe(1);

    const twice = expandSkillReferencesInPrompt(
      "Run @Daily standup then repeat @Daily standup",
      skills,
    );
    expect(twice).not.toMatch(/@Daily standup/i);
    expect(twice.split(SAMPLE.trim()).length - 1).toBe(1);
    expect(expandSkillReferencesInPrompt(twice, skills)).toBe(twice);
  });

  it("builds catalog instructions for auto-use", () => {
    const line = formatSkillsCatalogInstruction([
      {
        name: "Daily standup",
        description: "Prepare standup notes",
        source: "user",
        readOnly: false,
      },
    ]);
    expect(line).toContain("- Daily standup: Prepare standup notes");
    expect(line).toContain("skill_read");
    expect(line).toContain("Prefer matching skills");
  });
});

describe("SKILL.md quoted frontmatter values", () => {
  const resave = (md: string): string => {
    const parsed = parseSkillMd(md);
    if ("error" in parsed) throw new Error(parsed.error);
    return buildSkillMd(parsed);
  };

  it.each([
    'Use when the user says "ship it", then deploy.',
    "Paths like C:\\Users, #win",
    "Tabs\tand, commas",
    '"quoted" start',
  ])("keeps %j unchanged across saves", (description) => {
    let md = buildSkillMd({ name: "s", description, body: "b" });
    for (let i = 0; i < 3; i += 1) md = resave(md);
    const parsed = parseSkillMd(md);
    expect("error" in parsed ? parsed.error : parsed.description).toBe(description);
  });

  it("keeps string frontmatter that looks like a number or boolean a string", () => {
    const md = resave('---\nname: s\ndescription: d\nversion: "1.10"\nbeta: "true"\n---\nb\n');
    const parsed = parseSkillMd(md);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.frontmatter.version).toBe("1.10");
    expect(parsed.frontmatter.beta).toBe("true");
  });

  it("parses a doubled single quote as one quote", () => {
    const parsed = parseSkillMd("---\nname: s\ndescription: 'it''s here'\n---\nb\n");
    expect("error" in parsed ? parsed.error : parsed.description).toBe("it's here");
  });

  it("keeps a hand-written double-quoted value when the escape is not JSON", () => {
    const parsed = parseSkillMd('---\nname: s\ndescription: "C:\\path"\n---\nb\n');
    expect("error" in parsed ? parsed.error : parsed.description).toBe("C:\\path");
  });

  it("leaves plain descriptions unquoted", () => {
    for (const description of ["Deploy the app", "don't panic"]) {
      const md = buildSkillMd({ name: "s", description, body: "b" });
      expect(md).toContain(`description: ${description}\n`);
    }
  });
});

describe("renameRoutineSkillMentions", () => {
  it("renames only changed names and lets a longer name win over a renamed prefix", () => {
    const renames = new Map([
      ["garden", "garden-2"],
      ["garden tools", "garden tools"],
    ]);
    expect(
      renameRoutineSkillMentions("Use @garden tools, then @Garden. Email@garden stays.", renames),
    ).toBe("Use @garden tools, then @garden-2. Email@garden stays.");
  });
});
