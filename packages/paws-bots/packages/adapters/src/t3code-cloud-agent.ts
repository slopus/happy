import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type {
  AdapterContext,
  CloudAgentHandle,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
  CloudAgentStatus,
} from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { z } from "zod";
import type { RemoteMcpOptions } from "./remote-mcp.js";
import { callRemoteMcpTool } from "./remote-mcp.js";

const readSchema = z.object({
  thread: z.object({
    threadId: z.string().min(1),
    title: z.string(),
    link: z.string().optional(),
    // Unknown future statuses read as running rather than wedging the poll.
    status: z.string(),
    latestRunId: z.string().nullable(),
    activeRunId: z.string().nullish(),
    branch: z.string().nullish(),
    linkedPullRequest: z.object({ url: z.string() }).nullish(),
    pullRequests: z.array(z.object({ url: z.string() })).optional(),
  }),
  recentRuns: z.array(
    z.object({
      runId: z.string(),
      status: z.string(),
      requestedAt: z.string().optional(),
      completedAt: z.string().nullish(),
    }),
  ),
});
const projectsSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string().min(1),
      repositoryIdentity: z
        .object({
          canonicalKey: z.string(),
          webUrl: z.string().optional(),
          // A fork checkout with an `upstream` remote keys by upstream and keeps the fork here.
          origin: z.object({ canonicalKey: z.string() }).optional(),
        })
        .nullish(),
      archivedAt: z.string().nullish(),
    }),
  ),
  nextCursor: z.number().int().nonnegative().nullable(),
});
const launchSchema = z.object({
  threadId: z.string().min(1),
  link: z.string().optional(),
  runId: z.string().nullable(),
  status: z.string().nullable(),
});
const sendSchema = z.object({ runId: z.string().min(1), status: z.string() });
const capabilitiesSchema = z.object({
  providers: z.array(
    z.object({
      providerInstanceId: z.string(),
      models: z.array(z.object({ id: z.string() })),
      // Why it cannot run now: disabled, not installed or signed out.
      constraints: z.array(z.string()).catch([]),
    }),
  ),
});
// Refusals of the request itself, as a 4xx is elsewhere: a disabled provider or an admin mode
// ceiling, access the connection was not granted, and any call on an archived thread or one
// running above that access. Each needs a change in T3 Code or a reconnect, so polling cannot fix it.
const INVALID = new Set([
  "invalid_request",
  "capability_denied",
  "thread_not_sendable",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
]);
const OPEN_PR = "When you finish, open a pull request with your changes.";
// Between two runs the next one waits only a moment. A wait this long, which also covers clock
// drift between the two machines, is a hold.
const HOLD_MS = 60_000;
/** The most runs T3 Code returns in one read. */
const RUN_LIMIT = 50;

export interface T3CodeCloudAgentOptions
  extends Pick<RemoteMcpOptions, "fetch" | "resolveHostname" | "allowPrivateEndpoint"> {
  /** The environment's MCP endpoint, `https://<environment>/mcp`. */
  endpoint: string;
  /** The connection's access token; none once it needs a reconnect. */
  token: string | undefined;
  /** T3 Code refused the token. Resolves only if a new one replaced it. */
  onTokenRejected?: () => Promise<unknown>;
}

/** T3 Code threads over its orchestrator MCP tools; wire formats stay inside this adapter. */
export class T3CodeCloudAgentProvider implements CloudAgentProvider {
  private readonly transport: RemoteMcpOptions;
  private readonly token: string | undefined;

  constructor(private readonly options: T3CodeCloudAgentOptions) {
    this.token = options.token?.trim() || undefined;
    this.transport = {
      endpoint: options.endpoint.trim(),
      headers: { Authorization: `Bearer ${this.token}` },
      fetch: options.fetch,
      resolveHostname: options.resolveHostname,
      allowPrivateEndpoint: options.allowPrivateEndpoint,
    };
  }

  describe() {
    return {
      id: "t3code",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { launch: true, reply: true, cancel: true, offline: false },
    };
  }

  async launch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    // Images need T3 Code's separate upload flow, which this adapter does not speak.
    if (request.images?.length) throw new CloudAgentRequestRejected("invalid");
    const signal = request.signal ?? context.signal;
    const title = request.prompt.trim().split("\n", 1)[0]!.trim().slice(0, 80) || "Cloud agent";
    // A repository runs in a fresh worktree of its project, so parallel agents never share a checkout.
    // It starts from the checkout's HEAD: T3 Code does not tell outside clients the default branch.
    const target = request.repository
      ? {
          projectId: await this.projectFor(request.repository, signal),
          workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
        }
      : { scratch: true };
    // T3 Code derives the thread id from the token's session and this key, so a replay reaches the
    // same thread.
    const launch = {
      title,
      ...target,
      message: request.openPr ? `${request.prompt}\n\n${OPEN_PR}` : request.prompt,
      clientRequestId: request.idempotencyKey,
    };
    // Threads start on T3 Code's default model; with none set, on the first model it offers.
    const parsed = launchSchema.safeParse(
      (await this.call("t3_thread_launch", launch, signal, needsModel)) ??
        (await this.call(
          "t3_thread_launch",
          { ...launch, modelSelection: await this.firstModel(signal) },
          signal,
        )),
    );
    if (!parsed.success) throw new Error("Invalid cloud agent response");
    return {
      id: parsed.data.threadId,
      title,
      url: parsed.data.link ?? "",
      status: statusOf(parsed.data.status ?? "running"),
      ...(parsed.data.runId ? { latestRunId: parsed.data.runId } : {}),
    };
  }

  async get(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const first = await this.statusRead(id, context.signal, runId);
    if (!first.held) return first.snapshot;
    // Read again, so a moment between two runs is not taken for a hold.
    const { snapshot, held } = await this.statusRead(id, context.signal, runId);
    if (!held || snapshot.latestRunId !== first.snapshot.latestRunId) return snapshot;
    // A hold lasts until something in T3 Code releases it, so the agent ends here, and its run
    // leaves the queue so it cannot start later unobserved. A run that started meanwhile is read
    // again; one T3 Code will not let this connection drop still ends the agent.
    const dropped = await this.call(
      "t3_queue",
      { action: "cancel", threadId: id, queuedRunId: snapshot.latestRunId },
      context.signal,
      notQueued,
    ).catch((error) => {
      if (error instanceof CloudAgentRequestRejected && error.reason === "invalid") return true;
      throw error;
    });
    return dropped
      ? { ...snapshot, status: "failed" }
      : (await this.statusRead(id, context.signal, runId)).snapshot;
  }

  async reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    if (request.images?.length) throw new CloudAgentRequestRejected("invalid");
    const signal = request.signal ?? context.signal;
    // Read first: no fallible call after the send, and a failed read means nothing was sent.
    const thread = await this.read(id, signal).catch((error) => {
      if (error instanceof CloudAgentRequestRejected || error instanceof CloudAgentRetryLater)
        throw error;
      throw new CloudAgentRetryLater("unavailable");
    });
    // Sends have no key here: an ambiguous failure is resolved by the run list, not a resend.
    const parsed = sendSchema.safeParse(
      await this.call(
        "t3_thread_send",
        { threadId: id, message: request.prompt, mode: "queue" },
        signal,
      ),
    );
    if (!parsed.success) throw new Error("Invalid cloud agent follow-up response");
    return { ...thread, status: statusOf(parsed.data.status), latestRunId: parsed.data.runId };
  }

  async cancel(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    // Without a run id the newest run is the target: the poll worker omits it only while a
    // follow-up it sent may not have been recorded yet, and once recorded that run is the newest.
    const { snapshot, queued } = await this.statusRead(id, context.signal, runId);
    if (snapshot.status !== "running") return snapshot;
    const target = snapshot.latestRunId;
    // Only the tracked run is stopped, which after a finished run is the newer run the card
    // followed: a thread-wide Stop would also hold every queued message and end other work. A
    // queued run that started meanwhile is refused by the queue; the read still shows it
    // running, so the caller's next cancel interrupts it. A stop T3 Code refuses, as on a
    // thread above this connection's access, is asked again while the run lasts; the read below
    // still ends a run T3 Code holds.
    await (queued
      ? this.call(
          "t3_queue",
          { action: "cancel", threadId: id, queuedRunId: target },
          context.signal,
          notQueued,
        )
      : this.call("t3_thread_interrupt", { threadId: id, runId: target }, context.signal)
    ).catch(refused);
    return this.get(id, context, target);
  }

  private async read(id: string, signal: AbortSignal, runId?: string) {
    return (await this.inspect(id, signal, runId)).snapshot;
  }

  /** A status read T3 Code refuses is refused on every poll, so the agent ends as if it were gone. */
  private statusRead(id: string, signal: AbortSignal, runId?: string) {
    return this.inspect(id, signal, runId).catch((error: unknown) => {
      throw error instanceof CloudAgentRequestRejected && error.reason === "invalid"
        ? new CloudAgentRequestRejected("not_found")
        : error;
    });
  }

  private async inspect(id: string, signal: AbortSignal, runId?: string) {
    const parsed = readSchema.safeParse(
      await this.call("t3_thread_read", { threadId: id, limit: 1, runLimit: RUN_LIMIT }, signal),
    );
    if (!parsed.success || parsed.data.thread.threadId !== id)
      throw new Error("Invalid cloud agent response");
    const { thread, recentRuns } = parsed.data;
    // Newest first, so a newer run has a lower index.
    const tracked = runId ? recentRuns.findIndex((candidate) => candidate.runId === runId) : -1;
    // A thread's runs take turns, so a tracked run that is not active and is older than a full
    // read of newer runs has ended. The read no longer says how, and other runs say nothing of it.
    const ended =
      runId !== undefined &&
      tracked === -1 &&
      thread.activeRunId !== runId &&
      recentRuns.length >= RUN_LIMIT;
    const active = recentRuns.findIndex((candidate) => candidate.runId === thread.activeRunId);
    // After a run finishes T3 Code may start the next itself, as when a background task the agent
    // left completes. That run carries on the same work, so it is followed.
    const run =
      recentRuns[
        recentRuns[tracked]?.status === "completed" && active !== -1 && active < tracked
          ? active
          : tracked
      ];
    const newest = recentRuns.find((candidate) => candidate.runId === thread.latestRunId);
    const prUrl = thread.linkedPullRequest?.url ?? thread.pullRequests?.[0]?.url;
    const snapshot: CloudAgentSnapshot = {
      id,
      title: thread.title || "Cloud agent",
      url: thread.link ?? "",
      status: ended ? "finished" : statusOf(run?.status ?? thread.status),
      // A tracked run past the recent list is still the one followed, not whatever ran last.
      ...((run?.runId ?? runId ?? thread.latestRunId)
        ? { latestRunId: run?.runId ?? runId ?? thread.latestRunId! }
        : {}),
      ...(thread.branch ? { branch: thread.branch } : {}),
      ...(prUrl ? { prUrl } : {}),
    };
    // Nothing runs while the run still waits: T3 Code holds its queue after a failed or stopped
    // worktree setup, a provider failure or a Stop. Unreadable times never count as a hold.
    const quietSince = Math.max(
      ...recentRuns.map(({ requestedAt, completedAt }) =>
        Date.parse(completedAt ?? requestedAt ?? ""),
      ),
    );
    const held =
      run?.status === "queued" && thread.activeRunId === null && Date.now() - quietSince > HOLD_MS;
    return { snapshot, queued: (run ?? newest)?.status === "queued", held };
  }

  private async firstModel(signal: AbortSignal) {
    const parsed = capabilitiesSchema.safeParse(
      await this.call("orchestrator_capabilities", {}, signal),
    );
    if (!parsed.success) throw new Error("Invalid cloud agent response");
    const provider = parsed.data.providers.find(
      ({ models, constraints }) => models.length > 0 && constraints.length === 0,
    );
    if (!provider) throw new CloudAgentRequestRejected("invalid");
    return { instanceId: provider.providerInstanceId, model: provider.models[0]!.id };
  }

  private async projectFor(repository: string, signal: AbortSignal) {
    const wanted = repositoryKey(repository);
    for (let cursor: number | null = 0; cursor !== null; ) {
      const parsed = projectsSchema.safeParse(
        await this.call("t3_project_list", { cursor, limit: 100 }, signal),
      );
      // A cursor that does not advance would page forever.
      if (!parsed.success || (parsed.data.nextCursor ?? Infinity) <= cursor)
        throw new Error("Invalid cloud agent response");
      const match = parsed.data.projects.find(
        ({ repositoryIdentity: identity, archivedAt }) =>
          !archivedAt &&
          [identity?.canonicalKey, identity?.webUrl, identity?.origin?.canonicalKey].some(
            (value) => value && repositoryKey(value) === wanted,
          ),
      );
      if (match) return match.id;
      cursor = parsed.data.nextCursor;
    }
    // T3 Code runs only projects already on its machine, and none has this repository.
    throw new CloudAgentRequestRejected("invalid");
  }

  private async call(
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    /** A declared failure the caller handles itself. */
    expected?: (failure: Failure) => boolean,
  ) {
    // Without a token nothing can reach T3 Code until the user reconnects it.
    if (!this.token) throw new CloudAgentRequestRejected("expired");
    let envelope: unknown;
    try {
      envelope = await callRemoteMcpTool({ ...this.transport, signal }, tool, args);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      // Transport errors carry response bodies; none of them leave this adapter.
      if (error instanceof StreamableHTTPError && error.code === 401) {
        // An expired or revoked token: T3 Code issues no refresh token, so the connection
        // needs a reconnect and its agents can no longer be followed.
        const replaced = await this.options.onTokenRejected?.().then(
          () => true,
          () => false,
        );
        throw replaced
          ? new CloudAgentRetryLater("credential")
          : new CloudAgentRequestRejected("expired");
      }
      if (error instanceof StreamableHTTPError && error.code === 403)
        throw new CloudAgentRetryLater("credential");
      if (error instanceof StreamableHTTPError && error.code === 429)
        throw new CloudAgentRetryLater("rate_limited");
      // T3 Code answers an unknown tool, or arguments its version does not take, this way: it
      // refused the request before running it, and asking again cannot change that.
      if (error instanceof McpError && error.code === ErrorCode.InvalidParams)
        throw new CloudAgentRequestRejected("invalid");
      throw new Error("Cloud agent request failed");
    }
    const result = z
      .object({ isError: z.boolean(), structuredContent: z.unknown(), content: z.unknown() })
      .safeParse(envelope);
    if (!result.success) throw new Error("Invalid cloud agent response");
    if (!result.data.isError) return result.data.structuredContent;
    const failure = failureOf(result.data.content);
    if (failure && expected?.(failure)) return undefined;
    const code = failure?.code;
    if (code === "thread_not_found" || code === "run_not_found")
      throw new CloudAgentRequestRejected("not_found");
    if (code && INVALID.has(code)) throw new CloudAgentRequestRejected("invalid");
    throw new Error("Cloud agent request failed");
  }
}

type Failure = { code: string; message: string };

/** T3 Code reports declared failures as `{_tag, code, message}` JSON text. */
function failureOf(content: unknown): Failure | undefined {
  const blocks = z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .safeParse(content);
  const text = blocks.data?.[0]?.text;
  try {
    return z
      .object({
        _tag: z.literal("OrchestratorMcpFailure"),
        code: z.string(),
        message: z.string().catch(""),
      })
      .safeParse(JSON.parse(text ?? "")).data;
  } catch {
    return undefined;
  }
}

/** Lets the caller read what happened after a request T3 Code refused before running it. */
function refused(error: unknown) {
  if (!(error instanceof CloudAgentRequestRejected) || error.reason !== "invalid") throw error;
}

/** A queue change refused because the run is no longer queued. */
function notQueued({ code }: Failure) {
  return code === "orchestration_error";
}

/** A launch refused only because the project has no default model. */
function needsModel({ code, message }: Failure) {
  return code === "invalid_request" && message.includes("modelSelection");
}

function statusOf(status: string): CloudAgentStatus {
  if (status === "completed" || status === "idle") return "finished";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "interrupted" || status === "rolled_back")
    return "cancelled";
  return "running";
}

/** `host/path` without scheme, `.git` or trailing slash: T3 Code's canonical repository key. */
function repositoryKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}
