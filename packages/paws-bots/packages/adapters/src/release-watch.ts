/** Provider-neutral helpers for the release-watch routine eval; offline pieces run in normal CI. */

export const RELEASE_WATCH_EVAL_MODEL_LABEL = "GPT 5.6 Luna";

/** Override with `RELEASE_WATCH_EVAL_MODEL` (or the host's usual default-model env). */
export const RELEASE_WATCH_EVAL_DEFAULT_MODEL_ID = "openai/gpt-5.6-luna";

/** Composio-style GitHub tools the emulator exposes for release watching. */
export const RELEASE_WATCH_GITHUB_TOOL_NAMES = [
  "GITHUB_LIST_RELEASES",
  "GITHUB_GET_RELEASE",
] as const;

export type ReleaseWatchGithubToolName = (typeof RELEASE_WATCH_GITHUB_TOOL_NAMES)[number];

export type ReleaseWatchDiagnosis =
  | "ok"
  | "vague_routine_prompt"
  | "missing_github_tools"
  | "browser_used_instead_of_integrations"
  | "no_release_info_retrieved";

export type EmulatedGithubRelease = {
  owner: string;
  repo: string;
  tag: string;
  name: string;
  body: string;
  publishedAt: string;
  htmlUrl: string;
};

/** Seeded rakazo releases so evals succeed without the public internet. */
export const DEFAULT_RAKAZO_EMULATED_RELEASES: readonly EmulatedGithubRelease[] = [
  {
    owner: "elie222",
    repo: "rakazo",
    tag: "v0.4.2",
    name: "v0.4.2 — routine tools + connector emulators",
    body: "Routines can bind connector tools. Composio emulator covers GitHub releases offline.",
    publishedAt: "2026-08-28T12:00:00.000Z",
    htmlUrl: "https://github.com/elie222/rakazo/releases/tag/v0.4.2",
  },
  {
    owner: "elie222",
    repo: "rakazo",
    tag: "v0.4.1",
    name: "v0.4.1 — computer + plugin guidance",
    body: "Prefer connected plugins over browsing when reading app data.",
    publishedAt: "2026-08-20T12:00:00.000Z",
    htmlUrl: "https://github.com/elie222/rakazo/releases/tag/v0.4.1",
  },
];

const COMPUTER_OR_BROWSER_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "open_path",
  "launch_app",
]);

export function resolveReleaseWatchEvalModelId(env: NodeJS.ProcessEnv = process.env): {
  label: string;
  modelId: string;
} {
  const modelId =
    env.RELEASE_WATCH_EVAL_MODEL?.trim() ||
    env.PI_DEFAULT_MODEL?.trim() ||
    RELEASE_WATCH_EVAL_DEFAULT_MODEL_ID;
  return { label: RELEASE_WATCH_EVAL_MODEL_LABEL, modelId };
}

/** Heuristic: a useful release-watch routine names the repo, releases, and GitHub tools. */
export function assessReleaseWatchRoutinePrompt(prompt: string): {
  ok: boolean;
  diagnosis: ReleaseWatchDiagnosis;
  details: string;
} {
  const text = prompt.trim();
  if (text.length < 48) {
    return {
      ok: false,
      diagnosis: "vague_routine_prompt",
      details: "Routine prompt is too short to encode concrete steps.",
    };
  }

  const mentionsRepo = /rakazo|elie222/i.test(text);
  const mentionsReleases = /release/i.test(text);
  const mentionsGithubTool =
    /GITHUB_LIST_RELEASES|GITHUB_GET_RELEASE|list(?:\s+\w+){0,4}\s+releases|github\s+(tool|integration|plugin|connector|api)/i.test(
      text,
    );
  const steersToBrowser =
    /\b(bing|google search|search the web|open (a |the )?browser|computer_act|computer_observe)\b/i.test(
      text,
    ) && !mentionsGithubTool;

  if (steersToBrowser) {
    return {
      ok: false,
      diagnosis: "browser_used_instead_of_integrations",
      details: "Routine prompt steers toward browser/search instead of GitHub tools.",
    };
  }

  if (!mentionsRepo || !mentionsReleases || !mentionsGithubTool) {
    const missing = [
      !mentionsRepo ? "repo (elie222/rakazo)" : null,
      !mentionsReleases ? "releases" : null,
      !mentionsGithubTool ? "GitHub/releases tool steps" : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      ok: false,
      diagnosis: "vague_routine_prompt",
      details: `Routine prompt is missing: ${missing}.`,
    };
  }

  return { ok: true, diagnosis: "ok", details: "Routine prompt encodes concrete GitHub steps." };
}

/** True when a GitHub tool payload is successful, non-empty, and includes a seeded tag. */
export function githubToolResultHasSeededRelease(
  result: unknown,
  seededReleaseTags: readonly string[],
): boolean {
  if (!result || typeof result !== "object") return false;
  const row = result as Record<string, unknown>;
  if (row.ok !== true) return false;
  const releases = Array.isArray(row.releases)
    ? row.releases
    : "release" in row
      ? [row.release]
      : [];
  if (releases.length === 0) return false;
  const seeded = new Set(seededReleaseTags.map((tag) => tag.toLowerCase()));
  return releases.some((release) => {
    if (!release || typeof release !== "object") return false;
    const tag = (release as Record<string, unknown>).tag;
    return typeof tag === "string" && seeded.has(tag.toLowerCase());
  });
}

export function diagnoseReleaseWatchRun(input: {
  availableToolNames: readonly string[];
  calledToolNames: readonly string[];
  routinePrompt: string;
  resultText: string;
  seededReleaseTags: readonly string[];
  /** Successful GitHub tool payloads from the run (failed/empty calls do not count). */
  githubToolResults?: readonly unknown[];
}): { pass: boolean; diagnoses: ReleaseWatchDiagnosis[]; summary: string } {
  const diagnoses: ReleaseWatchDiagnosis[] = [];
  const prompt = assessReleaseWatchRoutinePrompt(input.routinePrompt);
  if (!prompt.ok) diagnoses.push(prompt.diagnosis);

  const hasGithubTools = RELEASE_WATCH_GITHUB_TOOL_NAMES.some((name) =>
    input.availableToolNames.includes(name),
  );
  if (!hasGithubTools) diagnoses.push("missing_github_tools");

  const calledGithub = input.calledToolNames.some((name) =>
    (RELEASE_WATCH_GITHUB_TOOL_NAMES as readonly string[]).includes(name),
  );
  const calledComputer = input.calledToolNames.some((name) => COMPUTER_OR_BROWSER_TOOLS.has(name));
  if (calledComputer && !calledGithub) {
    diagnoses.push("browser_used_instead_of_integrations");
  }

  // Calling a GitHub tool is not enough: empty or ok:false results must still fail.
  // When githubToolResults is provided, only a successful non-empty seeded payload counts
  // (avoids hallucinated tags after a failed/empty call). Otherwise seeded tags in resultText count.
  const blob = input.resultText.toLowerCase();
  const sawInText = input.seededReleaseTags.some((tag) => blob.includes(tag.toLowerCase()));
  const sawInPayload = (input.githubToolResults ?? []).some((result) =>
    githubToolResultHasSeededRelease(result, input.seededReleaseTags),
  );
  const sawRelease =
    input.githubToolResults !== undefined ? sawInPayload : sawInText || sawInPayload;
  if (!sawRelease) diagnoses.push("no_release_info_retrieved");

  const unique = [...new Set(diagnoses)];
  if (unique.length === 0) {
    return {
      pass: true,
      diagnoses: ["ok"],
      summary: "Release watch used GitHub tools successfully.",
    };
  }

  return {
    pass: false,
    diagnoses: unique,
    summary: unique
      .map((diagnosis) => {
        switch (diagnosis) {
          case "vague_routine_prompt":
            return `vague_routine_prompt: ${prompt.details}`;
          case "missing_github_tools":
            return "missing_github_tools: GITHUB_LIST_RELEASES / GITHUB_GET_RELEASE were not available to the run.";
          case "browser_used_instead_of_integrations":
            return "browser_used_instead_of_integrations: computer/browser tools were used without GitHub release tools.";
          case "no_release_info_retrieved":
            return "no_release_info_retrieved: run never obtained seeded release/capability info.";
          default:
            return diagnosis;
        }
      })
      .join("\n"),
  };
}
