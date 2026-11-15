import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { getLogger } from "@rakazo/logging";
import Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computerImageEnsurer,
  IMAGE_PROGRESS_IDLE_MS,
  MAX_PROGRESS_LINE,
} from "./computer-image.js";
import { COMPUTER_IMAGE_CONTEXT_FILES } from "./computer-spec.js";

const context = path.resolve(import.meta.dirname, "../../computer");
const noContext = path.join(import.meta.dirname, "no-such-computer-context");
const published = "ghcr.io/elie222/rakazo/computer:edge";
const local = "rakazo/computer:local";
const image = { "container.image.name": published };
const progressLine = '{"status":"Downloading"}\n';
const errorLine = (message: string) => `${JSON.stringify({ errorDetail: { message } })}\n`;
const stalled = new Error("Docker sent no progress for 10 minutes");
const checkFailed = (name: string) => `Could not check ${name}; see the supervisor log.`;
const pullFailed = (name: string) =>
  `Could not pull ${name}; run docker pull on the Docker host. See the supervisor log.`;
const missing = (name: string) =>
  `Missing ${name}. Build it with: docker build -t ${name} infra/sandboxes/computer`;
const buildFailed = (name: string) =>
  `Could not build ${name} from infra/sandboxes/computer; see the supervisor log.`;

/** How Docker answers one pull or build: what it streams, or a custom response. */
type Run =
  | { chunks?: (string | Buffer)[]; fail?: Error; creates?: boolean }
  | ((abortSignal: AbortSignal) => Promise<Readable>);

/** Sends `chunks`, then nothing. Node's http client fails an aborted response like this. */
const goesQuiet =
  (...chunks: string[]): Run =>
  async (abortSignal) => {
    const stream = new PassThrough();
    for (const chunk of chunks) stream.write(chunk);
    abortSignal.addEventListener("abort", () =>
      stream.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" })),
    );
    return stream;
  };

/** Never answers. Node's http client rejects a request aborted before its response like this. */
const neverAnswers: Run = (abortSignal) =>
  new Promise((_, reject) => {
    abortSignal.addEventListener("abort", () =>
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
    );
  });

function fakeDocker({
  present = false,
  inspectError,
  pulls = [],
  builds = [],
}: {
  present?: boolean;
  inspectError?: Error;
  pulls?: Run[];
  builds?: Run[];
} = {}) {
  let exists = present;
  const respond = async (runs: Run[], abortSignal: AbortSignal) => {
    const run = runs.shift() ?? {};
    if (typeof run === "function") return run(abortSignal);
    const { chunks = [progressLine], fail } = run;
    const creates = run.creates ?? !chunks.join("").includes('"error');
    const stream = Readable.from(
      (async function* () {
        yield* chunks;
        if (fail) throw fail;
      })(),
      { objectMode: false },
    );
    stream.on("end", () => {
      if (creates) exists = true;
    });
    return stream;
  };
  const docker = {
    getImage: vi.fn(() => ({
      inspect: vi.fn(async () => {
        if (inspectError) throw inspectError;
        if (!exists) throw Object.assign(new Error("no such image"), { statusCode: 404 });
        return {};
      }),
    })),
    pull: vi.fn((_image: string, options: { abortSignal: AbortSignal }) =>
      respond(pulls, options.abortSignal),
    ),
    buildImage: vi.fn((_context: unknown, options: { abortSignal: AbortSignal }) =>
      respond(builds, options.abortSignal),
    ),
  };
  return {
    docker,
    ensure: (name: string, imageContext = context) =>
      computerImageEnsurer(docker as unknown as Docker, name, imageContext),
    create: () => {
      exists = true;
    },
    prune: () => {
      exists = false;
    },
  };
}

const cleanups: Array<() => void> = [];
let logError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logError = vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("computer image", () => {
  it("never pulls or builds an image that is present", async () => {
    const fake = fakeDocker({ present: true });
    await fake.ensure(published)();
    await fake.ensure(local)();
    await fake.ensure("myorg/custom:local")();
    expect(fake.docker.pull).not.toHaveBeenCalled();
    expect(fake.docker.buildImage).not.toHaveBeenCalled();
  });

  it("pulls a missing image that names its registry", async () => {
    const fake = fakeDocker();
    await fake.ensure(published)();
    expect(fake.docker.pull).toHaveBeenCalledWith(published, {
      abortSignal: expect.any(AbortSignal),
    });
    expect(fake.docker.buildImage).not.toHaveBeenCalled();
  });

  it.each([local, "rakazo/computer:topology"])(
    "builds a missing %s with BuildKit from the full context",
    async (name) => {
      const fake = fakeDocker();
      await fake.ensure(name)();
      expect(fake.docker.pull).not.toHaveBeenCalled();
      expect(fake.docker.buildImage).toHaveBeenCalledWith(
        { context, src: [...COMPUTER_IMAGE_CONTEXT_FILES] },
        { t: name, version: "2", abortSignal: expect.any(AbortSignal) },
      );
    },
  );

  it.each([
    "rakazo-computer-brave:latest",
    "myorg/rakazo-computer:edge",
    "computer:local",
    `rakazo/computer@sha256:${"0".repeat(64)}`,
  ])("never replaces the custom image %s with a stock build", async (name) => {
    const fake = fakeDocker();
    await expect(fake.ensure(name, context)()).rejects.toThrow(new Error(missing(name)));
    expect(fake.docker.pull).not.toHaveBeenCalled();
    expect(fake.docker.buildImage).not.toHaveBeenCalled();
  });

  it("says how to build a missing unqualified image when there is no build context", async () => {
    const fake = fakeDocker();
    await expect(fake.ensure(local, noContext)()).rejects.toThrow(new Error(missing(local)));
    expect(fake.docker.pull).not.toHaveBeenCalled();
    expect(fake.docker.buildImage).not.toHaveBeenCalled();
  });

  it("logs a failed image check and returns a fixed message without pulling", async () => {
    const refused = new Error("connect ECONNREFUSED /var/run/docker.sock");
    const fake = fakeDocker({ inspectError: refused });
    await expect(fake.ensure(published)()).rejects.toThrow(new Error(checkFailed(published)));
    expect(logError).toHaveBeenCalledWith("computer image check failed", refused, image);
    expect(fake.docker.pull).not.toHaveBeenCalled();
    expect(fake.docker.buildImage).not.toHaveBeenCalled();
  });

  it("never builds a registry image whose pull fails, even with a build context", async () => {
    const reason = "failed to copy: Get https://blobs.registry.test/x?sig=s3cret: Forbidden";
    const fake = fakeDocker({ pulls: [{ chunks: [progressLine, errorLine(reason)] }] });
    await expect(fake.ensure(published, context)()).rejects.toThrow(
      new Error(pullFailed(published)),
    );
    expect(fake.docker.buildImage).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith("computer image pull failed", new Error(reason), image);
  });

  it("logs Docker's reason and returns a fixed message when a local build fails", async () => {
    const fake = fakeDocker({
      builds: [{ chunks: [errorLine("failed to solve: exit code 100")] }],
    });
    await expect(fake.ensure(local)()).rejects.toThrow(new Error(buildFailed(local)));
    expect(logError).toHaveBeenCalledWith(
      "computer image build failed",
      new Error("failed to solve: exit code 100"),
      { "container.image.name": local },
    );
  });

  it("fails on a stream error and on an error line split across chunks", async () => {
    const reset = new Error("read ECONNRESET");
    const fake = fakeDocker({
      pulls: [
        { chunks: [progressLine], fail: reset },
        { chunks: ['{"errorDetail":{"mess', 'age":"manifest unknown"}}\n'] },
      ],
    });
    const ensure = fake.ensure(published);
    await expect(ensure()).rejects.toThrow(new Error(pullFailed(published)));
    expect(logError).toHaveBeenLastCalledWith("computer image pull failed", reset, image);
    await expect(ensure()).rejects.toThrow(new Error(pullFailed(published)));
    expect(logError).toHaveBeenLastCalledWith(
      "computer image pull failed",
      new Error("manifest unknown"),
      image,
    );
  });

  it("reads CRLF lines, a bare error field and a last error line that has no newline", async () => {
    const fake = fakeDocker({
      pulls: [
        { chunks: ['{"status":"Downloading"}\r\n', '{"errorDetail":{"message":"crlf"}}\r\n'] },
        { chunks: [progressLine, '{"error":"bare"}\n'] },
        { chunks: [progressLine, '{"errorDetail":{"message":"last line"}}'] },
      ],
    });
    const ensure = fake.ensure(published);
    for (const reason of ["crlf", "bare", "last line"]) {
      await expect(ensure()).rejects.toThrow(new Error(pullFailed(published)));
      expect(logError).toHaveBeenLastCalledWith(
        "computer image pull failed",
        new Error(reason),
        image,
      );
    }
  });

  it("keeps a character whole when its bytes arrive in different chunks", async () => {
    const line = Buffer.from(errorLine("tag ✓ not found"));
    const split = line.indexOf("✓") + 1;
    const fake = fakeDocker({
      pulls: [{ chunks: [line.subarray(0, split), line.subarray(split)] }],
    });
    await expect(fake.ensure(published)()).rejects.toThrow(new Error(pullFailed(published)));
    expect(logError).toHaveBeenCalledWith(
      "computer image pull failed",
      new Error("tag ✓ not found"),
      image,
    );
  });

  it("skips a line longer than any Docker sends and reads the lines after it", async () => {
    const fake = fakeDocker({
      pulls: [
        {
          chunks: [
            `{"errorDetail":{"message":"${"x".repeat(MAX_PROGRESS_LINE)}`,
            'x"}}\n',
            errorLine("after a long line"),
          ],
        },
        {
          chunks: [
            "x".repeat(MAX_PROGRESS_LINE + 1),
            '{"error":"tail"}\n',
            errorLine("after a tail"),
          ],
        },
      ],
    });
    const ensure = fake.ensure(published);
    for (const reason of ["after a long line", "after a tail"]) {
      await expect(ensure()).rejects.toThrow(new Error(pullFailed(published)));
      expect(logError).toHaveBeenLastCalledWith(
        "computer image pull failed",
        new Error(reason),
        image,
      );
    }
  });

  it("fails a pull that reports success but leaves no image", async () => {
    const fake = fakeDocker({ pulls: [{ creates: false }] });
    await expect(fake.ensure(published)()).rejects.toThrow(new Error(pullFailed(published)));
    expect(logError).toHaveBeenCalledWith(
      "computer image pull failed",
      expect.objectContaining({ statusCode: 404 }),
      image,
    );
  });

  it("skips a progress line that is not JSON", async () => {
    const fake = fakeDocker({ pulls: [{ chunks: ["not json\n", progressLine, "{trunc"] }] });
    await fake.ensure(published)();
    expect(logError).not.toHaveBeenCalled();
  });

  it("shares retries and restores an image removed after a successful attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = fakeDocker({ pulls: [{ chunks: [errorLine("blob unknown")] }] });
    const ensure = fake.ensure(published);
    const failures = await Promise.allSettled([ensure(), ensure(), ensure()]);
    expect(failures.map(({ status }) => status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(fake.docker.pull).toHaveBeenCalledTimes(1);
    await Promise.all([ensure(), ensure(), ensure()]);
    expect(fake.docker.pull).toHaveBeenCalledTimes(2);
    await ensure();
    expect(fake.docker.pull).toHaveBeenCalledTimes(2);
    fake.prune();
    await ensure();
    expect(fake.docker.pull).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["goes quiet mid-stream", goesQuiet(progressLine)],
    ["never answers", neverAnswers],
  ])("aborts a pull that %s for the idle window", async (_case, run) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = fakeDocker({ pulls: [run] });
    const failure = fake
      .ensure(published)()
      .catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(IMAGE_PROGRESS_IDLE_MS);
    expect(await failure).toEqual(new Error(pullFailed(published)));
    expect(fake.docker.pull.mock.calls[0]?.[1].abortSignal.aborted).toBe(true);
    expect(logError).toHaveBeenCalledWith("computer image pull failed", stalled, image);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a slow pull run past the idle window while it keeps reporting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = new PassThrough();
    const fake = fakeDocker({ pulls: [async () => slow] });
    const done = fake.ensure(published)();
    for (let step = 0; step < 3; step++) {
      await vi.advanceTimersByTimeAsync(IMAGE_PROGRESS_IDLE_MS - 1_000);
      slow.write(progressLine);
      await new Promise((resolve) => setImmediate(resolve));
    }
    fake.create();
    slow.end();
    await done;
    expect(fake.docker.pull.mock.calls[0]?.[1].abortSignal.aborted).toBe(false);
  });
});

/**
 * A stand-in Docker daemon on a Unix socket for driving real dockerode. It reports every image
 * missing, answers or ignores the BuildKit session upgrade, and rejects, streams or finishes
 * /build. It is closed after each test, even one that times out.
 */
async function fakeDaemon(answer: {
  session: boolean;
  build: "reject" | "stream" | "finish" | "error";
}) {
  const directory = mkdtempSync(path.join(tmpdir(), "rakazo-fake-docker-"));
  const socketPath = path.join(directory, "docker.sock");
  const sessions: Socket[] = [];
  const requests: string[] = [];
  const daemon = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume().on("end", () => {
      if (request.method === "GET") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "no such image" }));
      } else if (answer.build === "reject") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "build rejected" }));
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        if (answer.build === "finish") response.end(progressLine);
        else if (answer.build === "error") response.write(errorLine("build failed"));
        else response.write(progressLine);
      }
    });
  });
  // Resolves once the client opens the session with a promise that settles when it closes it.
  const sessionOpened = new Promise<{ closed: Promise<string> }>((resolve) => {
    daemon.on("upgrade", (request, socket: Socket) => {
      requests.push(`${request.method} ${request.url}`);
      sessions.push(socket);
      // The daemon side is half-open, so the client closing its end shows up as "end".
      const closed = new Promise<string>((done) => {
        socket.once("end", () => done("closed"));
        socket.once("close", () => done("closed"));
      });
      socket.on("error", () => undefined).resume();
      if (answer.session) {
        socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n");
      }
      resolve({ closed });
    });
  });
  cleanups.push(() => {
    for (const socket of sessions) socket.destroy();
    daemon.closeAllConnections();
    daemon.close();
    rmSync(directory, { recursive: true, force: true });
  });
  daemon.listen(socketPath);
  await once(daemon, "listening");
  return { docker: new Docker({ socketPath }), sessionOpened, requests };
}

/** "closed" once the client has closed the session, or "still open" after two seconds. */
async function sessionClosed(session: Promise<{ closed: Promise<string> }>) {
  const timer = new AbortController();
  const { closed } = await session;
  try {
    return await Promise.race([closed, delay(2_000, "still open", { signal: timer.signal })]);
  } finally {
    timer.abort();
  }
}

describe("dockerode BuildKit session", () => {
  it("closes the build session when the build finishes", async () => {
    const daemon = await fakeDaemon({ session: true, build: "finish" });
    const stream = await daemon.docker.buildImage(
      { context, src: ["Dockerfile"] },
      { t: local, version: "2" },
    );
    stream.resume();
    expect(await sessionClosed(daemon.sessionOpened)).toBe("closed");
  });

  it("closes the build session when the daemon rejects the build", async () => {
    const daemon = await fakeDaemon({ session: true, build: "reject" });
    await expect(
      daemon.docker.buildImage({ context, src: ["Dockerfile"] }, { t: local, version: "2" }),
    ).rejects.toThrow("build rejected");
    expect(await sessionClosed(daemon.sessionOpened)).toBe("closed");
  });

  it("closes the build session when the build is aborted mid-stream", async () => {
    const daemon = await fakeDaemon({ session: true, build: "stream" });
    const controller = new AbortController();
    const stream = await daemon.docker.buildImage(
      { context, src: ["Dockerfile"] },
      { t: local, version: "2", abortSignal: controller.signal },
    );
    await once(stream, "data");
    const failed = once(stream, "error");
    controller.abort();
    await failed;
    expect(await sessionClosed(daemon.sessionOpened)).toBe("closed");
  });

  it("closes the build session when a reported error stops progress consumption", async () => {
    const daemon = await fakeDaemon({ session: true, build: "error" });
    await expect(computerImageEnsurer(daemon.docker, local, context)()).rejects.toThrow(
      new Error(buildFailed(local)),
    );
    expect(await sessionClosed(daemon.sessionOpened)).toBe("closed");
  });

  it("aborts a build whose session the daemon never answers and closes the session request", async () => {
    const daemon = await fakeDaemon({ session: false, build: "reject" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const failure = computerImageEnsurer(daemon.docker, local, context)().catch(
      (error: Error) => error,
    );
    await daemon.sessionOpened;
    await vi.advanceTimersByTimeAsync(IMAGE_PROGRESS_IDLE_MS);
    vi.useRealTimers();
    expect(await failure).toEqual(new Error(buildFailed(local)));
    expect(logError).toHaveBeenCalledWith("computer image build failed", stalled, {
      "container.image.name": local,
    });
    expect(await sessionClosed(daemon.sessionOpened)).toBe("closed");
  });

  it("treats a context missing a listed file as missing instead of crashing", async () => {
    const daemon = await fakeDaemon({ session: true, build: "finish" });
    const partial = mkdtempSync(path.join(tmpdir(), "rakazo-partial-context-"));
    cleanups.push(() => rmSync(partial, { recursive: true, force: true }));
    for (const file of COMPUTER_IMAGE_CONTEXT_FILES) {
      if (file !== "browser-policy.json") {
        copyFileSync(path.join(context, file), path.join(partial, file));
      }
    }
    await expect(computerImageEnsurer(daemon.docker, local, partial)()).rejects.toThrow(
      new Error(missing(local)),
    );
    expect(daemon.requests).toEqual([`GET /images/${local}/json`]);
  });
});
