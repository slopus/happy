import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  BackgroundJob,
  JobPublisher,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, clearThread, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createArtifactStore } from "./artifact-store-factory.js";
import { FakeMediaGenerationProvider } from "./media-generation-provider.js";
import { generateMediaFromTool } from "./media-generation-tools.js";
import {
  MEDIA_POLL_DEADLINE_MS,
  mediaDelivery,
  pollMediaVideo,
  reconcileMediaVideos,
} from "./media-video-poll.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** A provider whose remote job finishes, fails or errors when the test says so. */
class ScriptedVideoProvider extends FakeMediaGenerationProvider {
  remote: "running" | "completed" | "failed" | "error" = "running";
  submissions = 0;
  polls = 0;
  /** Runs while a check is in flight, to race it. */
  duringPoll?: () => Promise<void>;
  override async generateVideo(): Promise<MediaVideoJob> {
    this.submissions++;
    return { id: `remote-${this.submissions}`, status: "queued", progress: 0 };
  }
  override async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    this.polls++;
    await this.duringPoll?.();
    if (this.remote === "error") throw new MediaGenerationError("provider_failure");
    if (this.remote === "completed") return super.pollVideo(id, context);
    return { id, status: this.remote };
  }
}

describePostgres("background video delivery (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const users: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-media-poll-"));
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });
  afterAll(async () => {
    rmSync(dataDir, { recursive: true, force: true });
    if (!db) return;
    await runAsSystem("test cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function owner() {
    const id = randomUUID();
    users.push(id);
    return runAsSystem("test fixture", async () => {
      await prisma.user.create({
        data: { id, name: "Video test", email: `${id}@example.test`, emailVerified: true },
      });
      await prisma.organization.create({
        data: { id, name: "Video test", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id, organizationId: id, name: "Video test", isDefault: true },
      });
      await prisma.member.create({
        data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
      });
      const bot = await prisma.bot.create({
        data: { spaceId: id, userId: id, name: "Video test", color: "test-color" },
      });
      const thread = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: bot.id },
      });
      const task = await prisma.task.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Make a video",
          status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "running",
          trigger: "user",
        },
      });
      return { id, bot, thread, run };
    });
  }

  async function setup() {
    const user = await owner();
    const media = new ScriptedVideoProvider();
    const enqueued: BackgroundJob[] = [];
    const queue = { down: false };
    // Each "process" gets fresh dependencies; nothing but the database survives a restart.
    const limits: { maxUploadSizeBytes?: number } = {};
    const process = () => {
      const jobs: JobPublisher = {
        enqueue: async (job) => {
          if (queue.down) throw new Error("queue unavailable");
          enqueued.push(job);
        },
        enqueueIn: async () => undefined,
        cancelIn: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      };
      return {
        prisma,
        jobs,
        events: { notify: vi.fn(async () => undefined) },
        artifacts: createArtifactStore(dataDir, prisma, {}),
        mediaGeneration: media,
        ...limits,
      };
    };
    const tenant = { spaceId: user.id, userId: user.id };
    const run = {
      id: user.run.id,
      threadId: user.thread.id,
      botId: user.bot.id,
      userId: user.id,
      spaceId: user.id,
    };
    const submit = async (ended: "completed" | "cancelled" = "completed") => {
      const deps = process();
      const result = await runAsTenant(tenant, () =>
        generateMediaFromTool({
          name: "generate_video",
          args: { prompt: "a lighthouse at dusk" },
          executionId: randomUUID(),
          provider: media,
          prisma,
          context: {
            operationId: randomUUID(),
            traceId: "test",
            spaceId: user.id,
            userId: user.id,
            botId: user.bot.id,
            signal: new AbortController().signal,
          },
          run,
          threadGeneration: 0,
          ...mediaDelivery(deps, run, { providerId: media.id, operationId: "submit" }),
        }),
      );
      if (!result || !("jobId" in result) || !result.jobId) throw new Error("Submission failed");
      // The turn ends with the video still queued.
      await runAsSystem("test fixture", () =>
        prisma.run.update({ where: { id: user.run.id }, data: { status: ended } }),
      );
      return result.jobId;
    };
    const poll = (jobId: string) => runAsTenant(tenant, () => pollMediaVideo(process(), { jobId }));
    const reconcile = () => runAsSystem("reconcile", () => reconcileMediaVideos(process()));
    const job = (jobId: string) =>
      asSystem(prisma).externalEffect.findUniqueOrThrow({ where: { id: jobId } });
    const messages = (threadId = user.thread.id) =>
      asSystem(prisma).message.findMany({ where: { threadId }, orderBy: { seq: "asc" } });
    const wakes = () =>
      asSystem(prisma).run.findMany({
        where: { threadId: user.thread.id, trigger: "media" },
        include: { task: true },
      });
    const age = (jobId: string, ms: number) =>
      runAsSystem("test fixture", () =>
        prisma.externalEffect.update({
          where: { id: jobId },
          data: { createdAt: new Date(Date.now() - ms) },
        }),
      );
    // Nothing touched the job for a while, as when its scheduled poll was lost.
    const stall = (jobId: string) =>
      runAsSystem(
        "test fixture",
        () =>
          prisma.$executeRaw`UPDATE external_effects SET "updatedAt" = now() - interval '15 minutes' WHERE id = ${jobId}`,
      );
    const recovered = () => enqueued.map((job) => (job.payload as { jobId?: string }).jobId);
    return {
      user,
      media,
      enqueued,
      queue,
      age,
      stall,
      limits,
      recovered,
      submit,
      poll,
      reconcile,
      job,
      messages,
      wakes,
      tenant,
    };
  }

  it("posts a video finished after a restart to the chat that asked, once", async () => {
    const h = await setup();
    const other = await owner();
    const jobId = await h.submit();
    expect(h.media.submissions).toBe(1);
    // Restart: the scheduled poll is lost, and recovery finds the job from the database alone.
    await h.stall(jobId);
    h.enqueued.length = 0;
    await h.reconcile();
    expect(h.enqueued).toContainEqual(
      expect.objectContaining({ name: "media.poll", payload: { jobId }, keepExisting: true }),
    );
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_pending");
    expect(h.enqueued.at(-1)).toMatchObject({ name: "media.poll", payload: { jobId } });

    h.media.remote = "completed";
    await Promise.all([h.poll(jobId), h.poll(jobId)]);
    await h.poll(jobId);
    await h.reconcile();

    expect(h.media.submissions).toBe(1);
    expect((await h.job(jobId)).status).toBe("media_completed");
    const posted = await h.messages();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ role: "bot", botId: h.user.bot.id, runId: h.user.run.id });
    expect(posted[0]!.blocks).toEqual([expect.objectContaining({ mimeType: "video/mp4" })]);
    expect(await h.messages(other.thread.id)).toHaveLength(0);
    const wakes = await h.wakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.task.prompt).toContain("finished");
    // Recovery leaves a finished job alone.
    h.enqueued.length = 0;
    await h.reconcile();
    expect(h.recovered()).not.toContain(jobId);
  });

  it("reports a failed video to the bot instead of leaving the chat empty", async () => {
    const h = await setup();
    const jobId = await h.submit();
    h.media.remote = "failed";
    await h.poll(jobId);
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_failed");
    expect(await h.messages()).toHaveLength(0);
    const wakes = await h.wakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.task.prompt).toContain("failed");
    expect(h.media.submissions).toBe(1);
  });

  it("keeps checking through provider errors without resubmitting", async () => {
    const h = await setup();
    const jobId = await h.submit();
    h.media.remote = "error";
    h.enqueued.length = 0;
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_pending");
    expect(h.enqueued).toEqual([expect.objectContaining({ name: "media.poll" })]);
    expect(await h.wakes()).toHaveLength(0);
    h.media.remote = "completed";
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_completed");
    expect(h.media.submissions).toBe(1);
  });

  it("checks once more at the deadline, then reports a video still unfinished as failed", async () => {
    const h = await setup();
    const late = await h.submit();
    await h.age(late, MEDIA_POLL_DEADLINE_MS + 60_000);
    await h.poll(late);
    expect(h.media.polls).toBe(1);
    expect((await h.job(late)).status).toBe("media_failed");
    expect(await h.wakes()).toHaveLength(1);

    // A video that finished just before the deadline is still delivered.
    const h2 = await setup();
    const finished = await h2.submit();
    await h2.age(finished, MEDIA_POLL_DEADLINE_MS + 60_000);
    h2.media.remote = "completed";
    await h2.poll(finished);
    expect((await h2.job(finished)).status).toBe("media_completed");
    expect(await h2.messages()).toHaveLength(1);
  });

  it("retries posting a stored video past the deadline, then reports it failed", async () => {
    const h = await setup();
    const jobId = await h.submit();
    // The video was stored, but posting it keeps failing.
    await runAsSystem("test fixture", () =>
      prisma.externalEffect.update({
        where: { id: jobId },
        data: { result: { provider: h.media.id, jobId: "remote-1", artifactId: "not-posted" } },
      }),
    );
    await h.age(jobId, MEDIA_POLL_DEADLINE_MS + 60_000);
    h.enqueued.length = 0;
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_pending");
    expect(h.recovered()).toContain(jobId);
    expect(await h.wakes()).toHaveLength(0);
    await h.age(jobId, MEDIA_POLL_DEADLINE_MS + 20 * 60_000);
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_failed");
    expect(await h.wakes()).toHaveLength(1);
  });

  it("retries provider errors past the deadline before reporting the video failed", async () => {
    const h = await setup();
    const jobId = await h.submit();
    h.media.remote = "error";
    await h.age(jobId, MEDIA_POLL_DEADLINE_MS + 60_000);
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_pending");
    expect(await h.wakes()).toHaveLength(0);
    await h.age(jobId, MEDIA_POLL_DEADLINE_MS + 20 * 60_000);
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_failed");
    expect(await h.wakes()).toHaveLength(1);
  });

  it("reports a finished video that cannot be stored as failed after the deadline", async () => {
    const h = await setup();
    const jobId = await h.submit();
    h.media.remote = "completed";
    h.limits.maxUploadSizeBytes = 1;
    await h.poll(jobId);
    // The claim is released, so later checks and the deadline can still settle it.
    expect((await h.job(jobId)).status).toBe("media_pending");
    expect(await h.messages()).toHaveLength(0);
    // Errors get the same grace past the deadline as provider errors.
    await h.age(jobId, MEDIA_POLL_DEADLINE_MS + 20 * 60_000);
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_failed");
    expect(await h.wakes()).toHaveLength(1);
  });

  it("leaves a stored image whose post failed to its own turn", async () => {
    const h = await setup();
    const image = await runAsSystem("test fixture", () =>
      prisma.externalEffect.create({
        data: {
          spaceId: h.user.id,
          runId: h.user.run.id,
          kind: "media_generation_job",
          idempotencyKey: `media:${h.user.run.id}:image`,
          status: "media_polling",
          request: { tool: "generate_image", prompt: "a lighthouse", executionId: "image" },
          result: { provider: h.media.id, artifactId: "stored-image" },
        },
      }),
    );
    await h.stall(image.id);
    h.enqueued.length = 0;
    await h.reconcile();
    expect(h.recovered()).not.toContain(image.id);
    await h.poll(image.id);
    expect((await h.job(image.id)).status).toBe("media_polling");
    expect(await h.messages()).toHaveLength(0);
    expect(await h.wakes()).toHaveLength(0);
  });

  it("still delivers when the turn that asked was stopped or closed", async () => {
    const h = await setup();
    const jobId = await h.submit("cancelled");
    h.media.remote = "completed";
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_completed");
    expect(await h.messages()).toHaveLength(1);
    expect(await h.wakes()).toHaveLength(1);
  });

  it("keeps the follow-up turn when the queue is down as the video finishes", async () => {
    const h = await setup();
    const jobId = await h.submit();
    h.media.remote = "completed";
    h.queue.down = true;
    await h.poll(jobId);
    // The turn committed with the delivery, so the run reconciler can start it later.
    expect((await h.job(jobId)).status).toBe("media_completed");
    expect(await h.wakes()).toEqual([expect.objectContaining({ status: "queued" })]);
  });

  it("never revives a video another check settled while this one was in flight", async () => {
    const h = await setup();
    const jobId = await h.submit();
    h.media.remote = "error";
    h.media.duringPoll = () =>
      runAsSystem("test fixture", async () => {
        await prisma.externalEffect.update({
          where: { id: jobId },
          data: { status: "media_failed" },
        });
      });
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_failed");
  });

  it("recovers every unfinished video, however many and however old", async () => {
    const h = await setup();
    const jobIds = [await h.submit(), await h.submit()];
    // Each run may submit two videos, so the recently checked one comes from another chat.
    const healthy = await (await setup()).submit();
    await h.age(jobIds[0]!, 3 * MEDIA_POLL_DEADLINE_MS);
    for (const jobId of jobIds) await h.stall(jobId);
    h.enqueued.length = 0;
    await h.reconcile();
    expect(h.recovered()).toEqual(expect.arrayContaining(jobIds));
    // A job checked recently still has its poll scheduled.
    expect(h.recovered()).not.toContain(healthy);
  });

  it("closes a job whose bot was archived, even one left mid-check", async () => {
    const h = await setup();
    const jobId = await h.submit();
    await runAsSystem("test fixture", async () => {
      await prisma.externalEffect.update({
        where: { id: jobId },
        data: { status: "media_polling" },
      });
      await prisma.bot.update({ where: { id: h.user.bot.id }, data: { archivedAt: new Date() } });
    });
    h.media.remote = "completed";
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_failed");
    expect(await h.messages()).toHaveLength(0);
    expect(await h.wakes()).toHaveLength(0);
  });

  it("posts nothing into a chat cleared after the video was submitted", async () => {
    const h = await setup();
    const jobId = await h.submit();
    await runAsTenant(h.tenant, () =>
      clearThread(prisma, {
        spaceId: h.user.id,
        botId: h.user.bot.id,
        threadId: h.user.thread.id,
      }),
    );
    h.media.remote = "completed";
    await h.poll(jobId);
    expect(await h.messages()).toHaveLength(0);
    expect(await h.wakes()).toHaveLength(0);
    expect(h.media.polls).toBe(0);
    h.enqueued.length = 0;
    await h.reconcile();
    expect(h.recovered()).not.toContain(jobId);
  });
});
