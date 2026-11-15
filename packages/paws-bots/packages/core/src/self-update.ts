/** The repository a stock Rakazo deployment tracks. */
export const OFFICIAL_REPO_URL = "https://github.com/elie222/rakazo";
export const DEFAULT_UPDATE_BRANCH = "main";
export const DEFAULT_UPDATE_REMOTE = "origin";

const SCP_LIKE = /^(?<user>[A-Za-z0-9._-]+)@(?<host>[A-Za-z0-9._-]+):(?<path>[^:]+)$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const BRANCH_REJECT = /[\s~^:?*[\\]/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** Whitespace and control bytes are how a second argument gets smuggled into a command. */
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type RepoUrlResult = { url: string } | { error: string };
export type BranchResult = { branch: string } | { error: string };

/**
 * A custom repository is arbitrary code the server will run, so the only shapes accepted are
 * unambiguous https and ssh git remotes. Anything that could be read as a git option, a local
 * path, or a plaintext transport is refused rather than normalized into something plausible.
 */
export function normalizeRepoUrl(input: string): RepoUrlResult {
  const trimmed = input.trim();
  if (trimmed === "") return { error: "A repository URL is required." };
  if (trimmed.length > 400) return { error: "That repository URL is too long." };
  if (hasUnsafeCharacter(trimmed)) {
    return { error: "A repository URL cannot contain spaces or control characters." };
  }
  if (trimmed.startsWith("-")) return { error: "A repository URL cannot start with a dash." };

  const scp = SCP_LIKE.exec(trimmed);
  if (scp?.groups) {
    const path = normalizeRepoPath(scp.groups.path ?? "");
    if (path === null) return { error: "That does not look like a git repository path." };
    return { url: `${scp.groups.user}@${scp.groups.host}:${path}` };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "Enter an https:// or ssh:// git URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") {
    return { error: "Only https:// and ssh:// git remotes are allowed." };
  }
  if (url.hostname === "") return { error: "That URL has no host." };
  if (url.password !== "" || (url.protocol === "https:" && url.username !== "")) {
    return { error: "Do not put credentials in the repository URL." };
  }
  if (url.protocol === "ssh:" && url.username !== "" && !SAFE_PATH_SEGMENT.test(url.username)) {
    return { error: "That SSH username has unsupported characters." };
  }
  if (url.search !== "" || url.hash !== "") {
    return { error: "A repository URL cannot carry a query string or fragment." };
  }

  const path = normalizeRepoPath(url.pathname);
  if (path === null) return { error: "That does not look like a git repository path." };
  const credentials = url.username === "" ? "" : `${url.username}@`;
  const port = url.port === "" ? "" : `:${url.port}`;
  return { url: `${url.protocol}//${credentials}${url.hostname}${port}/${path}` };
}

function normalizeRepoPath(raw: string): string | null {
  const segments = raw.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  if (
    segments.some(
      (segment) => !SAFE_PATH_SEGMENT.test(segment) || segment === "." || segment === "..",
    )
  )
    return null;
  return segments.join("/");
}

/** `github.com/elie222/rakazo` for every spelling of the same remote, for comparison only. */
export function repoIdentity(url: string): string | null {
  const normalized = normalizeRepoUrl(url);
  if ("error" in normalized) return null;

  const scp = SCP_LIKE.exec(normalized.url);
  const host = scp?.groups?.host ?? safeHost(normalized.url);
  const path = scp?.groups?.path ?? safePath(normalized.url);
  if (host === null || path === null) return null;
  return `${host}/${path.replace(/\.git$/, "")}`.toLowerCase();
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function safePath(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/^\/+/, "");
  } catch {
    return null;
  }
}

export function isOfficialRepoUrl(url: string): boolean {
  const identity = repoIdentity(url);
  return identity !== null && identity === repoIdentity(OFFICIAL_REPO_URL);
}

export function normalizeUpdateBranch(input: string): BranchResult {
  const branch = input.trim();
  if (branch === "") return { error: "A branch name is required." };
  if (branch.length > 200) return { error: "That branch name is too long." };
  if (hasUnsafeCharacter(branch) || BRANCH_REJECT.test(branch)) {
    return { error: "That branch name has characters git rejects." };
  }
  if (branch.startsWith("-")) return { error: "A branch name cannot start with a dash." };
  if (branch.includes("..") || branch.includes("@{")) {
    return { error: "That branch name has characters git rejects." };
  }
  if (
    branch === "@" ||
    branch.endsWith(".") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("//") ||
    branch.split("/").some((component) => component.startsWith(".")) ||
    branch.split("/").some((component) => component.endsWith(".lock"))
  ) {
    return { error: "That branch name has characters git rejects." };
  }
  return { branch };
}

export function isGitCommit(value: string): boolean {
  return COMMIT.test(value.trim());
}

export interface PorcelainStatus {
  clean: boolean;
  changed: string[];
}

/** Reads `git status --porcelain --untracked-files=no`; build output must not look like drift. */
export function parseGitStatusPorcelain(stdout: string): PorcelainStatus {
  const changed = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== "");
  return { clean: changed.length === 0, changed };
}

export interface UpdateStep {
  id: string;
  label: string;
  command: string;
  args: string[];
}

export interface UpdatePlanInput {
  remote?: string;
  remoteUrl: string;
  branch: string;
  /** Immutable commit selected by preflight; a later branch movement must not change the update. */
  targetCommit: string;
  /** Set when the checkout currently points at a different remote and has to be re-pointed. */
  repointRemote?: boolean;
}

/**
 * Ordered work to get from "new commits on the remote" to "new code on disk". The migration runs
 * last so the window where the old process sees the new schema is as short as the restart itself,
 * and the merge is fast-forward only so local commits fail the update instead of being discarded.
 */
export function updateSteps(input: UpdatePlanInput): UpdateStep[] {
  if (!isGitCommit(input.targetCommit)) throw new Error("An update needs a full commit digest.");
  const remote = input.remote ?? DEFAULT_UPDATE_REMOTE;
  const steps: UpdateStep[] = [];
  if (input.repointRemote === true) {
    steps.push({
      id: "remote",
      label: "Point the checkout at the chosen repository",
      command: "git",
      args: ["remote", "set-url", remote, input.remoteUrl],
    });
  }
  steps.push(
    {
      id: "fetch",
      label: "Fetch the selected branch",
      command: "git",
      args: ["fetch", "--no-tags", "--prune", remote, input.branch],
    },
    {
      id: "merge",
      label: "Fast-forward to the checked commit",
      command: "git",
      args: ["merge", "--ff-only", input.targetCommit],
    },
    {
      id: "install",
      label: "Install dependencies",
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
    },
    {
      id: "generate",
      label: "Regenerate the database client",
      command: "pnpm",
      args: ["--filter", "@rakazo/db", "run", "generate"],
    },
    {
      id: "build",
      label: "Build the web app",
      command: "pnpm",
      args: ["--filter", "@rakazo/web", "run", "build"],
    },
    {
      id: "migrate",
      label: "Apply database migrations",
      command: "pnpm",
      args: ["--filter", "@rakazo/db", "run", "migrate"],
    },
  );
  return steps;
}

export type RestartSupervisor =
  | { kind: "systemd" | "pm2" | "declared"; label: string }
  | { kind: "none"; label: null };

export const RESTART_SUPERVISOR_ENV = "RAKAZO_UPDATE_RESTART_SUPERVISOR";

/**
 * Whether something outside this process will start it again after it exits. Docker restart
 * policies are invisible from inside the container, so that case has to be declared by the
 * operator; exiting without a supervisor would take the deployment down for good.
 */
export function detectRestartSupervisor(
  env: Record<string, string | undefined>,
): RestartSupervisor {
  const declared = env[RESTART_SUPERVISOR_ENV]?.trim();
  if (declared) return { kind: "declared", label: declared };
  if (env.INVOCATION_ID?.trim()) return { kind: "systemd", label: "systemd" };
  if (env.pm_id?.trim() || env.PM2_HOME?.trim()) return { kind: "pm2", label: "pm2" };
  return { kind: "none", label: null };
}

export function restartSupervisorAdvice(supervisor: RestartSupervisor): string {
  if (supervisor.kind !== "none") {
    return `Rakazo will exit after updating and ${supervisor.label} will start it on the new code.`;
  }
  return `No process supervisor was detected, so Rakazo will not exit on its own. Restart the API, worker, and web processes yourself, or set ${RESTART_SUPERVISOR_ENV} to the supervisor that restarts them (for example "docker" with restart: unless-stopped, or run under systemd with Restart=always).`;
}

export type UpdateAvailability =
  | { status: "unavailable"; reason: string }
  | { status: "dirty"; changed: string[] }
  | { status: "up-to-date"; commit: string }
  | { status: "available"; commit: string; targetCommit: string; behindBy: number };

export interface UpdateCheckInput {
  checkoutReason?: string;
  commit?: string;
  targetCommit?: string;
  behindBy?: number;
  status?: PorcelainStatus;
}

/** One place decides whether an update may proceed, so the API and the tests agree. */
export function decideUpdateAvailability(input: UpdateCheckInput): UpdateAvailability {
  if (input.checkoutReason) return { status: "unavailable", reason: input.checkoutReason };
  if (!input.commit || !input.targetCommit) {
    return { status: "unavailable", reason: "Could not read the current commit." };
  }
  if (input.status && !input.status.clean) {
    return { status: "dirty", changed: input.status.changed };
  }
  if (input.commit === input.targetCommit) return { status: "up-to-date", commit: input.commit };
  return {
    status: "available",
    commit: input.commit,
    targetCommit: input.targetCommit,
    behindBy: input.behindBy ?? 0,
  };
}

export function shortCommit(commit: string | null | undefined): string {
  return commit ? commit.trim().slice(0, 7) : "unknown";
}
