import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PageBrowserCommand,
  PageBrowserResult,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import {
  INVALID_BROWSER_REQUEST,
  SandboxDamagedError,
  SandboxRequestRejectedError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import { COMPUTER_UNRESPONSIVE_ERROR } from "@rakazo/contracts";
import {
  boundedSandboxCommandTimeoutMs,
  cancelResponseBody,
  requestDeadline,
  resolveSupervisorToken,
} from "@rakazo/core";
import { outgoingCorrelationHeaders } from "@rakazo/logging";
import {
  boundedComputerActions,
  clampRounded,
  computerObservation,
  normalizeWorkspacePath,
  workspaceCwd,
} from "./computer-support.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { isSandboxGoneError, sandboxNotFoundError } from "./sandbox-errors.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";
import { shouldSkipPortableWorkspaceFile } from "./workspace-save-policy.js";

export const MAX_SANDBOX_ERROR_RESPONSE_BYTES = 8 * 1024;
export const MAX_SANDBOX_SUCCESS_RESPONSE_BYTES = 16 * 1024 * 1024;
export const SCREEN_RELEASE_TIMEOUT_MS = 8_000;
/** How long a computer gets to run a trivial health check. */
export const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const HOME_UNWRITABLE = "unwritable";
const HOME_CHECK = ["/bin/sh", "-c", `test -w . || echo ${HOME_UNWRITABLE}`];
const SANDBOX_ERROR_RESPONSE_TIMEOUT_MS = 1_000;

function unwritableHome() {
  return new SandboxDamagedError({ cause: new Error("the computer cannot write its home folder") });
}
const SANDBOX_SUCCESS_RESPONSE_TIMEOUT_MS = 30_000;

async function safeBody(res: Response, signal?: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SANDBOX_ERROR_RESPONSE_BYTES) {
    cancelResponseBody(res);
    return "";
  }
  try {
    const readSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(SANDBOX_ERROR_RESPONSE_TIMEOUT_MS)])
      : AbortSignal.timeout(SANDBOX_ERROR_RESPONSE_TIMEOUT_MS);
    const bytes = await readBodyCapped(res, MAX_SANDBOX_ERROR_RESPONSE_BYTES, readSignal);
    return new TextDecoder().decode(bytes).slice(0, 200);
  } catch {
    return "";
  }
}

async function readSandboxJson<T>(
  res: Response,
  signal: AbortSignal,
  maxBytes = MAX_SANDBOX_SUCCESS_RESPONSE_BYTES,
): Promise<T> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelResponseBody(res);
    throw new Error(`sandbox response exceeds ${maxBytes} bytes`);
  }
  const readSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(SANDBOX_SUCCESS_RESPONSE_TIMEOUT_MS),
  ]);
  let bytes: Uint8Array;
  try {
    bytes = await readBodyCapped(res, maxBytes, readSignal);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error(`sandbox response exceeds ${maxBytes} bytes`, { cause: error });
    }
    throw error;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function encodedFileResponseLimit(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return MAX_SANDBOX_SUCCESS_RESPONSE_BYTES;
  // An explicit file limit is already the caller's memory-safety contract.
  // Account for base64 expansion plus the small JSON envelope without applying
  // the generic response cap, which would reject valid files above ~12 MiB.
  return Math.ceil(maxBytes / 3) * 4 + 1024;
}

/** Named so the API's isSandboxGoneError recognizes it and clears the dead computer row. */
function sandboxGoneError(computer: ComputerRef): Error {
  return sandboxNotFoundError(`sandbox ${computer.id} is not running`);
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly supervisorToken: string;
  /**
   * Computers that left a command unanswered, checked before their next use. The value counts
   * stalls, so a check that started before a newer stall does not clear it.
   */
  private readonly unresponsive = new Map<string, number>();
  private stalls = 0;
  /** One check per computer, shared by every caller that needs it meanwhile. */
  private readonly healthChecks = new Map<string, Promise<void>>();

  constructor(
    private readonly supervisorUrl: string,
    supervisorToken?: string,
  ) {
    this.supervisorToken = supervisorToken ?? resolveSupervisorToken(process.env);
  }

  describe() {
    return {
      id: "docker",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: true,
      },
    };
  }

  private url(path: string) {
    return `${this.supervisorUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(context: AdapterContext, botId?: string) {
    return {
      authorization: `Bearer ${this.supervisorToken}`,
      "x-rakazo-space-id": context.spaceId,
      ...outgoingCorrelationHeaders(),
      ...(botId ? { "x-rakazo-bot-id": botId } : {}),
      ...(context.botId ? { "x-rakazo-screen-id": context.botId } : {}),
      ...(context.screenLeaseId ? { "x-rakazo-screen-lease-id": context.screenLeaseId } : {}),
      ...(context.cancelRunWork ? { "x-rakazo-cancel-run-work": "1" } : {}),
    };
  }

  async provision(
    request: { botId: string; homePath: string; timezone?: string; language?: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const res = await fetch(this.url("/computers"), {
      method: "POST",
      headers: { ...this.headers(context, request.botId), "content-type": "application/json" },
      body: JSON.stringify({
        botId: request.botId,
        homePath: request.homePath,
        spaceId: context.spaceId,
        timezone: request.timezone,
        language: request.language,
      }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      // Match team-screen style: regex on safeBody (already ≤200 chars), not JSON.parse.
      const limitError = detail.match(/Computer limit reached for space \(max: \d+\)/i)?.[0];
      if (res.status === 429 && limitError) {
        throw new Error(limitError);
      }
      throw new Error(`sandbox provision failed: ${res.status} ${detail}`.trim());
    }
    const body = await readSandboxJson<{ id: string; resumed?: boolean; started?: boolean }>(
      res,
      context.signal,
    );
    return {
      id: body.id,
      botId: request.botId,
      kind: "docker",
      providerRef: body.id,
      fresh: body.resumed !== true,
      ...(body.started === true ? { started: true } : {}),
    };
  }

  /** A command the computer never finished answering, unless the caller stopped waiting itself. */
  private unansweredCommand(computer: ComputerRef, error: unknown, callerSignal: AbortSignal) {
    if (callerSignal.aborted) return error;
    this.stalls += 1;
    this.unresponsive.set(computer.id, this.stalls);
    return new SandboxUnresponsiveError(COMPUTER_UNRESPONSIVE_ERROR, { cause: error });
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind !== "docker") return false;
    return (await this.containerRunning(computer, context)) === true;
  }

  /**
   * A computer must be able to write its home folder before it is used: a container started
   * while the host could not see that folder runs with an empty one it cannot write. A computer
   * that left a command unanswered must also answer this one in time. One that fails either is
   * reported damaged, which has it stopped and started again.
   */
  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    if (context.signal?.aborted) return withAbort(Promise.resolve(), context.signal);
    let check = this.healthChecks.get(computer.id);
    if (!check) {
      const started = this.unresponsive.has(computer.id)
        ? this.checkHealth(computer, context)
        : this.checkWritableHome(computer, context);
      check = started.finally(() => {
        if (this.healthChecks.get(computer.id) === check) this.healthChecks.delete(computer.id);
      });
      this.healthChecks.set(computer.id, check);
      // The check can fail after every caller has stopped waiting.
      void check.catch(() => undefined);
    }
    await withAbort(check, context.signal);
  }

  private async checkWritableHome(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const signal = AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS);
    if (!(await this.checkHome(computer, { ...context, signal })).writable) throw unwritableHome();
  }

  /** Runs on its own deadline, so one caller stopping does not decide the others' check. */
  private async checkHealth(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const stall = this.unresponsive.get(computer.id);
    const signal = AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS);
    let home: { ran: boolean; writable: boolean };
    try {
      home = await this.checkHome(computer, { ...context, signal });
    } catch (error) {
      if (isSandboxGoneError(error)) throw error;
      throw new SandboxDamagedError({ cause: error });
    }
    if (!home.writable) throw unwritableHome();
    if (!home.ran) throw new SandboxDamagedError();
    if (this.unresponsive.get(computer.id) === stall) this.unresponsive.delete(computer.id);
  }

  /**
   * Whether a command ran, and whether the home folder every command starts in can be written.
   * Only the command's own answer counts as unwritable; a command that could not run says nothing
   * about the folder.
   */
  private async checkHome(computer: ComputerRef, context: AdapterContext) {
    let code: number | undefined;
    let answer = "";
    for await (const event of this.execute(
      computer,
      { argv: HOME_CHECK, timeoutMs: HEALTH_CHECK_TIMEOUT_MS },
      context,
    )) {
      if (event.type === "exit") code = event.code;
      else if (event.type === "stdout") answer += event.data;
    }
    return { ran: code === 0, writable: code !== 0 || answer.trim() !== HOME_UNWRITABLE };
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    // The supervisor enforces timeoutMs; this only ends a command it never answers for.
    const streamSignal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs + 15_000)]);
    const res = await fetch(this.url(`/computers/${computer.id}/exec`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        argv: sandboxCommandArgv(request),
        cwd: workspaceCwd("/home/rakazo", request.cwd),
        timeoutMs,
      }),
      signal: streamSignal,
    }).catch((error) => {
      throw this.unansweredCommand(computer, error, context.signal);
    });
    if (!res.ok) {
      cancelResponseBody(res);
      // A stopped container cannot run anything; report it gone so the computer is booted again.
      if ((await this.containerRunning(computer, context)) === false) {
        throw sandboxGoneError(computer);
      }
      yield { type: "stderr", data: `exec failed: ${res.status}` };
      yield { type: "exit", code: 1 };
      return;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("ndjson")) {
      // The command may keep running after the first bytes (device-code logins).
      // Don't apply the short JSON body timeout.
      try {
        yield* readNdjsonProcessEvents(res, streamSignal);
      } catch (error) {
        throw this.unansweredCommand(computer, error, context.signal);
      }
      return;
    }
    const body = await readSandboxJson<{ stdout: string; stderr: string; code: number }>(
      res,
      context.signal,
    );
    // The supervisor answers a missing container with Docker's 404 as the command's stderr.
    if (body.code !== 0 && /no such container/i.test(body.stderr)) {
      throw sandboxGoneError(computer);
    }
    if (body.stdout) yield { type: "stdout", data: body.stdout };
    if (body.stderr) yield { type: "stderr", data: body.stderr };
    yield { type: "exit", code: body.code };
  }

  async pageBrowser(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<PageBrowserResult> {
    const res = await fetch(this.url(`/computers/${computer.id}/browser`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify(request),
      redirect: "error",
      signal: context.signal,
    });
    if (!res.ok) {
      // Only the supervisor's own refusal of a malformed request proves nothing ran.
      if (res.status === 400) {
        const refused = await readSandboxJson<{ code?: unknown }>(res, context.signal, 4096).catch(
          () => undefined,
        );
        if (refused?.code === INVALID_BROWSER_REQUEST) throw new SandboxRequestRejectedError();
      }
      throw new Error(`page browser failed: ${res.status}`);
    }
    return readSandboxJson<PageBrowserResult>(res, context.signal, 512 * 1024);
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    if (request.interactive && !request.controlToken) {
      throw new Error("interactive screen requires a control token");
    }
    const res = await fetch(this.url(`/computers/${computer.id}/screen-mode`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        interactive: request.interactive === true,
        controlToken: request.controlToken,
        revokeControl: false,
      }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      if (/cannot allocate another screen/i.test(detail)) {
        const limit = /\(limit (\d+)\)/i.exec(detail)?.[1];
        throw new Error(
          `This Team Computer cannot allocate another screen${limit ? ` (limit ${limit})` : ""}.`,
        );
      }
      // A container that stopped under a "running" row (host reboot, docker stop) has no
      // screen to show; report it gone so the caller offers a boot instead of a blank error.
      if ((await this.containerRunning(computer, context)) === false) {
        throw sandboxGoneError(computer);
      }
      if (request.interactive) {
        throw new Error(`sandbox screen mode failed: ${res.status} ${detail}`.trim());
      }
      return { url: null, mimeType: "text/html", close: async () => undefined };
    }
    const body = await readSandboxJson<{ screenUrl?: string }>(res, context.signal);
    if (request.interactive && !body.screenUrl) {
      throw new Error("control screen failed to start");
    }
    return {
      url: body.screenUrl ?? this.url(`/computers/${computer.id}/screen`),
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const res = await fetch(this.url(`/computers/${computer.id}/terminal`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({ controlToken: request.controlToken, cwd: request.cwd ?? "" }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`sandbox terminal failed: ${res.status} ${detail}`.trim());
    }
    const body = await readSandboxJson<{ terminalUrl: string }>(res, context.signal);
    return { url: body.terminalUrl };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    const res = await fetch(this.url(`/computers/${computer.id}/screen-mode`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({ interactive, controlToken }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      // A deleted Docker container is reported by the supervisor as a 400
      // containing Docker's 404. Preserve the gone signal so lease cleanup can
      // clear the stale providerRef instead of retrying the same dead container.
      if (/no such container/i.test(detail)) throw sandboxGoneError(computer);
      if ((await this.containerRunning(computer, context)) === false) {
        // The screen died with its container: a revoke has nothing left to release, while
        // an interactive grant needs the computer booted first.
        if (!interactive) return;
        throw sandboxGoneError(computer);
      }
      throw new Error(`sandbox screen mode failed: ${res.status} ${detail}`.trim());
    }
  }

  /**
   * The supervisor's view of the container, or null when it cannot say. Only a successful
   * inspection counts: the supervisor answers 404 for any lookup failure, so that and transport
   * errors leave the caller on its previous behaviour rather than starting a recovery.
   */
  private async containerRunning(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<boolean | null> {
    try {
      const res = await fetch(this.url(`/computers/${computer.id}`), {
        method: "GET",
        headers: this.headers(context, computer.botId),
        signal: context.signal,
      });
      if (!res.ok) {
        cancelResponseBody(res);
        return null;
      }
      const body = await readSandboxJson<{ running?: boolean }>(res, context.signal);
      return body.running === true;
    } catch (error) {
      if (context.signal.aborted) throw error;
      return null;
    }
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}/input`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({ input, leaseId: lease.leaseId }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`sandbox input failed: ${res.status} ${detail}`.trim());
    }
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const res = await fetch(this.url(`/computers/${computer.id}/observe`), {
      method: "POST",
      headers: this.headers(context, computer.botId),
      signal: context.signal,
    });
    if (!res.ok)
      throw new Error(
        `sandbox observation failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    const body = await readSandboxJson<{
      image: string;
      mimeType: "image/png" | "image/jpeg";
      width: number;
      height: number;
      cursor?: { x: number; y: number };
      activeWindow?: { id: string; title?: string };
    }>(res, context.signal);
    return computerObservation(Uint8Array.from(Buffer.from(body.image, "base64")), {
      mimeType: body.mimeType,
      width: body.width,
      height: body.height,
      cursor: body.cursor,
      activeWindow: body.activeWindow,
    });
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const actions = boundedComputerActions(request.actions);
    const res = await fetch(this.url(`/computers/${computer.id}/actions`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        actions,
        observe: request.observe,
        settleMs: clampRounded(request.settleMs ?? 0, 0, 5_000),
      }),
      signal: context.signal,
    });
    if (!res.ok)
      throw new Error(
        `sandbox action failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    const body = await readSandboxJson<{
      completed: number;
      observation?: {
        image: string;
        mimeType: "image/png" | "image/jpeg";
        width: number;
        height: number;
        cursor?: { x: number; y: number };
        activeWindow?: { id: string; title?: string };
      };
    }>(res, context.signal);
    return {
      completed: body.completed,
      ...(body.observation
        ? {
            observation: computerObservation(
              Uint8Array.from(Buffer.from(body.observation.image, "base64")),
              body.observation,
            ),
          }
        : {}),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const path = normalizeWorkspacePath(directory);
    const res = await fetch(
      this.url(`/computers/${computer.id}/files?path=${encodeURIComponent(path)}&mode=list`),
      { headers: this.headers(context, computer.botId), signal: context.signal },
    );
    if (!res.ok) throw new Error(`sandbox file listing failed: ${res.status}`);
    return readSandboxJson<ComputerFileEntry[]>(res, context.signal);
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const path = normalizeWorkspacePath(filePath);
    const maxBytes = options?.maxBytes;
    const res = await fetch(
      this.url(
        `/computers/${computer.id}/files?path=${encodeURIComponent(path)}&mode=read${maxBytes === undefined ? "" : `&maxBytes=${maxBytes}`}`,
      ),
      { headers: this.headers(context, computer.botId), signal: context.signal },
    );
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`sandbox file read failed: ${res.status} ${detail}`.trim());
    }
    const body = await readSandboxJson<{ content: string }>(
      res,
      context.signal,
      encodedFileResponseLimit(maxBytes),
    );
    return Uint8Array.from(Buffer.from(body.content, "base64"));
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const res = await fetch(this.url(`/computers/${computer.id}/files`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        path: normalizeWorkspacePath(file.path),
        content: Buffer.from(file.content).toString("base64"),
        executable: file.executable === true,
      }),
      signal: context.signal,
    });
    if (!res.ok) throw new Error(`sandbox file write failed: ${res.status}`);
  }

  async *exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    yield* this.walkWorkspace(computer, "", context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) {
      if (shouldSkipPortableWorkspaceFile(file.path)) continue;
      await this.writeFile(computer, file, context);
    }
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return { id: `docker-snap-${computer.id}`, createdAt: new Date().toISOString() };
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    if (!context.botId) return;
    // Run cancellation must not skip cleanup, but cleanup still needs its own deadline.
    const deadline = requestDeadline(SCREEN_RELEASE_TIMEOUT_MS, "sandbox screen release timed out");
    try {
      const res = await withAbort(
        fetch(this.url(`/computers/${computer.id}/screen`), {
          method: "DELETE",
          headers: {
            ...this.headers(context, computer.botId),
            ...(context.keepScreenWarm && !context.cancelRunWork && !context.signal.aborted
              ? { "x-rakazo-preserve-screen": "1" }
              : {}),
          },
          signal: deadline.signal,
        }),
        deadline.signal,
      );
      if (res.ok) return;
      const body = await safeBody(res, deadline.signal);
      // 404 is only an already-missing computer. A teardown failure, including
      // one wrongly labeled 404, must stay a release failure.
      if (res.status === 404 && body.includes("computer not found")) return;
      throw new Error(`sandbox screen release failed: ${res.status} ${body}`.trim());
    } finally {
      deadline.dispose();
    }
  }

  async stop(
    computer: ComputerRef,
    context: AdapterContext,
    options?: { discardUnsaved?: boolean },
  ): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}/stop`), {
      method: "POST",
      headers: {
        ...this.headers(context, computer.botId),
        ...(options?.discardUnsaved ? { "x-rakazo-discard-unsaved": "1" } : {}),
      },
      signal: context.signal,
    });
    if (res.ok || res.status === 404) this.unresponsive.delete(computer.id);
    // 404 means the supervisor no longer has the container, which is the state we want.
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `sandbox stop failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    }
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}`), {
      method: "DELETE",
      headers: this.headers(context, computer.botId),
      signal: context.signal,
    });
    if (res.ok || res.status === 404) this.unresponsive.delete(computer.id);
    if (res.ok) return;
    const body = await safeBody(res, context.signal);
    // Only the supervisor's missing-computer answer means already deleted.
    if (res.status === 404 && body.includes("computer not found")) return;
    throw new Error(`sandbox destroy failed: ${res.status} ${body}`.trim());
  }

  private async *walkWorkspace(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const entries = (await this.listFiles(computer, directory, context)).filter(
      (entry) => !shouldSkipPortableWorkspaceFile(entry.path, entry.kind === "dir"),
    );
    for (let index = 0; index < entries.length; ) {
      const entry = entries[index]!;
      if (entry.kind === "dir") {
        yield* this.walkWorkspace(computer, entry.path, context);
        index += 1;
        continue;
      }
      const files = [];
      while (index < entries.length && entries[index]?.kind === "file" && files.length < 8) {
        files.push(entries[index]!);
        index += 1;
      }
      const batch = await Promise.all(
        files.map(async (file) => ({
          path: file.path,
          content: await this.readFile(computer, file.path, context),
          executable: file.executable,
        })),
      );
      for (const file of batch) yield file;
    }
  }
}

async function* readNdjsonProcessEvents(
  res: Response,
  signal: AbortSignal,
): AsyncIterable<ProcessEvent> {
  const reader = res.body?.getReader();
  if (!reader) {
    yield { type: "stderr", data: "exec failed: empty response\n" };
    yield { type: "exit", code: 1 };
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let sawExit = false;
  try {
    while (!sawExit) {
      if (signal.aborted) throw signal.reason ?? new Error("command aborted");
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SANDBOX_SUCCESS_RESPONSE_BYTES) {
        yield { type: "stderr", data: "exec failed: response too large\n" };
        yield { type: "exit", code: 1 };
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = takeProcessLines(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.type === "exit") sawExit = true;
        yield event;
      }
    }
    buffer += decoder.decode();
    if (!sawExit && buffer.trim()) {
      const parsed = takeProcessLines(`${buffer}\n`);
      for (const event of parsed.events) {
        if (event.type === "exit") sawExit = true;
        yield event;
      }
    }
    if (!sawExit) yield { type: "exit", code: 1 };
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function takeProcessLines(buffer: string): { events: ProcessEvent[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: ProcessEvent[] = [];
  for (const line of lines) {
    const event = parseProcessLine(line);
    if (event) events.push(event);
  }
  return { events, rest };
}

function parseProcessLine(line: string): ProcessEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { type: "stderr", data: `${trimmed}\n` };
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as { type?: unknown; data?: unknown; code?: unknown };
  if (record.type === "stdout" && typeof record.data === "string") {
    return { type: "stdout", data: record.data };
  }
  if (record.type === "stderr" && typeof record.data === "string") {
    return { type: "stderr", data: record.data };
  }
  if (record.type === "exit" && typeof record.code === "number" && Number.isFinite(record.code)) {
    return { type: "exit", code: record.code };
  }
  return undefined;
}
