import { parse } from "dotenv";
import { describe, expect, it } from "vitest";

import {
  chooseUpdateStrategy,
  commitImageTag,
  compareReleaseTags,
  composePsArgv,
  composePullArgv,
  composeUpArgv,
  composeUpdatePlan,
  DEFAULT_COMPOSE_PROJECT_NAME,
  DEFAULT_IMAGE_TAG,
  forkImageTag,
  gitIndexContentDiffArgv,
  gitStatusArgv,
  gitUntrackedFilesArgv,
  gitWorktreeContentDiffArgv,
  imageRef,
  isValidComposeProjectName,
  isValidImageName,
  isValidImageTag,
  OFFICIAL_SERVER_IMAGE,
  parseGitNameOnly,
  parseLsRemoteReleases,
  parseLsRemoteTags,
  parseReleaseTag,
  RECREATED_SERVICES,
  resolveComposeProjectName,
  resolveExecutionMode,
  resolveTrackedDirtyPaths,
  rollbackTarget,
  selectLatestRelease,
  selectLatestReleaseTag,
  upsertEnvAssignments,
  validateUpdateRequest,
} from "./compose-update.js";

const target = {
  composeFiles: ["/srv/rakazo/infra/compose/docker-compose.prod.yml"],
  envFiles: ["/srv/rakazo/.env"],
};

describe("image references", () => {
  it("accepts the tags the publish workflow produces", () => {
    expect(isValidImageTag("latest")).toBe(true);
    expect(isValidImageTag("v1.2.3")).toBe(true);
    expect(isValidImageTag("sha-0123456")).toBe(true);
    expect(isValidImageTag("local-0123456789ab")).toBe(true);
  });

  it("rejects tags that could become a second argument or a shell fragment", () => {
    expect(isValidImageTag("")).toBe(false);
    expect(isValidImageTag("-rm")).toBe(false);
    expect(isValidImageTag(".hidden")).toBe(false);
    expect(isValidImageTag("v1 v2")).toBe(false);
    expect(isValidImageTag("v1;rm -rf /")).toBe(false);
    expect(isValidImageTag("v1\nv2")).toBe(false);
    expect(isValidImageTag("v1/../../etc")).toBe(false);
    expect(isValidImageTag(`v${"1".repeat(200)}`)).toBe(false);
  });

  it("accepts registry paths with a host and rejects anything else", () => {
    expect(isValidImageName(OFFICIAL_SERVER_IMAGE)).toBe(true);
    expect(isValidImageName("ghcr.io:5000/owner/app")).toBe(true);
    expect(isValidImageName("rakazo/app")).toBe(true);
    expect(isValidImageName("Ghcr.io/owner/app")).toBe(false);
    expect(isValidImageName("owner/app:tag")).toBe(false);
    expect(isValidImageName("owner/../app")).toBe(false);
    expect(isValidImageName("")).toBe(false);
  });

  it("refuses to assemble a reference it could not validate", () => {
    expect(imageRef(OFFICIAL_SERVER_IMAGE, "v1.0.0")).toBe(`${OFFICIAL_SERVER_IMAGE}:v1.0.0`);
    expect(() => imageRef(OFFICIAL_SERVER_IMAGE, "-rm")).toThrow(/image tag/);
    expect(() => imageRef("BAD NAME", DEFAULT_IMAGE_TAG)).toThrow(/image name/);
  });

  it("derives local and per-commit tags from a resolved commit only", () => {
    expect(forkImageTag("0123456789abcdef0123456789abcdef01234567")).toBe(
      "local-0123456789abcdef0123456789abcdef01234567",
    );
    expect(commitImageTag("0123456789abcdef0123456789abcdef01234567")).toBe(
      "sha-0123456789abcdef0123456789abcdef01234567",
    );
    expect(() => forkImageTag("HEAD")).toThrow(/commit/);
    expect(() => commitImageTag("")).toThrow(/commit/);
  });
});

describe("release tag resolution", () => {
  it("parses semver release tags and rejects other tag shapes", () => {
    expect(parseReleaseTag("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseReleaseTag("v1.2.3-rc.1")).toMatchObject({ prerelease: "rc.1" });
    expect(parseReleaseTag("1.2.3")).toBeNull();
    expect(parseReleaseTag("v1.2")).toBeNull();
    expect(parseReleaseTag("latest")).toBeNull();
  });

  it("orders releases numerically rather than lexically", () => {
    const a = parseReleaseTag("v0.9.0");
    const b = parseReleaseTag("v0.10.0");
    expect(a && b && compareReleaseTags(a, b)).toBeLessThan(0);
    const rc = parseReleaseTag("v1.0.0-rc.1");
    const release = parseReleaseTag("v1.0.0");
    expect(rc && release && compareReleaseTags(rc, release)).toBeLessThan(0);
  });

  it("reads ls-remote output, collapsing peeled refs", () => {
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    const tagObject = "a".repeat(40);
    const stdout = [
      `${tagObject}\trefs/tags/v0.1.0`,
      `${first}\trefs/tags/v0.1.0^{}`,
      `${second}\trefs/tags/v0.2.0`,
      `${"b".repeat(40)}\trefs/heads/main`,
      `${"c".repeat(40)}\trefs/tags/`,
      "",
    ].join("\n");
    expect(parseLsRemoteTags(stdout)).toEqual(["v0.1.0", "v0.2.0"]);
    expect(parseLsRemoteReleases(stdout)).toEqual([
      { tag: "v0.1.0", commit: first },
      { tag: "v0.2.0", commit: second },
    ]);
    expect(selectLatestRelease(parseLsRemoteReleases(stdout))).toEqual({
      tag: "v0.2.0",
      commit: second,
    });
  });

  it("drops ls-remote tags that would not be usable as image tags", () => {
    expect(parseLsRemoteTags("aa\trefs/tags/-dangerous\nbb\trefs/tags/v1.0.0")).toEqual(["v1.0.0"]);
  });

  it("picks the newest stable release and never a pre-release", () => {
    expect(selectLatestReleaseTag(["v0.1.0", "v0.10.2", "v0.9.9"])).toBe("v0.10.2");
    expect(selectLatestReleaseTag(["v1.0.0", "v1.1.0-rc.3"])).toBe("v1.0.0");
    expect(selectLatestReleaseTag(["v2.0.0-rc.1"])).toBeNull();
    expect(selectLatestReleaseTag(["main", "latest"])).toBeNull();
    expect(selectLatestReleaseTag([])).toBeNull();
  });
});

describe("strategy and mode selection", () => {
  it("pulls for the official repository and builds for a fork", () => {
    expect(chooseUpdateStrategy({ official: true }).strategy).toBe("pull");
    expect(chooseUpdateStrategy({ official: false }).strategy).toBe("build");
    expect(chooseUpdateStrategy({ official: false }).reason).toMatch(/minutes/);
  });

  it("prefers the sidecar, falls back to a checkout, and reports when neither exists", () => {
    expect(resolveExecutionMode({ hasUpdater: true, hasCheckout: true })).toEqual({
      mode: "sidecar",
      reason: null,
    });
    expect(resolveExecutionMode({ hasUpdater: false, hasCheckout: true }).mode).toBe("checkout");
    const none = resolveExecutionMode({ hasUpdater: false, hasCheckout: false });
    expect(none.mode).toBe("unavailable");
    expect(none.reason).toMatch(/updater/);
  });

  it("reports unavailable when self-update is switched off, whatever else is present", () => {
    const off = resolveExecutionMode({ hasUpdater: true, disabled: true });
    expect(off.mode).toBe("unavailable");
    expect(off.reason).toMatch(/switched off/);
  });
});

describe("compose argv construction", () => {
  it("passes the compose file and env files as separate arguments", () => {
    expect(composePullArgv(target)).toEqual({
      command: "docker",
      args: [
        "compose",
        "-p",
        DEFAULT_COMPOSE_PROJECT_NAME,
        "--env-file",
        "/srv/rakazo/.env",
        "--file",
        ...target.composeFiles,
        "pull",
        "api",
        "worker",
        "web",
      ],
    });
  });

  it("passes one --file per Compose file, in overlay order", () => {
    const overlaid = {
      ...target,
      composeFiles: [
        "/srv/rakazo/infra/compose/docker-compose.prod.yml",
        "/srv/rakazo/ops/compose/docker-compose.sandbox.yml",
      ],
    };
    for (const invocation of [
      composePullArgv(overlaid),
      composeUpArgv(overlaid),
      composePsArgv(overlaid),
    ]) {
      const files = invocation.args.flatMap((arg, index) =>
        arg === "--file" ? [invocation.args[index + 1]] : [],
      );
      expect(files).toEqual(overlaid.composeFiles);
    }
  });

  it("refuses a target with no Compose file rather than running against the default stack", () => {
    expect(() => composePullArgv({ ...target, composeFiles: [] })).toThrow(/no Compose file/);
  });

  it("recreates and pulls the target's own services when an overlay adds one", () => {
    const withSupervisor = { ...target, services: ["api", "worker", "web", "supervisor"] };
    expect(composePullArgv(withSupervisor).args.slice(-4)).toEqual([
      "api",
      "worker",
      "web",
      "supervisor",
    ]);
    expect(composeUpArgv(withSupervisor).args.slice(-4)).toEqual([
      "api",
      "worker",
      "web",
      "supervisor",
    ]);
  });

  it("falls back to the built-in services when the target names none", () => {
    expect(composeUpArgv({ ...target, services: [] }).args.slice(-3)).toEqual([
      "api",
      "worker",
      "web",
    ]);
  });

  it("carries the overlay files and extra services into the update plan and its recovery", () => {
    const overlaid = {
      ...target,
      composeFiles: [
        "/srv/rakazo/infra/compose/docker-compose.prod.yml",
        "/srv/rakazo/ops/compose/docker-compose.sandbox.yml",
      ],
      services: ["api", "worker", "web", "supervisor"],
    };
    for (const strategy of ["pull", "build"] as const) {
      const steps = composeUpdatePlan({ strategy, target: overlaid });
      const composeSteps = steps.filter((step) => step.command === "docker");
      expect(composeSteps.length).toBeGreaterThan(0);
      for (const step of composeSteps) {
        expect(step.args.filter((arg) => arg === "--file")).toHaveLength(2);
        expect(step.args).toContain("supervisor");
      }
    }
  });

  it("passes the project name as its own -p argument so a custom stack is the one updated", () => {
    const named = { ...target, projectName: "operator-stack" };
    for (const invocation of [composePullArgv(named), composeUpArgv(named), composePsArgv(named)]) {
      const projectFlag = invocation.args.indexOf("-p");
      expect(projectFlag).toBeGreaterThanOrEqual(0);
      expect(invocation.args[projectFlag + 1]).toBe("operator-stack");
      expect(
        invocation.args.some((arg) => arg.includes("operator-stack") && arg !== "operator-stack"),
      ).toBe(false);
    }
  });

  it("defaults -p to the name pinned in the compose file", () => {
    expect(DEFAULT_COMPOSE_PROJECT_NAME).toBe("rakazo-prod");
    expect(composePsArgv(target).args.slice(0, 3)).toEqual(["compose", "-p", "rakazo-prod"]);
  });

  it("refuses a project name that could be parsed as another flag or a second argument", () => {
    expect(() => composeUpArgv({ ...target, projectName: "-f" })).toThrow(/project name/);
    expect(() => composePullArgv({ ...target, projectName: "two words" })).toThrow(/project name/);
  });

  it("recreates detached, and only builds when asked to", () => {
    expect(composeUpArgv(target).args).toContain("--detach");
    expect(composeUpArgv(target).args).toContain("--wait");
    expect(composeUpArgv(target).args).toContain("--wait-timeout");
    expect(composeUpArgv(target).args).toContain("never");
    expect(composeUpArgv(target).args).toContain("--no-build");
    expect(composeUpArgv(target).args).not.toContain("--build");
    expect(composeUpArgv(target, { build: true }).args).toContain("--build");
    expect(composeUpArgv(target, { build: true }).args).not.toContain("--no-build");
  });

  it("never recreates the updater, which is the process running the update", () => {
    expect(RECREATED_SERVICES).not.toContain("updater");
    for (const invocation of [composeUpArgv(target), composePullArgv(target)]) {
      expect(invocation.args).not.toContain("updater");
      expect(invocation.args).not.toContain("postgres");
    }
  });

  it("names the services explicitly so a bare up cannot sweep the whole project", () => {
    const args = composeUpArgv(target).args;
    expect(args.slice(-3)).toEqual(["api", "worker", "web"]);
  });
});

describe("compose project name resolution", () => {
  it("prefers the name Compose injects into running services", () => {
    expect(resolveComposeProjectName({ COMPOSE_PROJECT_NAME: "live-stack" })).toBe("live-stack");
    expect(
      resolveComposeProjectName({
        COMPOSE_PROJECT_NAME: "live-stack",
        RAKAZO_COMPOSE_PROJECT_NAME: "manual-stack",
      }),
    ).toBe("live-stack");
  });

  it("falls back to a dedicated override, then to the name pinned in the compose file", () => {
    expect(resolveComposeProjectName({ RAKAZO_COMPOSE_PROJECT_NAME: "manual-stack" })).toBe(
      "manual-stack",
    );
    expect(resolveComposeProjectName({})).toBe(DEFAULT_COMPOSE_PROJECT_NAME);
  });

  it("ignores blank values and refuses a name that is not a single argv", () => {
    expect(resolveComposeProjectName({ COMPOSE_PROJECT_NAME: "  " })).toBe(
      DEFAULT_COMPOSE_PROJECT_NAME,
    );
    expect(isValidComposeProjectName("-p")).toBe(false);
    expect(() => resolveComposeProjectName({ COMPOSE_PROJECT_NAME: "evil;rm" })).toThrow(
      /project name/,
    );
  });
});

describe("dirty-tree argv and CRLF filtering", () => {
  it("runs status with autocrlf as its own -c arguments, not interpolated into a shell string", () => {
    expect(gitStatusArgv()).toEqual([
      "--no-optional-locks",
      "-c",
      "core.autocrlf=true",
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]);
    expect(gitWorktreeContentDiffArgv()).toEqual([
      "--no-optional-locks",
      "-c",
      "core.autocrlf=true",
      "diff",
      "--name-only",
      "--ignore-cr-at-eol",
    ]);
    expect(gitIndexContentDiffArgv()).toEqual([
      "--no-optional-locks",
      "-c",
      "core.autocrlf=true",
      "diff",
      "--cached",
      "--name-only",
      "--ignore-cr-at-eol",
    ]);
    expect(gitUntrackedFilesArgv()).toEqual([
      "--no-optional-locks",
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
  });

  it("reads git name-only output as one path per line", () => {
    expect(parseGitNameOnly("apps/api/src/app.ts\npackages/core/src/x.ts\n")).toEqual([
      "apps/api/src/app.ts",
      "packages/core/src/x.ts",
    ]);
    expect(parseGitNameOnly("\n  \n")).toEqual([]);
  });

  it("treats porcelain-only paths as CRLF noise when the ignore-cr diff is empty", () => {
    expect(
      resolveTrackedDirtyPaths({
        porcelainChanged: ["apps/api/src/app.ts", "README.md"],
        contentChanged: [],
        contentDiffOk: true,
      }),
    ).toEqual({ dirty: false, dirtyPaths: [] });
  });

  it("keeps a real content change even when it sits among CRLF-only porcelain noise", () => {
    expect(
      resolveTrackedDirtyPaths({
        porcelainChanged: ["apps/api/src/app.ts", "README.md"],
        contentChanged: ["apps/api/src/app.ts"],
        contentDiffOk: true,
      }),
    ).toEqual({ dirty: true, dirtyPaths: ["apps/api/src/app.ts"] });
  });

  it("keeps a content diff that porcelain parsing missed, so the guard is not weakened", () => {
    expect(
      resolveTrackedDirtyPaths({
        porcelainChanged: [],
        contentChanged: ["packages/core/src/x.ts"],
        contentDiffOk: true,
      }),
    ).toEqual({ dirty: true, dirtyPaths: ["packages/core/src/x.ts"] });
  });

  it("falls back to porcelain when the ignore-cr diffs cannot be read", () => {
    expect(
      resolveTrackedDirtyPaths({
        porcelainChanged: ["apps/api/src/app.ts"],
        contentChanged: [],
        contentDiffOk: false,
      }),
    ).toEqual({ dirty: true, dirtyPaths: ["apps/api/src/app.ts"] });
  });

  it("keeps untracked source files because Docker COPY can include them in a build", () => {
    expect(
      resolveTrackedDirtyPaths({
        porcelainChanged: [],
        contentChanged: [],
        contentDiffOk: true,
        untrackedPaths: ["packages/core/src/untracked.ts"],
      }),
    ).toEqual({ dirty: true, dirtyPaths: ["packages/core/src/untracked.ts"] });
  });
});

describe("update plans", () => {
  it("pulls then recreates on the official path, with no migration step", () => {
    const steps = composeUpdatePlan({ strategy: "pull", target });
    expect(steps.map((step) => step.id)).toEqual(["pull", "recreate"]);
    expect(steps.some((step) => step.id === "migrate")).toBe(false);
    for (const step of steps) {
      expect(step.args.slice(0, 3)).toEqual(["compose", "-p", DEFAULT_COMPOSE_PROJECT_NAME]);
    }
  });

  it("fetches, fast-forwards, then builds on the fork path", () => {
    const steps = composeUpdatePlan({
      strategy: "build",
      target,
      repoUrl: "https://github.com/someone/rakazo",
      branch: "trunk",
      repointRemote: true,
    });
    expect(steps.map((step) => step.id)).toEqual([
      "remote",
      "fetch",
      "checkout",
      "merge",
      "recreate",
    ]);
    const merge = steps.find((step) => step.id === "merge");
    expect(merge?.args).toEqual(["merge", "--ff-only", "origin/trunk"]);
    expect(steps.find((step) => step.id === "fetch")?.args).not.toContain("--prune");
    expect(steps.at(-1)?.args).toContain("--build");
  });

  it("leaves the remote alone when the checkout already points at the chosen repository", () => {
    const steps = composeUpdatePlan({
      strategy: "build",
      target,
      branch: "main",
      repointRemote: false,
    });
    expect(steps.map((step) => step.id)).toEqual(["fetch", "checkout", "merge", "recreate"]);
  });

  it("keeps the repository URL in argv rather than in any compose input", () => {
    const repoUrl = "https://github.com/someone/rakazo";
    const steps = composeUpdatePlan({
      strategy: "build",
      target,
      repoUrl,
      branch: "main",
      repointRemote: true,
    });
    const remote = steps.find((step) => step.id === "remote");
    expect(remote?.args).toEqual(["remote", "set-url", "origin", repoUrl]);
    const recreate = steps.find((step) => step.id === "recreate");
    expect(recreate?.args.some((arg) => arg.includes(repoUrl))).toBe(false);
  });
});

describe("rollback", () => {
  it("targets the tag that was running before the last update", () => {
    expect(rollbackTarget({ currentTag: "v1.1.0", previousTag: "v1.0.0" })).toEqual({
      tag: "v1.0.0",
    });
  });

  it("refuses when there is nothing recorded, nothing usable, or nothing to change", () => {
    expect(rollbackTarget({ currentTag: "v1.1.0", previousTag: null })).toEqual({
      error: expect.stringMatching(/nothing to roll back/),
    });
    expect(rollbackTarget({ currentTag: "v1.1.0", previousTag: "-rm" })).toEqual({
      error: expect.stringMatching(/not a usable tag/),
    });
    expect(rollbackTarget({ currentTag: "v1.0.0", previousTag: "v1.0.0" })).toEqual({
      error: expect.stringMatching(/already running/),
    });
  });
});

describe("managed env assignments", () => {
  it("replaces a managed key in place and leaves everything else alone", () => {
    const contents = [
      "# deployment",
      "POSTGRES_PASSWORD=secret",
      "RAKAZO_IMAGE_TAG=v1.0.0",
      "",
    ].join("\n");
    expect(upsertEnvAssignments(contents, { RAKAZO_IMAGE_TAG: "v1.1.0" })).toBe(
      ["# deployment", "POSTGRES_PASSWORD=secret", "RAKAZO_IMAGE_TAG=v1.1.0", ""].join("\n"),
    );
  });

  it("appends keys that are not present yet", () => {
    const result = upsertEnvAssignments("POSTGRES_PASSWORD=secret\n", {
      RAKAZO_IMAGE_TAG: "v1.1.0",
      RAKAZO_IMAGE_TAG_PREVIOUS: "v1.0.0",
    });
    expect(result.split("\n")).toEqual([
      "POSTGRES_PASSWORD=secret",
      "",
      "RAKAZO_IMAGE_TAG=v1.1.0",
      "RAKAZO_IMAGE_TAG_PREVIOUS=v1.0.0",
      "",
    ]);
  });

  it("keeps the file's existing line endings", () => {
    const result = upsertEnvAssignments("A=1\r\nRAKAZO_IMAGE_TAG=v1.0.0\r\n", {
      RAKAZO_IMAGE_TAG: "v2.0.0",
    });
    expect(result).toBe("A=1\r\nRAKAZO_IMAGE_TAG=v2.0.0\r\n");
  });

  it("rewrites every duplicate managed assignment so the last value cannot win", () => {
    const result = upsertEnvAssignments(
      "RAKAZO_IMAGE_TAG=stale\nA=1\nRAKAZO_IMAGE_TAG=still-stale\n",
      { RAKAZO_IMAGE_TAG: "sha-0123456789abcdef0123456789abcdef01234567" },
    );
    expect(result.match(/RAKAZO_IMAGE_TAG=sha-/g)).toHaveLength(2);
    expect(result).not.toContain("stale");
  });

  it.each([
    " RAKAZO_IMAGE_TAG=v1.2.0",
    "\tRAKAZO_IMAGE_TAG=v1.2.0",
    "RAKAZO_IMAGE_TAG = v1.2.0",
    "RAKAZO_IMAGE_TAG\t=\tv1.2.0",
    "\u00a0RAKAZO_IMAGE_TAG\u00a0=\u00a0v1.2.0",
    " export RAKAZO_IMAGE_TAG = 'v1.2.0' # pinned",
    'RAKAZO_IMAGE_TAG: "v1.2.0"',
  ])("rewrites a later Compose assignment: %s", (duplicate) => {
    const contents = `RAKAZO_IMAGE_TAG=v1.1.0\n${duplicate}\n`;
    expect(parse(contents).RAKAZO_IMAGE_TAG).toBe("v1.2.0");
    const result = upsertEnvAssignments(contents, {
      RAKAZO_IMAGE_TAG: "v2.0.0",
    });

    expect(result).toBe("RAKAZO_IMAGE_TAG=v2.0.0\nRAKAZO_IMAGE_TAG=v2.0.0\n");
    expect(parse(result).RAKAZO_IMAGE_TAG).toBe("v2.0.0");
  });

  it("rewrites mixed current and rollback duplicates while preserving unrelated CRLF content", () => {
    const unrelated = [
      "# RAKAZO_IMAGE_TAG = commented",
      "  # RAKAZO_IMAGE_TAG=also-commented",
      "RAKAZO_IMAGE_TAG_EXTRA=untouched",
      "OTHER = 'keep # this' # comment",
      "",
    ];
    const contents = [
      "RAKAZO_IMAGE_TAG=v1.0.0",
      "RAKAZO_IMAGE_TAG_PREVIOUS=v0.9.0",
      ...unrelated,
      " \tRAKAZO_IMAGE_TAG \t= v1.2.0 # pinned",
      "\tRAKAZO_IMAGE_TAG_PREVIOUS = 'v1.1.0' # rollback",
    ].join("\r\n");
    const assignments = { RAKAZO_IMAGE_TAG: "v2.0.0", RAKAZO_IMAGE_TAG_PREVIOUS: "v1.2.0" };
    const result = upsertEnvAssignments(contents, assignments);

    expect(result).toBe(
      [
        "RAKAZO_IMAGE_TAG=v2.0.0",
        "RAKAZO_IMAGE_TAG_PREVIOUS=v1.2.0",
        ...unrelated,
        "RAKAZO_IMAGE_TAG=v2.0.0",
        "RAKAZO_IMAGE_TAG_PREVIOUS=v1.2.0",
        "",
      ].join("\r\n"),
    );
    expect(parse(result)).toMatchObject(assignments);
  });

  it.each(
    ["'", '"', "`"].flatMap((quote) => ["", "\uFEFF", "\u00a0"].map((prefix) => [quote, prefix])),
  )(
    "preserves assignment-like text inside an unrelated %s quoted value with prefix %j",
    (quote, prefix) => {
      const unrelated = `${prefix}notes.value: ${quote}first\\\nRAKAZO_IMAGE_TAG=v0.9.0\n RAKAZO_IMAGE_TAG = v1.0.0\nlast${quote} # keep`;
      const result = upsertEnvAssignments(`${unrelated}\nRAKAZO_IMAGE_TAG=v1.2.0\n`, {
        RAKAZO_IMAGE_TAG: "v2.0.0",
      });

      expect(result).toBe(`${unrelated}\nRAKAZO_IMAGE_TAG=v2.0.0\n`);
      expect(parse(result)["notes.value"]).toBe(parse(unrelated)["notes.value"]);
    },
  );

  it("preserves a leading BOM when rewriting managed duplicates", () => {
    const result = upsertEnvAssignments(
      "\uFEFFRAKAZO_IMAGE_TAG=v1.1.0\nRAKAZO_IMAGE_TAG = v1.2.0\n",
      {
        RAKAZO_IMAGE_TAG: "v2.0.0",
      },
    );
    expect(result).toBe("\uFEFFRAKAZO_IMAGE_TAG=v2.0.0\nRAKAZO_IMAGE_TAG=v2.0.0\n");
    expect(parse(result).RAKAZO_IMAGE_TAG).toBe("v2.0.0");
  });

  it("refuses values that would inject a second assignment or a compose expression", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is the hostile input under test
    for (const value of ["v1\nEVIL=1", "v1 v2", "$(id)", "v1;rm -rf /", "${OTHER}"]) {
      expect(() => upsertEnvAssignments("", { RAKAZO_IMAGE_TAG: value })).toThrow(/Refusing/);
    }
  });

  it("refuses keys outside the managed shape", () => {
    expect(() => upsertEnvAssignments("", { "a b": "1" })).toThrow(/Refusing/);
  });
});

describe("sidecar boundary validation", () => {
  it("normalizes a request the API already validated", () => {
    expect(
      validateUpdateRequest({ repoUrl: "https://github.com/elie222/rakazo.git", branch: " main " }),
    ).toEqual({
      request: {
        repoUrl: "https://github.com/elie222/rakazo.git",
        branch: "main",
        official: true,
      },
    });
  });

  it("marks a fork as unofficial so the sidecar picks the build path", () => {
    const result = validateUpdateRequest({
      repoUrl: "https://github.com/someone/rakazo",
      branch: "main",
    });
    expect(result).toEqual({
      request: {
        repoUrl: "https://github.com/someone/rakazo",
        branch: "main",
        official: false,
      },
    });
  });

  it("re-rejects everything the API would have rejected", () => {
    const cases: Array<{ repoUrl?: unknown; branch?: unknown }> = [
      { repoUrl: "http://github.com/a/b", branch: "main" },
      { repoUrl: "file:///etc/passwd", branch: "main" },
      { repoUrl: "https://user:pw@github.com/a/b", branch: "main" },
      { repoUrl: "https://github.com/a/b?x=1", branch: "main" },
      { repoUrl: "https://github.com/../etc", branch: "main" },
      { repoUrl: "--upload-pack=id", branch: "main" },
      { repoUrl: "https://github.com/a/b\nrm", branch: "main" },
      { repoUrl: "https://github.com/a/b", branch: "--exec=id" },
      { repoUrl: "https://github.com/a/b", branch: "main..evil" },
      { repoUrl: "https://github.com/a/b", branch: "main\tid" },
      { repoUrl: 42, branch: "main" },
      { repoUrl: "https://github.com/a/b", branch: null },
    ];
    for (const input of cases) {
      const result = validateUpdateRequest(input);
      expect("error" in result, JSON.stringify(input)).toBe(true);
    }
  });
});
