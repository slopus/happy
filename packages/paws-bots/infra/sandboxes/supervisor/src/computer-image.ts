import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { getLogger } from "@rakazo/logging";
import type Docker from "dockerode";
import { COMPUTER_IMAGE_CONTEXT_FILES, isRegistryQualifiedImage } from "./computer-spec.js";

/** A pull or build that sends nothing for this long has stalled; a slow one keeps reporting. */
export const IMAGE_PROGRESS_IDLE_MS = 10 * 60_000;
export const MAX_PROGRESS_LINE = 1024 * 1024;

/**
 * Makes sure the computer image exists before a computer starts. Concurrent callers share one
 * attempt and nothing is kept once it settles, so a failed attempt is retried by the next call and
 * an image removed while the supervisor runs (say by `docker system prune -a`) is restored.
 */
export function computerImageEnsurer(docker: Docker, image: string, context: string) {
  let attempt: Promise<void> | undefined;
  return () => {
    attempt ??= provideComputerImage(docker, image, context).finally(() => {
      attempt = undefined;
    });
    return attempt;
  };
}

async function provideComputerImage(docker: Docker, image: string, context: string) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode !== 404) {
      getLogger().error("computer image check failed", error, { "container.image.name": image });
      throw new Error(`Could not check ${image}; see the supervisor log.`);
    }
  }
  // A registry-qualified image is only pulled: a local build tagged with a published name could
  // stand in for a different version of it.
  if (isRegistryQualifiedImage(image)) {
    await produce(
      docker,
      image,
      "pull",
      (abortSignal) => docker.pull(image, { abortSignal }),
      `Could not pull ${image}; run docker pull on the Docker host. See the supervisor log.`,
    );
    return;
  }
  // Every Rakazo build path tags the stock image rakazo/computer. Any other name may be a custom
  // build, such as a Brave image, which a stock build must not replace. dockerode's tar packer
  // crashes the process on a context file it cannot read.
  if (!/^rakazo\/computer(:[\w][\w.-]*)?$/.test(image) || !(await contextReadable(context))) {
    throw new Error(
      `Missing ${image}. Build it with: docker build -t ${image} infra/sandboxes/computer`,
    );
  }
  await produce(
    docker,
    image,
    "build",
    // COPY --chmod and TARGETARCH need BuildKit; API builds default to the classic builder.
    (abortSignal) =>
      docker.buildImage(
        { context, src: [...COMPUTER_IMAGE_CONTEXT_FILES] },
        { t: image, version: "2", abortSignal },
      ),
    `Could not build ${image} from infra/sandboxes/computer; see the supervisor log.`,
  );
}

async function contextReadable(context: string) {
  try {
    await Promise.all(
      COMPUTER_IMAGE_CONTEXT_FILES.map((file) => access(path.join(context, file), constants.R_OK)),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one pull or build to the end. Docker's reason can name registry hosts and signed URLs, so
 * it goes to the log and the caller gets `failure`.
 */
async function produce(
  docker: Docker,
  image: string,
  action: "pull" | "build",
  start: (abortSignal: AbortSignal) => Promise<NodeJS.ReadableStream>,
  failure: string,
) {
  try {
    await followProgress(start);
    await docker.getImage(image).inspect();
  } catch (error) {
    getLogger().error(`computer image ${action} failed`, error, { "container.image.name": image });
    throw new Error(failure);
  }
}

/**
 * Reads Docker's JSON progress lines to the end. Docker reports a failed pull or build as a line,
 * not as a stream error, and docker-modem's followProgress throws from its data handler on a line
 * that is not JSON, so this reader skips those instead.
 */
async function followProgress(start: (abortSignal: AbortSignal) => Promise<NodeJS.ReadableStream>) {
  const controller = new AbortController();
  const stalled = new Error(
    `Docker sent no progress for ${IMAGE_PROGRESS_IDLE_MS / 60_000} minutes`,
  );
  const idle = setTimeout(() => controller.abort(stalled), IMAGE_PROGRESS_IDLE_MS);
  try {
    const stream = await start(controller.signal);
    stream.setEncoding("utf8");
    // Only new text is scanned, and a line longer than any Docker sends is skipped like a
    // malformed one, so a stream without newlines costs neither time nor memory.
    let partial = "";
    let skipping = false;
    for await (const chunk of stream as AsyncIterable<string>) {
      idle.refresh();
      let from = 0;
      for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", from)) {
        if (!skipping) throwReportedError(partial + chunk.slice(from, end));
        partial = "";
        skipping = false;
        from = end + 1;
      }
      if (!skipping) partial += chunk.slice(from);
      if (partial.length > MAX_PROGRESS_LINE) {
        partial = "";
        skipping = true;
      }
    }
    if (!skipping) throwReportedError(partial);
  } catch (error) {
    // An aborted request fails with an AbortError before its response and "aborted" during it.
    throw controller.signal.aborted ? stalled : error;
  } finally {
    clearTimeout(idle);
  }
}

function throwReportedError(line: string) {
  let event: { error?: string; errorDetail?: { message?: string } } | null;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const message = event?.errorDetail?.message || event?.error;
  if (message) throw new Error(message);
}
