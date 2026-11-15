export const T3_TOKEN = "fake-t3-token";
export const SECRET_BODY = "secret-diagnostic-body";

interface Run {
  runId: string;
  ordinal: number;
  status: string;
  requestedAt: string;
  completedAt: string | null;
  /** Waits for a person in T3 Code to release the queue. */
  held?: boolean;
  interruptRequested?: boolean;
}
interface Thread {
  threadId: string;
  projectId: string;
  title: string;
  message: string;
  runs: Run[];
  branch: string | null;
  prUrl: string | null;
  pendingRequestCount: number;
  /** Launched into a worktree, which exists once its setup finished. */
  worktree: boolean;
  worktreePath: string | null;
}
type Args = Record<string, unknown>;
type Outcome =
  | { result: unknown }
  | { failure: string; message?: string }
  | { invalidParams: true };
const ACTIVE = ["preparing", "starting", "running", "waiting"];
// Exact advertisedJsonSchema() output from pingdotgg/t3code at
// b63d3c592318ce936f787c48023f0dba498056dd.
const T3_ADVERTISED_SCHEMAS = {
  t3_thread_launch: {
    type: "object",
    properties: {
      environmentId: {
        type: "string",
      },
      projectId: {
        type: "string",
      },
      scratch: {
        type: "boolean",
        description:
          "No project: a new Scratch folder. Not with `projectId` or `workspaceStrategy`.",
      },
      title: {
        type: "string",
      },
      modelSelection: {
        type: "object",
        properties: {
          provider: {},
          instanceId: {},
          model: {},
          options: {},
        },
        required: ["model"],
      },
      runtimeMode: {
        type: "string",
        enum: ["approval-required", "auto-accept-edits", "auto", "full-access"],
      },
      interactionMode: {
        type: "string",
        enum: ["default", "plan"],
      },
      workspaceStrategy: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["root", "existing_worktree", "worktree"],
          },
          branch: {
            type: "string",
          },
          worktreePath: {
            type: "string",
          },
          baseRef: {
            type: "string",
          },
          startFromOrigin: {
            type: "boolean",
          },
        },
        required: ["type"],
        description:
          "'worktree': new checkout from `baseRef`. Honor a requested base. Otherwise, independent work uses the default branch as `remote/branch` (e.g. `origin/main`) with `startFromOrigin: true`; with no remote, use the local default branch. Required unpublished commits and dependent or stacked work use their local base with `startFromOrigin: false`. 'existing_worktree': bind `worktreePath`, a project worktree. 'root': project checkout, the default, not your worktree. Uncommitted edits are not copied.",
      },
      message: {
        type: "string",
        maxLength: 120000,
        description: "First prompt. Omit it and `attachments` for idle.",
      },
      attachments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["image", "file"],
            },
            id: {
              type: "string",
            },
            name: {
              type: "string",
            },
            mimeType: {
              type: "string",
            },
            sizeBytes: {
              anyOf: [
                {
                  type: "integer",
                  minimum: 0,
                  maximum: 10485760,
                },
                {
                  type: "integer",
                  minimum: 1,
                  maximum: 52428800,
                },
              ],
            },
            source: {
              type: "object",
              properties: {
                _tag: {
                  type: "string",
                  enum: ["pasted-text"],
                },
              },
              required: ["_tag"],
            },
          },
          required: ["type", "id", "name", "mimeType", "sizeBytes"],
        },
        maxItems: 8,
      },
      clientRequestId: {
        type: "string",
      },
      delegatedFrom: {
        type: "object",
        properties: {
          environmentId: {
            type: "string",
          },
          threadId: {
            type: "string",
          },
          title: {
            type: "string",
          },
        },
        required: ["environmentId", "threadId", "title"],
      },
    },
    required: ["title"],
  },
  t3_project_list: {
    type: "object",
    properties: {
      environmentId: {
        type: "string",
      },
      cursor: {
        type: "integer",
        minimum: 0,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
      },
    },
  },
  t3_queue: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "read", "edit", "cancel", "reorder", "promote_to_steer"],
      },
      environmentId: {
        type: "string",
      },
      threadId: {
        type: "string",
      },
      queuedRunId: {
        type: "string",
      },
      text: {
        type: "string",
        maxLength: 100000,
      },
      beforeRunId: {
        type: "string",
      },
      targetRunId: {
        type: "string",
      },
      cursor: {
        type: "integer",
        minimum: 0,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
      },
    },
    required: ["action"],
  },
  orchestrator_capabilities: {
    type: "object",
    properties: {
      environmentId: {
        type: "string",
      },
      search: {
        type: "string",
      },
    },
  },
  t3_thread_read: {
    type: "object",
    properties: {
      environmentId: {
        type: "string",
      },
      threadId: {
        type: "string",
      },
      itemId: {
        type: "string",
      },
      textOffset: {
        type: "integer",
        minimum: 0,
      },
      view: {
        type: "string",
        enum: ["messages", "activity"],
      },
      afterPosition: {
        type: "integer",
        minimum: 0,
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Max items, 1 to 100.",
      },
      runLimit: {
        type: "integer",
        minimum: 1,
        description: "Max recent runs, 1 to 50.",
      },
      maxCharsPerItem: {
        type: "integer",
        minimum: 1,
        description: "Max chars per item, 1 to 50000.",
      },
    },
    required: ["threadId"],
  },
  t3_thread_send: {
    type: "object",
    properties: {
      environmentId: {
        type: "string",
      },
      threadId: {
        type: "string",
      },
      message: {
        type: "string",
      },
      mode: {
        type: "string",
        enum: ["auto", "queue", "steer", "restart"],
      },
      freshContext: {
        type: "boolean",
        description:
          "Start a new provider session without the thread's earlier context, like /clear. Never steers.",
      },
      clientRequestId: {
        type: "string",
      },
    },
    required: ["threadId", "message"],
  },
  t3_thread_interrupt: {
    type: "object",
    properties: {
      environmentId: {
        type: "string",
      },
      threadId: {
        type: "string",
      },
      runId: {
        type: "string",
      },
      reason: {
        type: "string",
        maxLength: 2000,
      },
      stop: {
        type: "boolean",
      },
      clientRequestId: {
        type: "string",
      },
    },
    required: ["threadId"],
  },
};
export const T3_TOOLS: Array<{
  name: string;
  inputSchema: Record<string, unknown> & {
    properties: Record<string, unknown>;
    required?: string[];
  };
}> = [
  "t3_project_list",
  "t3_thread_launch",
  "t3_thread_read",
  "t3_thread_send",
  "t3_thread_interrupt",
  "t3_queue",
  "orchestrator_capabilities",
].map((name) => ({
  name,
  inputSchema: T3_ADVERTISED_SCHEMAS[name as keyof typeof T3_ADVERTISED_SCHEMAS],
}));

/** T3 Code's orchestrator MCP endpoint on the wire: streamable HTTP, JSON responses,
 * structured results, and failures as `isError` text carrying `{_tag, code, message}`. */
export class T3McpEmulator {
  token = T3_TOKEN;
  tools = structuredClone(T3_TOOLS);
  listCalls = 0;
  failList = false;
  readonly calls: Array<{ tool: string; args: Args }> = [];
  readonly threads = new Map<string, Thread>();
  /** Fails the next tool call after it ran, as a lost response would. */
  loseNextResponse = false;
  /** Fails the next call (of `tool`, when given) before it runs. */
  failNext?: (
    | { status: number }
    | { failure: string }
    | { internal: true }
    | { invalidParams: true }
  ) & { tool?: string };
  /** No default model is set, so a launch must name one. */
  noDefaultModel = false;
  /** Providers and models `orchestrator_capabilities` offers; constraints mean it cannot run. */
  providers: Array<{
    providerInstanceId: string;
    models: { id: string }[];
    constraints?: string[];
  }> = [
    {
      providerInstanceId: "off",
      models: [{ id: "model-off" }],
      constraints: ["Provider instance is disabled."],
    },
    { providerInstanceId: "idle", models: [], constraints: [] },
    {
      providerInstanceId: "agent-b",
      models: [{ id: "model-a" }, { id: "model-b" }],
      constraints: [],
    },
  ];
  /** Launch replays are keyed by the token's session, as T3 Code keys them. */
  private launches = new Map<string, string>();
  private sessions = 0;
  private runs = 0;
  readonly projects: Array<{
    id: string;
    title: string;
    workspaceRoot: string;
    repositoryIdentity: Record<string, unknown> | null;
    archivedAt?: string | null;
  }> = [
    { id: "project-other", title: "other", workspaceRoot: "/srv/other", repositoryIdentity: null },
    {
      id: "project-demo",
      title: "demo",
      workspaceRoot: "/srv/demo",
      repositoryIdentity: {
        canonicalKey: "github.com/example/demo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@github.com:example/demo.git",
        },
        webUrl: "https://github.com/example/demo",
      },
    },
  ];

  fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.headers.get("authorization") !== `Bearer ${this.token}`)
      return new Response(`invalid_mcp_credential ${SECRET_BODY}`, { status: 401 });
    if (request.method === "DELETE") return new Response(null, { status: 202 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(await request.text()) as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: Args; protocolVersion?: string };
    };
    const respond = (body: Args, headers?: HeadersInit) =>
      Response.json({ jsonrpc: "2.0", id: message.id, ...body }, { headers });
    if (message.method === "initialize") {
      this.sessions += 1;
      return respond(
        {
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "T3 Code", version: "1" },
          },
        },
        { "mcp-session-id": `session-${this.sessions}` },
      );
    }
    if (!request.headers.get("mcp-session-id")) return new Response(null, { status: 400 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "tools/list") {
      this.listCalls += 1;
      if (this.failList) return new Response(null, { status: 503 });
      return respond({ result: { tools: this.tools } });
    }
    if (message.method !== "tools/call") return respond({ error: { code: -32601, message: "no" } });
    const tool = message.params?.name ?? "";
    const args = message.params?.arguments ?? {};
    this.calls.push({ tool, args });
    const fail = this.failNext && (this.failNext.tool ?? tool) === tool ? this.failNext : undefined;
    if (fail) this.failNext = undefined;
    if (fail && "status" in fail)
      return new Response(`${SECRET_BODY} ${T3_TOKEN}`, { status: fail.status });
    if (fail && "internal" in fail)
      return respond({
        result: {
          isError: true,
          content: [
            { type: "text", text: "Tool execution failed due to an internal server error." },
          ],
        },
      });
    const outcome: Outcome = fail ?? this.handle(tool, args);
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      return new Response(SECRET_BODY, { status: 502 });
    }
    if ("invalidParams" in outcome)
      return respond({
        error: { code: -32602, message: `Tool '${tool}' not found ${SECRET_BODY}` },
      });
    if ("failure" in outcome)
      return respond({
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                _tag: "OrchestratorMcpFailure",
                code: outcome.failure,
                message: outcome.message ?? SECRET_BODY,
              }),
            },
          ],
        },
      });
    return respond({
      result: {
        content: [{ type: "text", text: JSON.stringify(outcome.result) }],
        structuredContent: outcome.result,
      },
    });
  };

  /** Ends the running run; a finished agent that was asked to opens its pull request. The next
   * queued message starts, or after a failure or a Stop waits held. */
  complete(threadId: string, status = "completed") {
    const thread = this.threads.get(threadId)!;
    for (const run of thread.runs) if (ACTIVE.includes(run.status)) end(run, status);
    if (status !== "completed") {
      for (const run of thread.runs) if (run.status === "queued") run.held = true;
      return;
    }
    startNext(thread);
    if (thread.worktree) thread.worktreePath = "/srv/worktrees/task";
    thread.branch = "emulator/task";
    if (/pull request/i.test(thread.message))
      thread.prUrl = "https://github.com/example/demo/pull/1";
  }

  /** T3 Code starts a run itself, as when a background task the agent left finishes. */
  continueRun(threadId: string) {
    const thread = this.threads.get(threadId)!;
    thread.runs.push(this.newRun(thread.runs.length + 1, "running"));
  }

  /** The agent asks for an approval: its run stays running with a pending request. */
  awaitApproval(threadId: string) {
    this.threads.get(threadId)!.pendingRequestCount = 1;
  }

  private handle(tool: string, args: Args): Outcome {
    if (!T3_TOOLS.some((entry) => entry.name === tool)) return { invalidParams: true };
    if (tool === "t3_project_list") {
      const cursor = Number(args.cursor ?? 0);
      const limit = Number(args.limit ?? 20);
      return {
        result: {
          projects: this.projects.slice(cursor, cursor + limit),
          nextCursor: cursor + limit < this.projects.length ? cursor + limit : null,
        },
      };
    }
    if (tool === "t3_thread_launch") return this.launch(args);
    if (tool === "orchestrator_capabilities")
      return {
        result: {
          inheritedProviderInstanceId: null,
          inheritedModel: null,
          providers: this.providers,
        },
      };
    const thread = this.threads.get(String(args.threadId));
    if (!thread) return { failure: "thread_not_found" };
    const active = thread.runs.findLast((run) => ACTIVE.includes(run.status));
    if (tool === "t3_thread_read") {
      const latest = thread.runs.at(-1);
      // An interrupt lands once the agent stops, after this read.
      queueMicrotask(() => {
        for (const run of thread.runs)
          if (run.interruptRequested && !isTerminal(run.status)) end(run, "interrupted");
        startNext(thread);
      });
      return {
        result: {
          thread: {
            threadId: thread.threadId,
            projectId: thread.projectId,
            title: thread.title,
            link: link(thread.threadId),
            status: active?.status ?? latest?.status ?? "idle",
            latestRunId: latest?.runId ?? null,
            activeRunId: active?.runId ?? null,
            pendingRequestCount: thread.pendingRequestCount,
            linkedPullRequest: thread.prUrl
              ? {
                  projectId: thread.projectId,
                  repository: "example/demo",
                  number: 1,
                  url: thread.prUrl,
                }
              : null,
            branch: thread.branch,
            worktreePath: null,
            settled: false,
          },
          recentRuns: thread.runs
            .toReversed()
            .slice(0, Number(args.runLimit ?? 10))
            .map(({ held: _held, interruptRequested: _interrupt, ...run }) => ({
              ...run,
              model: "model",
            })),
          items: [],
          nextPosition: null,
          hasMore: false,
        },
      };
    }
    if (tool === "t3_thread_send") {
      // After its worktree setup failed or was stopped, T3 Code holds what is sent next.
      const latest = thread.runs.at(-1);
      const worktreeMissing =
        !active &&
        thread.worktree &&
        thread.worktreePath === null &&
        (latest?.status === "failed" || latest?.status === "interrupted");
      const run = this.newRun(
        thread.runs.length + 1,
        active || worktreeMissing ? "queued" : "starting",
      );
      run.held = worktreeMissing;
      thread.runs.push(run);
      return {
        result: {
          threadId: thread.threadId,
          messageId: `message-${run.runId}`,
          runId: run.runId,
          status: run.status,
          delivery: active ? "queued" : "started",
        },
      };
    }
    if (tool === "t3_thread_interrupt") {
      // A targeted interrupt asks that run only to stop; the queue then moves on to the next run.
      const target = thread.runs.find((run) => run.runId === args.runId);
      if (args.runId !== undefined && !target) return { failure: "run_not_found" };
      if (target && isTerminal(target.status))
        return {
          result: { threadId: thread.threadId, runId: target.runId, status: target.status },
        };
      if (!active || (target && target !== active))
        return target
          ? { failure: "thread_not_interruptible" }
          : { result: { threadId: thread.threadId, runId: null, status: "no_active_run" } };
      active.interruptRequested = true;
      thread.pendingRequestCount = 0;
      return {
        result: { threadId: thread.threadId, runId: active.runId, status: "interrupt_requested" },
      };
    }
    if (tool === "t3_queue" && args.action === "cancel") {
      const queued = thread.runs.find((run) => run.runId === args.queuedRunId);
      if (queued?.status !== "queued") return { failure: "orchestration_error" };
      end(queued, "cancelled");
      return { result: { sequence: 1 } };
    }
    return { invalidParams: true };
  }

  private launch(args: Args): Outcome {
    const title = String(args.title ?? "").trim();
    if (!title || title.length > 512) return { invalidParams: true };
    if (args.scratch === true && (args.projectId || args.workspaceStrategy))
      return { failure: "invalid_request" };
    if (this.noDefaultModel && !args.modelSelection)
      return {
        failure: "invalid_request",
        message:
          "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
      };
    const projectId = args.scratch === true ? "project-scratch" : String(args.projectId ?? "");
    if (args.scratch !== true && !this.projects.some((project) => project.id === projectId))
      return { failure: "orchestration_error" };
    const key =
      typeof args.clientRequestId === "string" ? `${this.token}\0${args.clientRequestId}` : "";
    const replayed = key ? this.launches.get(key) : undefined;
    const threadId = replayed ?? `thread-${this.threads.size + 1}`;
    if (!replayed) {
      if (key) this.launches.set(key, threadId);
      this.threads.set(threadId, {
        threadId,
        projectId,
        title,
        message: String(args.message ?? ""),
        runs: [this.newRun(1, "preparing")],
        branch: null,
        prUrl: null,
        pendingRequestCount: 0,
        worktree: (args.workspaceStrategy as { type?: string } | undefined)?.type === "worktree",
        worktreePath: null,
      });
    }
    const run = this.threads.get(threadId)!.runs[0]!;
    return {
      result: {
        threadId,
        link: link(threadId),
        projectId,
        modelSelection: args.modelSelection ?? { instanceId: "default", model: "model" },
        runId: run.runId,
        status: run.status,
      },
    };
  }

  private newRun(ordinal: number, status: string): Run {
    this.runs += 1;
    const requestedAt = new Date().toISOString();
    return { runId: `run-${this.runs}`, ordinal, status, requestedAt, completedAt: null };
  }
}

function startNext(thread: Thread) {
  if (thread.runs.some((run) => ACTIVE.includes(run.status))) return;
  const next = thread.runs.find((run) => run.status === "queued" && !run.held);
  if (next) next.status = "running";
}

function end(run: Run, status: string) {
  run.status = status;
  run.completedAt = new Date().toISOString();
}

function isTerminal(status: string) {
  return ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
}

export function link(threadId: string) {
  return `https://app.example.test/threads/env-1/${threadId}`;
}
