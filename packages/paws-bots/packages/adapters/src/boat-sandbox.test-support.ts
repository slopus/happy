import type {
  ApiResponse,
  ArtifactRequest,
  AttachCommandRequest,
  Command200Response,
  CommandAttachFrame,
  CommandOperationRequest,
  CommandResponse,
  CommandStatusRequest,
  CommandStatusResponse,
  CreateDownloadUrlRequest,
  CreateRequest,
  CreateSandboxRequest,
  CreateSandboxResponse,
  CreateUploadUrlRequest,
  FileUrlResponse,
  FileWriteResponse,
  GetRequest,
  GetSavedSnapshotRequest,
  HostPortOperationRequest,
  HostPortResponse,
  Recover200Response,
  RecoverRequest,
  ResumeOperationRequest,
  Sandbox,
  SandboxActionResponse,
  SandboxInfoResponse,
  SandboxStateEnum,
  SandboxTypeEnum,
  SavedSnapshot,
  SavedSnapshotInfoResponse,
  SavedSnapshotSavingResponse,
  SaveSavedSnapshotRequest,
  StopOperationRequest,
  UpdateRequest,
  WriteFileRequest,
} from "@boatdev/sdk";
import { ResponseError } from "@boatdev/sdk";
import { parse } from "shell-quote";
import { vi } from "vitest";
import type { BoatSandboxSdk } from "./boat-sandbox.js";
import {
  BOAT_COMPUTER_SNAPSHOT,
  BOAT_WRITABLE_WORKSPACE_COMMAND,
  BoatSandboxProvider,
} from "./boat-sandbox.js";
import { shouldSkipPortableWorkspaceFile } from "./computer-workspace.js";
import { desktopCommandResponder, simpleCommand } from "./linux-desktop.test-support.js";
import { workspaceArchive } from "./workspace-archive.test-support.js";

/** How a sandbox in the `error` state answers `POST /recover`, per the Boat API reference. */
export type BoatRecovery =
  | "recovers"
  | "stuck"
  | "no_machine"
  | "too_soon"
  | "sandbox_is_reachable"
  | "recover_unsupported"
  | "reset_failed";

interface FakeFile {
  content: Uint8Array;
  executable: boolean;
  /** Like a git pack: Boat's file API cannot overwrite it. */
  readOnly?: boolean;
}

interface FakeSandbox {
  sandbox: Sandbox;
  env: Record<string, string>;
  files: Map<string, FakeFile>;
  /** The disk as of Boat's last good snapshot. */
  snapshot: Map<string, FakeFile>;
  recovery: BoatRecovery;
  /** Set while Boat's storage under the sandbox is broken; whether a resume mends it. */
  damaged?: "resume_heals" | "persists";
}

const BOAT_WORKSPACE = "/home/user/rakazo-home";

/** Every fake's download URLs, so a test can serve them without holding the fake API. */
const downloadServers = new Map<string, FakeBoatApi>();
let downloadCount = 0;

/**
 * What a fake sandbox serves at `url`, or nothing when no fake handed that URL out. Each URL is
 * served once, so finished tests do not keep their fakes and files alive.
 */
export function serveFakeBoatDownload(url: string): Response | undefined {
  const server = downloadServers.get(url);
  downloadServers.delete(url);
  return server?.serveDownload(url);
}

/**
 * Serves fake Boat download URLs through `fetch` until the returned restore runs, passing every
 * other request on, for tests that drive a fake Boat provider beside real local servers.
 */
export function routeFakeBoatDownloads(): () => void {
  const original = globalThis.fetch;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async (input, init) => serveFakeBoatDownload(String(input)) ?? original(input, init),
    );
  return () => spy.mockRestore();
}

/** Boat's artifact route refuses larger files; download URLs have no size limit. */
export const BOAT_ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;

const RUNNABLE = new Set<SandboxStateEnum>(["ready", "idle", "running"]);
// Where each in-flight state settles by the next read.
const SETTLES_TO: Partial<Record<SandboxStateEnum, SandboxStateEnum>> = {
  init: "ready",
  provisioning: "ready",
  provisioned: "ready",
  cloning: "ready",
  archiving: "archived",
};

/**
 * In-memory Boat API with the documented lifecycle states and error codes. It answers like the
 * SDK, throwing raw `ResponseError`s, so tests exercise the real adapter's error handling. Its
 * shell understands only what the adapter sends: workspace listings, chmod, and simple commands.
 */
export class FakeBoatApi implements BoatSandboxSdk {
  private readonly sandboxes = new Map<string, FakeSandbox>();
  private readonly desktop = desktopCommandResponder();
  private readonly detached = new Map<number, { result: CommandResponse; endsAt: number }>();
  /** How long a detached command runs before it exits. */
  detachedRunMs = 0;
  /** Connections to a detached command's output that end in `reconnect` before one sees it exit. */
  attachReconnects = 0;
  /** Answer attaches as a sandbox agent too old to stream output does. */
  attachOutdated = false;
  /** Answers a command that reads its stdin from a private file, given that file's content. */
  withInput: (command: string, input: string) => Partial<CommandResponse> = () => ({});
  private created = 0;
  private readonly uploads = new Map<string, { sandboxId: string; path: string }>();
  private readonly downloads = new Map<string, { sandboxId: string; path: string }>();
  private startsExhausted = false;
  private requestLimitSeconds?: number;
  /** When each request that reached a sandbox or the account arrived. */
  readonly requestTimes: number[] = [];
  private rejectAll?: { status: number; code: string; message: string };
  readonly creates: CreateSandboxRequest[] = [];
  /** Machine types the account may start; Boat refuses the rest as needing a higher plan. */
  availableTypes = new Set<SandboxTypeEnum>(["small", "default", "large"]);
  /** Machine types a sandbox's files would not fit, so a resume onto them is refused. */
  tooSmallTypes = new Set<SandboxTypeEnum>();
  /** Saved snapshots; the current computer snapshot is ready unless a test removes it. */
  readonly savedSnapshots = new Map<string, SavedSnapshot>([
    [
      BOAT_COMPUTER_SNAPSHOT,
      {
        name: BOAT_COMPUTER_SNAPSHOT,
        status: "ready",
        sourceSandboxId: "bx_build",
        createdAt: new Date(0),
      },
    ],
  ]);

  /** Puts a sandbox in any documented state; in-flight states settle by the next read. */
  setState(id: string, state: SandboxStateEnum): void {
    this.require(id).sandbox.state = state;
  }

  /** Stops the sandbox and deletes its snapshot data, as Boat does 14 days after a stop. */
  expire(id: string): void {
    const box = this.require(id);
    box.sandbox.state = "archived";
    box.sandbox.dataExpiredAt = new Date();
    box.sandbox.snapshotAvailable = false;
  }

  fail(id: string, recovery: BoatRecovery = "recovers"): void {
    const box = this.require(id);
    box.sandbox.state = "error";
    box.recovery = recovery;
  }

  /**
   * Boat's restore layer broke under a running sandbox: programs no longer start, the restore
   * never finishes, and every save fails, so a plain stop is refused. A forced stop keeps the
   * last good snapshot; resuming that heals the sandbox unless the damage `persists`.
   */
  damage(id: string, damaged: "resume_heals" | "persists" = "resume_heals"): void {
    const box = this.require(id);
    box.damaged = damaged;
    box.sandbox.hydrated = false;
    box.sandbox.lastSnapshotStatus = "failed";
  }

  /** Boat reports a cancelled sandbox once, then answers 404. */
  cancel(id: string): void {
    this.require(id).sandbox.state = "cancelled";
  }

  delete(id: string): void {
    this.sandboxes.delete(id);
  }

  /** Refuses the next request as over Boat's per-IP request limit, asking for a wait. */
  limitRequests(retryAfterSeconds: number): void {
    this.requestLimitSeconds = retryAfterSeconds;
  }

  /** Refuses every later create and resume as over the account's machine-start limit. */
  rateLimit(): void {
    this.startsExhausted = true;
  }

  unauthorized(): void {
    this.rejectAll = { status: 401, code: "unauthorized", message: "Invalid bearer token" };
  }

  state(id: string): SandboxStateEnum | undefined {
    return this.sandboxes.get(id)?.sandbox.state;
  }

  files(id: string): Map<string, FakeFile> {
    return this.require(id).files;
  }

  /** Refuses a machine type the account's plan does not include, as Boat does. */
  private checkType(type: SandboxTypeEnum | undefined): void {
    if (type && !this.availableTypes.has(type)) {
      throw boatError(403, "machine_class_plan_required", "This machine type needs a higher plan");
    }
  }

  async create(request: CreateRequest = {}): Promise<CreateSandboxResponse> {
    this.start();
    this.checkType(request.createSandboxRequest?.type);
    const from = request.createSandboxRequest?.from;
    if (from && this.savedSnapshots.get(from)?.status !== "ready") {
      throw boatError(404, "snapshot_not_found", "Snapshot not found");
    }
    this.creates.push({ ...request.createSandboxRequest });
    const id = `bx_fake${++this.created}`;
    const sandbox: Sandbox = {
      id,
      name: "Fake Boat",
      state: "ready",
      type: request.createSandboxRequest?.type ?? "default",
      dataExpiredAt: null,
      desktopAvailable: true,
      snapshotAvailable: false,
    };
    this.sandboxes.set(id, {
      sandbox,
      env: { ...request.createSandboxRequest?.env },
      files: new Map(),
      snapshot: new Map(),
      recovery: "recovers",
    });
    return {
      ok: true,
      type: "sandbox.created",
      status: "ready",
      ttlSeconds: request.createSandboxRequest?.ttlSeconds ?? null,
      sandbox: { ...sandbox },
    };
  }

  async get({ sandboxId }: GetRequest): Promise<SandboxInfoResponse> {
    const box = this.require(sandboxId);
    const response = this.info(box);
    const settled = SETTLES_TO[box.sandbox.state];
    if (settled) box.sandbox.state = settled;
    if (box.sandbox.state === "cancelled") this.sandboxes.delete(sandboxId);
    return response;
  }

  /** A save settles to `ready` by the next read. */
  async getSavedSnapshot({ name }: GetSavedSnapshotRequest): Promise<SavedSnapshotInfoResponse> {
    this.check();
    const snapshot = this.savedSnapshots.get(name);
    if (!snapshot) throw boatError(404, "snapshot_not_found", "Snapshot not found");
    const response = { ok: true, type: "snapshot.saved.info" as const, snapshot: { ...snapshot } };
    if (snapshot.status === "saving") snapshot.status = "ready";
    return response;
  }

  async saveSavedSnapshot({
    savedSnapshotSaveRequest,
  }: SaveSavedSnapshotRequest): Promise<SavedSnapshotSavingResponse> {
    const { sandboxId, name } = savedSnapshotSaveRequest;
    this.runnable(sandboxId);
    const snapshot: SavedSnapshot = {
      name,
      status: "saving",
      sourceSandboxId: sandboxId,
      createdAt: new Date(),
    };
    this.savedSnapshots.set(name, snapshot);
    return {
      ok: true,
      type: "snapshot.saved.saving",
      status: "saving",
      snapshot: { ...snapshot },
    };
  }

  async resume({
    sandboxId,
    resumeRequest,
  }: ResumeOperationRequest): Promise<SandboxActionResponse> {
    const box = this.require(sandboxId);
    if (box.sandbox.dataExpiredAt) {
      throw boatError(409, "snapshot_data_expired", "The snapshot data of this sandbox expired");
    }
    if (box.sandbox.state === "archived" || box.sandbox.state === "error") {
      this.start();
      const type = resumeRequest?.type;
      this.checkType(type);
      if (type && this.tooSmallTypes.has(type)) {
        throw boatError(409, "type_too_small", "The sandbox's data does not fit this type");
      }
      if (type) box.sandbox.type = type;
      box.sandbox.state = "ready";
      if (box.damaged === "resume_heals") {
        box.damaged = undefined;
        box.sandbox.hydrated = true;
        box.sandbox.lastSnapshotStatus = "completed";
      }
    }
    return this.action(box);
  }

  async recover({ sandboxId }: RecoverRequest): Promise<Recover200Response> {
    const box = this.require(sandboxId);
    if (box.sandbox.state !== "error") {
      throw boatError(409, "sandbox_is_reachable", "The sandbox answers normally");
    }
    switch (box.recovery) {
      case "recovers":
        box.sandbox.state = "ready";
        return { ok: true, type: "sandbox.recover", status: "recovering" };
      case "stuck":
        return { ok: true, type: "sandbox.recover", status: "recovering" };
      case "too_soon":
      case "sandbox_is_reachable":
        // An earlier recover brings it back.
        box.sandbox.state = "ready";
        throw boatError(409, box.recovery, "Recover refused");
      default:
        throw boatError(409, box.recovery, "Recover refused");
    }
  }

  /** Boat saved the sandbox's disk, as it does by itself while the sandbox runs. */
  saveSnapshot(id: string): void {
    this.snapshotDisk(this.require(id));
  }

  /**
   * A stop saves the disk first, and is refused while saves fail; a forced one keeps only the
   * last good snapshot.
   */
  async stop({ sandboxId, stopRequest }: StopOperationRequest): Promise<SandboxActionResponse> {
    const box = this.require(sandboxId);
    const at = new Date();
    if (box.damaged && !stopRequest?.force) {
      box.sandbox.stop = {
        id: "stop_fake",
        status: "failing",
        requestedAt: at,
        lastAttemptAt: at,
        error: "Refusing archive/stop: no successful snapshot in the last 30 minutes",
        endedAt: null,
      };
      return this.action(box);
    }
    box.sandbox.state = "archived";
    box.sandbox.stop = {
      id: "stop_fake",
      status: "completed",
      requestedAt: null,
      lastAttemptAt: at,
      error: null,
      endedAt: at,
    };
    if (!stopRequest?.force) this.snapshotDisk(box);
    else box.files = new Map(box.snapshot);
    return this.action(box);
  }

  private snapshotDisk(box: FakeSandbox): void {
    box.snapshot = new Map(box.files);
    box.sandbox.snapshotAvailable = true;
    box.sandbox.snapshotCompletedAt = new Date();
  }

  async update({ sandboxId }: UpdateRequest): Promise<SandboxInfoResponse> {
    return this.info(this.require(sandboxId));
  }

  async hostPort({
    sandboxId,
    hostPortRequest,
  }: HostPortOperationRequest): Promise<HostPortResponse> {
    this.runnable(sandboxId);
    return {
      ok: true,
      type: "sandbox.host",
      url: `https://${sandboxId}-${hostPortRequest.port}.on.boat.dev?_token=secret`,
    };
  }

  async createUploadUrl({
    sandboxId,
    fileUrlRequest,
  }: CreateUploadUrlRequest): Promise<FileUrlResponse> {
    this.runnable(sandboxId);
    const url = `https://uploads.on.boat.dev/file?token=fake-upload-${this.uploads.size}`;
    this.uploads.set(url, { sandboxId, path: fileUrlRequest.path });
    return {
      ok: true,
      type: "file.upload_url",
      method: "PUT",
      url,
      path: fileUrlRequest.path,
      expiresAt: new Date(Date.now() + 900_000),
    };
  }

  async createDownloadUrl({
    sandboxId,
    fileUrlRequest,
  }: CreateDownloadUrlRequest): Promise<FileUrlResponse> {
    this.runnable(sandboxId);
    const url = `https://downloads.on.boat.dev/file?token=fake-download-${++downloadCount}`;
    this.downloads.set(url, { sandboxId, path: fileUrlRequest.path });
    downloadServers.set(url, this);
    return {
      ok: true,
      type: "file.download_url",
      method: "GET",
      url,
      path: fileUrlRequest.path,
      expiresAt: new Date(Date.now() + 900_000),
    };
  }

  /** What the sandbox serves at a download URL. */
  serveDownload(url: string): Response {
    const download = this.downloads.get(url);
    if (!download) return new Response(null, { status: 404 });
    const file = this.runnable(download.sandboxId).files.get(download.path);
    if (!file) return new Response(null, { status: 404 });
    return new Response(Buffer.from(file.content));
  }

  completeUpload(url: string, content: Uint8Array): void {
    const upload = this.uploads.get(url);
    if (!upload) throw new Error("Unknown fake upload");
    this.runnable(upload.sandboxId).files.set(upload.path, { content, executable: false });
  }

  async writeFile({ sandboxId, fileWriteRequest }: WriteFileRequest): Promise<FileWriteResponse> {
    const box = this.runnable(sandboxId);
    const content = Uint8Array.from(Buffer.from(fileWriteRequest.content, "base64"));
    if (content.byteLength > 5 * 1024 * 1024) {
      throw boatError(400, "sandbox_direct_failed", "File exceeds the inline write limit");
    }
    if (box.files.get(fileWriteRequest.path)?.readOnly) {
      throw boatError(
        400,
        "sandbox_direct_failed",
        `EACCES: permission denied, open '${fileWriteRequest.path}'`,
      );
    }
    box.files.set(fileWriteRequest.path, { content, executable: false });
    return {
      ok: true,
      type: "file.written",
      success: true,
      path: fileWriteRequest.path,
      encoding: "base64",
      size: content.byteLength,
    };
  }

  async artifactRaw({ sandboxId, path }: ArtifactRequest): Promise<ApiResponse<Blob>> {
    const file = this.runnable(sandboxId).files.get(path);
    if (!file) throw boatError(404, "not_found", `File not found: ${path}`);
    if (file.content.byteLength > BOAT_ARTIFACT_MAX_BYTES) {
      throw boatError(
        400,
        "artifact_failed",
        `Artifact is too large (${file.content.byteLength} bytes > ${BOAT_ARTIFACT_MAX_BYTES})`,
      );
    }
    return {
      raw: new Response(Buffer.from(file.content), {
        headers: { "content-length": String(file.content.byteLength) },
      }),
      value: async () => new Blob([Buffer.from(file.content)]),
    };
  }

  async command({
    sandboxId,
    commandRequest,
  }: CommandOperationRequest): Promise<Command200Response> {
    const box = this.runnable(sandboxId);
    // Boat's runner cannot start `systemd-run`, so the command never starts.
    const result = box.damaged
      ? finished({ exitCode: 1, stderr: 'Executable not found in $PATH: "systemd-run"\n' })
      : this.shell(box, commandRequest.command);
    if (!commandRequest.detached) return result;
    const processId = this.detached.size + 1;
    this.detached.set(processId, { result, endsAt: Date.now() + this.detachedRunMs });
    return {
      ok: true,
      type: "command.started",
      success: true,
      processId,
      pid: processId,
      command: commandRequest.command,
      startedAt: new Date(),
    };
  }

  async commandStatus({
    sandboxId,
    processId,
  }: CommandStatusRequest): Promise<CommandStatusResponse> {
    this.require(sandboxId);
    const detached = this.detached.get(processId);
    if (!detached) throw boatError(404, "not_found", "Process not found");
    const { result, endsAt } = detached;
    const running = Date.now() < endsAt;
    return {
      ok: true,
      type: "command.status",
      success: true,
      processId,
      status: running ? "running" : "exited",
      running,
      exitCode: running ? null : result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * A detached command's output as NDJSON from the given offsets, ending with its exit. While
   * `attachReconnects` lasts, a connection carries half the remaining stdout and ends in
   * `reconnect`, as Boat ends every connection after ten minutes.
   */
  async attachCommandRaw({
    sandboxId,
    processId,
    stdoutOffset = 0,
    stderrOffset = 0,
  }: AttachCommandRequest): Promise<ApiResponse<CommandAttachFrame>> {
    this.require(sandboxId);
    if (this.attachOutdated) {
      throw boatError(409, "agent_outdated", "Sandbox agent does not support offsets");
    }
    const detached = this.detached.get(processId);
    if (!detached) throw boatError(404, "not_found", "Process not found");
    const { stdout, stderr, exitCode } = detached.result;
    const frames: CommandAttachFrame[] = [
      { type: "attached", processId, stdoutOffset, stderrOffset },
    ];
    if (this.attachReconnects > 0) {
      this.attachReconnects -= 1;
      const half = stdoutOffset + Math.ceil((stdout.length - stdoutOffset) / 2);
      frames.push(
        { type: "stdout", data: stdout.slice(stdoutOffset, half), nextOffset: half },
        { type: "reconnect", stdoutOffset: half, stderrOffset },
      );
    } else {
      if (stdout.length > stdoutOffset) {
        frames.push({
          type: "stdout",
          data: stdout.slice(stdoutOffset),
          nextOffset: stdout.length,
        });
      }
      if (stderr.length > stderrOffset) {
        frames.push({
          type: "stderr",
          data: stderr.slice(stderrOffset),
          nextOffset: stderr.length,
        });
      }
      frames.push({ type: "exit", status: "exited", exitCode: exitCode ?? 1 });
    }
    return {
      raw: new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""), {
        headers: { "content-type": "application/x-ndjson" },
      }),
      value: async () => frames[0] as CommandAttachFrame,
    };
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    this.check();
    this.sandboxes.delete(sandboxId);
  }

  private check(): void {
    this.requestTimes.push(Date.now());
    if (this.requestLimitSeconds !== undefined) {
      const retryAfter = this.requestLimitSeconds;
      this.requestLimitSeconds = undefined;
      throw new ResponseError(
        Response.json(
          { code: "IP_RATE_LIMIT_EXCEEDED", message: "Too many requests", retryAfter },
          { status: 429, headers: { "Retry-After": String(retryAfter) } },
        ),
        "Response returned an error code",
      );
    }
    if (this.rejectAll) {
      const { status, code, message } = this.rejectAll;
      throw boatError(status, code, message);
    }
  }

  private start(): void {
    this.check();
    if (this.startsExhausted) {
      throw boatError(429, "rate_limited", "Rate limit hit: machine starts per day");
    }
  }

  private require(id: string): FakeSandbox {
    this.check();
    const box = this.sandboxes.get(id);
    if (!box) throw boatError(404, "not_found", "Sandbox not found");
    return box;
  }

  private runnable(id: string): FakeSandbox {
    const box = this.require(id);
    if (!RUNNABLE.has(box.sandbox.state)) {
      throw boatError(409, "sandbox_not_ready", `Sandbox is ${box.sandbox.state}`);
    }
    return box;
  }

  private info(box: FakeSandbox): SandboxInfoResponse {
    return { ok: true, type: "sandbox.info", sandbox: { ...box.sandbox } };
  }

  private action(box: FakeSandbox): SandboxActionResponse {
    return {
      ok: true,
      type: "sandbox.action",
      id: box.sandbox.id,
      status: box.sandbox.state,
      sandbox: { ...box.sandbox },
    };
  }

  private shell(box: FakeSandbox, wrapped: string): CommandResponse {
    // The adapter wraps commands as `timeout ... bash -lc <command>`.
    const tokens = parse(wrapped, (name) => `$${name}`);
    const last = tokens.at(-1);
    const command = tokens[0] === "timeout" && typeof last === "string" ? last : wrapped;
    const desktop = this.desktop(command);
    if (desktop) return finished(desktop);

    // `exec 3< FILE || exit 1; rm -f -- FILE; eval "$(cat <&3 || echo exit 1)" || exit 1; exec 3<&-; argv`
    const sourced = command.match(
      /^exec 3< ('[^']*') \|\| exit 1; rm -f -- \1; eval "\$\(cat <&3 \|\| echo exit 1\)" \|\| exit 1; exec 3<&-; ([\s\S]*)$/,
    );
    if (sourced) {
      const envFile = String(parse(sourced[1]!)[0]);
      const file = box.files.get(envFile);
      if (!file) return finished({ exitCode: 1, stderr: "No such file or directory\n" });
      box.files.delete(envFile);
      const env = { ...box.env };
      for (const token of parse(Buffer.from(file.content).toString("utf8"))) {
        if (typeof token !== "string" || token === "export") continue;
        const [name, ...value] = token.split("=");
        env[name!] = value.join("=");
      }
      const argv = parse(sourced[2]!).filter((token): token is string => typeof token === "string");
      return finished(simpleCommand(argv, env));
    }

    // `exec 0< FILE || exit 1; rm -f -- FILE; command`
    const withInput = command.match(/^exec 0< ('[^']*') \|\| exit 1; rm -f -- \1; ([\s\S]*)$/);
    if (withInput) {
      const inputFile = String(parse(withInput[1]!)[0]);
      const file = box.files.get(inputFile);
      if (!file) return finished({ exitCode: 1, stderr: "No such file or directory\n" });
      box.files.delete(inputFile);
      return finished(this.withInput(withInput[2]!, Buffer.from(file.content).toString("utf8")));
    }

    const directory = command.match(/^directory=(.*)$/m)?.[1];
    if (directory !== undefined) {
      const root = String(parse(directory)[0]);
      const children = new Map<string, "file" | "dir">();
      for (const filePath of box.files.keys()) {
        if (!filePath.startsWith(`${root}/`)) continue;
        const [child, ...rest] = filePath.slice(root.length + 1).split("/");
        children.set(`${root}/${child}`, rest.length ? "dir" : "file");
      }
      if (!children.size) return finished({ exitCode: 2 });
      return finished({
        stdout: Buffer.from(
          [...children].map(([entry, kind]) => listing(entry, kind, box.files.get(entry))).join(""),
        ).toString("base64"),
      });
    }
    // An export archives the workspace to a file the adapter then downloads.
    const archive = command.match(/^archive=(.*)$/m)?.[1];
    if (archive !== undefined) {
      const files = [...box.files]
        .filter(([filePath]) => filePath.startsWith(`${BOAT_WORKSPACE}/`))
        .map(([filePath, file]) => [filePath.slice(BOAT_WORKSPACE.length + 1), file] as const)
        // The real walk leaves skipped browser state out before counting or archiving it.
        .filter(([relative]) => !shouldSkipPortableWorkspaceFile(relative))
        .sort(([a], [b]) => a.localeCompare(b));
      const maxFiles = command.match(/wc -l < "\$archive\.sizes"\)" -gt (\d+) /)?.[1];
      const maxBytes = command.match(/ -gt (\d+) \]; then [^\n]*; exit 5; fi/)?.[1];
      if (maxFiles !== undefined && files.length > Number(maxFiles)) {
        return finished({ exitCode: 4 });
      }
      const bytes = files.reduce((total, [, file]) => total + file.content.byteLength, 0);
      if (maxBytes !== undefined && bytes > Number(maxBytes)) return finished({ exitCode: 5 });
      box.files.set(String(parse(archive)[0]), {
        content: workspaceArchive(files),
        executable: false,
      });
      return finished({});
    }

    if (command === BOAT_WRITABLE_WORKSPACE_COMMAND) {
      for (const [filePath, file] of box.files) {
        if (filePath.startsWith(`${BOAT_WORKSPACE}/`) && file.readOnly)
          box.files.set(filePath, { ...file, readOnly: false });
      }
      return finished({});
    }
    const parsed = parse(command, (name) => box.env[name] ?? "");
    const argv = parsed.filter((token): token is string => typeof token === "string");
    if (argv[0] === "chmod") {
      // `chmod 700 a && chmod 600 b ...`
      for (let index = 0; index < argv.length; index += 3) {
        const file = box.files.get(argv[index + 2] ?? "");
        if (file) file.executable = argv[index + 1] === "700";
      }
      return finished({});
    }
    if (argv[0] === "rm") {
      for (const filePath of argv.slice(1)) box.files.delete(filePath);
      return finished({});
    }
    // Scripts with shell operators are setup the fake has no state for.
    if (argv.length !== parsed.length) return finished({});
    return finished(simpleCommand(argv, box.env));
  }
}

function listing(
  absolute: string,
  kind: "file" | "dir",
  file?: { content: Uint8Array; executable: boolean },
): string {
  const size = file?.content.byteLength ?? 0;
  const mode = kind === "dir" || file?.executable ? "755" : "644";
  return `${kind === "dir" ? "d" : "f"}\t${size}\t${mode}\t${absolute}\0`;
}

function finished(result: Partial<CommandResponse>): CommandResponse {
  return {
    ok: true,
    type: "command.finished",
    success: (result.exitCode ?? 0) === 0,
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...result,
  };
}

/** The real Boat adapter over an in-memory Boat API. */
export function fakeBoatProvider(api = new FakeBoatApi()): BoatSandboxProvider {
  return new BoatSandboxProvider({ apiKey: "test-key" }, api);
}

/** What the SDK throws for a non-2xx response: Boat's error envelope behind a `ResponseError`. */
export function boatError(status: number, code: string, message: string): ResponseError {
  return new ResponseError(
    Response.json(
      { ok: false, type: "error", status, code, message, error: { code, message, status } },
      { status },
    ),
    "Response returned an error code",
  );
}
