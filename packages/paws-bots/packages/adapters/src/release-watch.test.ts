import { describe, expect, it } from "vitest";
import {
  assessReleaseWatchRoutinePrompt,
  diagnoseReleaseWatchRun,
  githubToolResultHasSeededRelease,
  RELEASE_WATCH_EVAL_DEFAULT_MODEL_ID,
  RELEASE_WATCH_EVAL_MODEL_LABEL,
  RELEASE_WATCH_GITHUB_TOOL_NAMES,
  resolveReleaseWatchEvalModelId,
} from "./release-watch.js";

describe("release-watch diagnosis", () => {
  it("maps GPT 5.6 Luna to the in-repo OpenRouter/Pi model id without inventing a lock", () => {
    expect(RELEASE_WATCH_EVAL_MODEL_LABEL).toBe("GPT 5.6 Luna");
    expect(RELEASE_WATCH_EVAL_DEFAULT_MODEL_ID).toBe("openai/gpt-5.6-luna");
    expect(resolveReleaseWatchEvalModelId({}).modelId).toBe("openai/gpt-5.6-luna");
    expect(
      resolveReleaseWatchEvalModelId({ RELEASE_WATCH_EVAL_MODEL: " provider/custom-luna " })
        .modelId,
    ).toBe("provider/custom-luna");
  });

  it("flags vague routine prompts and accepts concrete GitHub tool steps", () => {
    expect(assessReleaseWatchRoutinePrompt("check updates").diagnosis).toBe("vague_routine_prompt");
    expect(
      assessReleaseWatchRoutinePrompt(
        "Open Bing and search for rakazo releases on the computer browser.",
      ).diagnosis,
    ).toBe("browser_used_instead_of_integrations");

    const good = assessReleaseWatchRoutinePrompt(
      [
        "Daily: use GITHUB_LIST_RELEASES for owner elie222 repo rakazo.",
        "Summarize new release tags and capability notes from release bodies.",
        "Prefer the GitHub plugin tools; do not browse or Bing-search.",
      ].join(" "),
    );
    expect(good).toMatchObject({ ok: true, diagnosis: "ok" });
  });

  it("diagnoses missing tools, browser fallback, and missing release info distinctly", () => {
    const missingTools = diagnoseReleaseWatchRun({
      availableToolNames: ["computer_observe", "computer_act"],
      calledToolNames: ["computer_act"],
      routinePrompt: "Stay current on rakazo somehow.",
      resultText: "I searched Bing and hit an error.",
      seededReleaseTags: ["v0.4.2"],
    });
    expect(missingTools.pass).toBe(false);
    expect(missingTools.diagnoses).toEqual(
      expect.arrayContaining([
        "vague_routine_prompt",
        "missing_github_tools",
        "browser_used_instead_of_integrations",
        "no_release_info_retrieved",
      ]),
    );
    expect(missingTools.summary).toMatch(/vague_routine_prompt/);
    expect(missingTools.summary).toMatch(/missing_github_tools/);
    expect(missingTools.summary).toMatch(/browser_used_instead_of_integrations/);

    const emptyGithubCall = diagnoseReleaseWatchRun({
      availableToolNames: [...RELEASE_WATCH_GITHUB_TOOL_NAMES],
      calledToolNames: ["GITHUB_LIST_RELEASES"],
      routinePrompt:
        "Call GITHUB_LIST_RELEASES for elie222/rakazo and summarize new releases and capabilities.",
      resultText: "GitHub returned no releases.",
      seededReleaseTags: ["v0.4.2"],
    });
    expect(emptyGithubCall.pass).toBe(false);
    expect(emptyGithubCall.diagnoses).toContain("no_release_info_retrieved");

    const pass = diagnoseReleaseWatchRun({
      availableToolNames: [...RELEASE_WATCH_GITHUB_TOOL_NAMES],
      calledToolNames: ["GITHUB_LIST_RELEASES"],
      routinePrompt:
        "Call GITHUB_LIST_RELEASES for elie222/rakazo and summarize new releases and capabilities.",
      resultText: "Latest is v0.4.2 with routine tools + connector emulators.",
      seededReleaseTags: ["v0.4.2"],
    });
    expect(pass).toEqual({
      pass: true,
      diagnoses: ["ok"],
      summary: "Release watch used GitHub tools successfully.",
    });

    const failedPayload = diagnoseReleaseWatchRun({
      availableToolNames: [...RELEASE_WATCH_GITHUB_TOOL_NAMES],
      calledToolNames: ["GITHUB_LIST_RELEASES"],
      routinePrompt:
        "Call GITHUB_LIST_RELEASES for elie222/rakazo and summarize new releases and capabilities.",
      resultText: "Tool finished without useful output.",
      seededReleaseTags: ["v0.4.2"],
      githubToolResults: [{ ok: false, tool: "GITHUB_LIST_RELEASES", error: "upstream failed" }],
    });
    expect(failedPayload.pass).toBe(false);
    expect(failedPayload.diagnoses).toContain("no_release_info_retrieved");

    const emptyPayload = diagnoseReleaseWatchRun({
      availableToolNames: [...RELEASE_WATCH_GITHUB_TOOL_NAMES],
      calledToolNames: ["GITHUB_LIST_RELEASES"],
      routinePrompt:
        "Call GITHUB_LIST_RELEASES for elie222/rakazo and summarize new releases and capabilities.",
      resultText: "Tool finished without useful output.",
      seededReleaseTags: ["v0.4.2"],
      githubToolResults: [{ ok: true, tool: "GITHUB_LIST_RELEASES", releases: [] }],
    });
    expect(emptyPayload.pass).toBe(false);
    expect(emptyPayload.diagnoses).toContain("no_release_info_retrieved");
    expect(
      githubToolResultHasSeededRelease(
        { ok: true, releases: [{ tag: "v0.4.2", name: "v0.4.2" }] },
        ["v0.4.2"],
      ),
    ).toBe(true);
    expect(githubToolResultHasSeededRelease({ releases: [{ tag: "v0.4.2" }] }, ["v0.4.2"])).toBe(
      false,
    );
    expect(
      githubToolResultHasSeededRelease({ ok: false, error: "v0.4.2 unavailable" }, ["v0.4.2"]),
    ).toBe(false);
    expect(
      githubToolResultHasSeededRelease(
        { ok: true, note: "mentions v0.4.2", releases: [{ tag: "v9.9.9" }] },
        ["v0.4.2"],
      ),
    ).toBe(false);

    const tagOnlyAfterFailedPayload = diagnoseReleaseWatchRun({
      availableToolNames: [...RELEASE_WATCH_GITHUB_TOOL_NAMES],
      calledToolNames: ["GITHUB_LIST_RELEASES"],
      routinePrompt:
        "Call GITHUB_LIST_RELEASES for elie222/rakazo and summarize new releases and capabilities.",
      resultText: "Latest is v0.4.2 with routine tools + connector emulators.",
      seededReleaseTags: ["v0.4.2"],
      githubToolResults: [{ ok: false, tool: "GITHUB_LIST_RELEASES", error: "upstream failed" }],
    });
    expect(tagOnlyAfterFailedPayload.pass).toBe(false);
    expect(tagOnlyAfterFailedPayload.diagnoses).toContain("no_release_info_retrieved");

    const passViaPayload = diagnoseReleaseWatchRun({
      availableToolNames: [...RELEASE_WATCH_GITHUB_TOOL_NAMES],
      calledToolNames: ["GITHUB_LIST_RELEASES"],
      routinePrompt:
        "Call GITHUB_LIST_RELEASES for elie222/rakazo and summarize new releases and capabilities.",
      resultText: "Checked GitHub releases.",
      seededReleaseTags: ["v0.4.2"],
      githubToolResults: [
        {
          ok: true,
          tool: "GITHUB_LIST_RELEASES",
          releases: [{ tag: "v0.4.2", name: "v0.4.2 — routine tools" }],
        },
      ],
    });
    expect(passViaPayload).toEqual({
      pass: true,
      diagnoses: ["ok"],
      summary: "Release watch used GitHub tools successfully.",
    });
  });
});
