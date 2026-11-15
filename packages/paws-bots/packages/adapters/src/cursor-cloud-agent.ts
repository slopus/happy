import { createHash } from "node:crypto";
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
import { readBodyCapped } from "./web-ssrf.js";

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  status: z.string(),
  url: z.string().optional(),
  latestRunId: z.string().optional(),
});
const runSchema = z.object({
  id: z.string().min(1),
  // Unknown future statuses read as running rather than wedging the poll.
  status: z.string(),
  git: z
    .object({
      branches: z.array(z.object({ branch: z.string().optional(), prUrl: z.string().optional() })),
    })
    .optional(),
});

export interface CursorCloudAgentOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Cursor v1 wire formats and credential handling stay inside this adapter. */
export class CursorCloudAgentProvider implements CloudAgentProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CursorCloudAgentOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("CURSOR_API_KEY is required");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  describe() {
    return {
      id: "cursor",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { launch: true, reply: true, cancel: true, offline: false },
    };
  }

  async launch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    // Cursor's client-supplied id makes create replay safe after a lost response.
    const id = cursorAgentId(request.idempotencyKey);
    const response = await this.request(
      "POST",
      "/v1/agents",
      {
        agentId: id,
        prompt: {
          text: request.prompt,
          ...(request.images?.length ? { images: request.images } : {}),
        },
        ...(request.repository ? { repos: [{ url: request.repository }] } : {}),
        ...(request.openPr !== undefined ? { autoCreatePR: request.openPr } : {}),
      },
      request.signal ?? context.signal,
      true,
    );
    if (response === null) {
      // A duplicate create may precede read visibility. Failure to observe it
      // is still ambiguous and must not terminate recovery of accepted work.
      try {
        return await this.get(id, context);
      } catch {
        throw new Error("Cloud agent create is awaiting reconciliation");
      }
    }
    const parsed = z.object({ agent: agentSchema, run: runSchema }).safeParse(response);
    if (!parsed.success || parsed.data.agent.id !== id)
      throw new Error("Invalid cloud agent response");
    return this.handle(parsed.data.agent, parsed.data.run);
  }

  async get(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const agent = await this.agent(id, context.signal);
    const path = `/v1/agents/${encodeURIComponent(id)}/runs`;
    if (!runId) {
      // The newest-first run list, not agent metadata, says whether a follow-up was accepted.
      const parsed = z
        .object({ items: z.array(runSchema) })
        .safeParse(await this.request("GET", `${path}?limit=1`, undefined, context.signal));
      if (!parsed.success) throw new Error("Invalid cloud agent run response");
      const [run] = parsed.data.items;
      if (!run) throw new Error("Cloud agent has no run to inspect");
      return this.handle(agent, run);
    }
    const parsed = runSchema.safeParse(
      await this.request("GET", `${path}/${encodeURIComponent(runId)}`, undefined, context.signal),
    );
    if (!parsed.success || parsed.data.id !== runId)
      throw new Error("Invalid cloud agent run response");
    return this.handle(agent, parsed.data);
  }

  async reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    // Read metadata first: no fallible GET after a successful mutating POST. A
    // failed read means nothing was sent, so the caller can safely resend.
    const agent = await this.agent(id, request.signal ?? context.signal).catch((error) => {
      if (error instanceof CloudAgentRequestRejected || error instanceof CloudAgentRetryLater)
        throw error;
      throw new CloudAgentRetryLater("unavailable");
    });
    if (agent.status === "ARCHIVED") throw new CloudAgentRequestRejected("expired");
    const response = await this.request(
      "POST",
      `/v1/agents/${encodeURIComponent(id)}/runs`,
      {
        prompt: {
          text: request.prompt,
          ...(request.images?.length ? { images: request.images } : {}),
        },
      },
      request.signal ?? context.signal,
      true,
    );
    // Follow-ups have no idempotency key. A busy agent may already be running an
    // earlier attempt of this one, so the caller must observe the run list, not resend.
    if (response === null) throw new Error("Cloud agent is busy with another run");
    const parsed = z.object({ run: runSchema }).safeParse(response);
    if (!parsed.success) throw new Error("Invalid cloud agent follow-up response");
    return this.handle(agent, parsed.data.run);
  }

  async cancel(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const snapshot = await this.get(id, context, runId);
    if (snapshot.status !== "running") return snapshot;
    // 409 means the run already ended; the read below observes how.
    await this.request(
      "POST",
      `/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(snapshot.latestRunId!)}/cancel`,
      {},
      context.signal,
      true,
    );
    // Cancellation may still be in progress. Never report success before observing it.
    return this.get(id, context, snapshot.latestRunId);
  }

  private async agent(id: string, signal: AbortSignal) {
    const parsed = agentSchema.safeParse(
      await this.request("GET", `/v1/agents/${encodeURIComponent(id)}`, undefined, signal),
    );
    if (!parsed.success || parsed.data.id !== id) throw new Error("Invalid cloud agent response");
    return parsed.data;
  }

  private handle(
    agent: z.infer<typeof agentSchema>,
    run: z.infer<typeof runSchema>,
  ): CloudAgentSnapshot {
    const status: CloudAgentStatus =
      run.status === "FINISHED"
        ? "finished"
        : run.status === "CANCELLED"
          ? "cancelled"
          : run.status === "ERROR"
            ? "failed"
            : run.status === "EXPIRED" || agent.status === "ARCHIVED"
              ? "expired"
              : "running";
    const branch = run.git?.branches[0];
    return {
      id: agent.id,
      title: agent.name || "Cloud agent",
      status,
      url: agent.url || `https://cursor.com/agents/${encodeURIComponent(agent.id)}`,
      latestRunId: run.id,
      ...(branch?.branch ? { branch: branch.branch } : {}),
      ...(branch?.prUrl ? { prUrl: branch.prUrl } : {}),
    };
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    allowConflict = false,
  ): Promise<unknown> {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const response = await this.fetchImpl(`https://api.cursor.com${path}`, {
      method,
      redirect: "error",
      signal: boundedSignal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (allowConflict && response.status === 409) return null;
      if (response.status === 404) throw new CloudAgentRequestRejected("not_found");
      if ([400, 409, 422].includes(response.status)) throw new CloudAgentRequestRejected();
      if (response.status === 401 || response.status === 403)
        throw new CloudAgentRetryLater("credential");
      if (response.status === 429)
        throw new CloudAgentRetryLater("rate_limited", retryAfterMs(response.headers));
      throw new Error(`Cloud agent request failed (${response.status})`);
    }
    if (response.status === 204) {
      void response.body?.cancel().catch(() => undefined);
      return {};
    }
    const bytes = await readBodyCapped(response, 1_000_000, boundedSignal);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Invalid cloud agent response");
    }
  }
}

/** Retry-After is delta-seconds or an HTTP date. */
function retryAfterMs(headers: Headers) {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

export function cursorAgentId(key: string) {
  const bytes = createHash("sha256").update(key).digest();
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
