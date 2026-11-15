import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";

const EMULATOR_KEY = "fake-key";
const ACTIVE_RUN = new Set(["CREATING", "RUNNING"]);

interface WireRun {
  id: string;
  status: string;
}

interface WireAgent {
  id: string;
  name: string;
  repository?: string;
  autoCreatePR: boolean;
  archived: boolean;
  latestRunId: string;
  runs: Map<string, WireRun>;
  runningGets: number;
  branch?: string;
  prUrl?: string;
}

/**
 * In-process Cursor v1 HTTP server: agent and run lifecycle (CREATING, RUNNING,
 * terminal, ARCHIVED), documented error statuses, and post-commit transport faults.
 */
export class CursorCloudAgentEmulator {
  readonly agents = new Map<string, WireAgent>();
  readonly requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  /** The only bearer token accepted; change it to emulate a revoked key. */
  apiKey = EMULATOR_KEY;
  staleLatestRunId: string | undefined;
  loseNextLaunchResponse = false;
  loseNextReplyResponse = false;
  failNextRequest: number | undefined;
  cancelPending = false;
  private sequence = 0;

  /** `autoFinishAfterGets` finishes a run after that many reads; null leaves it to `complete`. */
  constructor(private readonly options: { autoFinishAfterGets?: number | null } = {}) {}

  readonly fetch: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    if (url.origin !== "https://api.cursor.com") throw new Error("Unexpected emulator origin");
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${this.apiKey}`)
      return Response.json({ code: "unauthorized", message: "Unauthorized" }, { status: 401 });
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, path: url.pathname, body });
    if (this.failNextRequest) {
      const status = this.failNextRequest;
      this.failNextRequest = undefined;
      return new Response(`${EMULATOR_KEY} must never be exposed`, {
        status,
        headers: status === 429 ? { "Retry-After": "30" } : {},
      });
    }
    if (url.pathname === "/v1/agents" && method === "POST") {
      if (this.agents.has(body.agentId)) return error(409, "agent_id_conflict");
      if (!body.prompt?.text?.trim()) return error(400, "validation_error");
      const agent: WireAgent = {
        id: body.agentId,
        name: body.prompt.text.split(/\r?\n/, 1)[0].slice(0, 80),
        repository: body.repos?.[0]?.url,
        autoCreatePR: body.autoCreatePR ?? false,
        archived: false,
        latestRunId: "",
        runs: new Map(),
        runningGets: 0,
      };
      this.agents.set(agent.id, agent);
      const run = this.startRun(agent);
      if (this.loseNextLaunchResponse) {
        this.loseNextLaunchResponse = false;
        throw new Error("Connection lost after create");
      }
      return Response.json({ agent: this.agentJson(agent), run: this.runJson(agent, run) });
    }
    const match = /^\/v1\/agents\/([^/]+)(?:\/runs(?:\/([^/]+)(\/cancel)?)?)?$/.exec(url.pathname);
    const agent = match && this.agents.get(decodeURIComponent(match[1]!));
    if (!match || !agent) return error(404, "agent_not_found");
    if (method === "GET" && !url.pathname.includes("/runs"))
      return Response.json(this.agentJson(agent));
    if (method === "GET" && !match[2]) {
      const items = [...agent.runs.values()].reverse().map((run) => this.runJson(agent, run));
      return Response.json({ items: items.slice(0, Number(url.searchParams.get("limit") ?? 20)) });
    }
    if (method === "POST" && !match[2]) {
      if (agent.archived) return error(409, "agent_archived");
      if (this.activeRun(agent)) return error(409, "agent_busy");
      if (!body?.prompt?.text?.trim()) return error(400, "validation_error");
      const run = this.startRun(agent);
      if (this.loseNextReplyResponse) {
        this.loseNextReplyResponse = false;
        throw new Error("Connection lost after reply");
      }
      return Response.json({ run: this.runJson(agent, run) });
    }
    const run = agent.runs.get(decodeURIComponent(match[2] ?? ""));
    if (!run) return error(404, "run_not_found");
    if (method === "GET") {
      const limit = this.options.autoFinishAfterGets ?? null;
      if (run.status === "CREATING") run.status = "RUNNING";
      else if (ACTIVE_RUN.has(run.status) && limit !== null && ++agent.runningGets >= limit)
        this.complete(agent.id);
      return Response.json(this.runJson(agent, run));
    }
    if (match[3] && method === "POST") {
      if (!ACTIVE_RUN.has(run.status)) return error(409, "run_not_cancellable");
      if (!this.cancelPending) run.status = "CANCELLED";
      return Response.json({ id: run.id });
    }
    return error(404, "not_found");
  };

  complete(id: string, options: { failed?: boolean; prUrl?: string } = {}) {
    const agent = this.agents.get(id)!;
    this.setRunStatus(id, options.failed ? "ERROR" : "FINISHED");
    agent.branch = "emulator/task";
    agent.prUrl =
      options.prUrl ??
      (agent.autoCreatePR && agent.repository
        ? `${agent.repository.replace(/\.git$/, "")}/pull/1`
        : undefined);
  }

  /** Set the latest run to any wire status, including ones the adapter does not know. */
  setRunStatus(id: string, status: string) {
    const agent = this.agents.get(id)!;
    agent.runs.get(agent.latestRunId)!.status = status;
  }

  /** Cursor reports archived and expired agents as ARCHIVED; they accept no new runs. */
  archive(id: string) {
    this.agents.get(id)!.archived = true;
  }

  private activeRun(agent: WireAgent) {
    return ACTIVE_RUN.has(agent.runs.get(agent.latestRunId)?.status ?? "");
  }

  private startRun(agent: WireAgent) {
    const run = { id: `run-${++this.sequence}`, status: "CREATING" };
    agent.latestRunId = run.id;
    agent.runningGets = 0;
    agent.runs.set(run.id, run);
    return run;
  }

  private agentJson(agent: WireAgent) {
    return {
      id: agent.id,
      name: agent.name,
      status: agent.archived ? "ARCHIVED" : this.activeRun(agent) ? "ACTIVE" : "IDLE",
      url: `https://cursor.com/agents/${agent.id}`,
      latestRunId: this.staleLatestRunId ?? agent.latestRunId,
    };
  }

  private runJson(agent: WireAgent, run: WireRun) {
    return {
      id: run.id,
      agentId: agent.id,
      status: run.status,
      ...(agent.branch
        ? {
            git: {
              branches: [{ repoUrl: agent.repository, branch: agent.branch, prUrl: agent.prUrl }],
            },
          }
        : {}),
    };
  }
}

function error(status: number, code: string) {
  return Response.json({ error: { code, message: code } }, { status });
}

/** The real Cursor adapter over the in-process wire emulator: offline in every Space. */
export class EmulatorCloudAgentProvider extends CursorCloudAgentProvider {
  constructor(readonly emulator = new CursorCloudAgentEmulator({ autoFinishAfterGets: 2 })) {
    super({ apiKey: EMULATOR_KEY, fetch: emulator.fetch });
  }

  override describe() {
    const description = super.describe();
    return {
      ...description,
      id: "emulator",
      capabilities: { ...description.capabilities, offline: true },
    };
  }
}
