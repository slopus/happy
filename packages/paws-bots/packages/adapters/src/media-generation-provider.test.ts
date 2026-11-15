import type { AdapterContext } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMediaGenerationProvider } from "./media-generation-factory.js";
import {
  FakeMediaGenerationProvider,
  FalMediaGenerationProvider,
} from "./media-generation-provider.js";

const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  operationId: "op",
  traceId: "trace",
  signal: new AbortController().signal,
};
const json = (value: unknown) => new Response(JSON.stringify(value));
const job = {
  request_id: "job",
  status_url: "https://queue.fal.run/fal-ai/wan/requests/job/status",
  response_url: "https://queue.fal.run/fal-ai/wan/requests/job",
};
const jobId = JSON.stringify({ status: job.status_url, response: job.response_url });
const imageResult = { images: [{ url: "https://cdn.example.test/image.png" }] };
const videoResult = { video: { url: "https://cdn.example.test/video.mp4" } };
function setup(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return {
    fetch,
    provider: new FalMediaGenerationProvider({
      apiKey: "fake-key",
      imageModel: "fal-ai/flux/schnell",
      videoModel: "fal-ai/wan/v2.2-a14b/text-to-video",
      fetch,
      resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
  };
}

describe("media generation connection", () => {
  it("defaults to disabled and requires explicit models and credentials", () => {
    expect(createMediaGenerationProvider({})).toBeUndefined();
    expect(
      createMediaGenerationProvider({ MEDIA_GENERATION_PROVIDER: "disabled" }),
    ).toBeUndefined();
    expect(
      createMediaGenerationProvider({ MEDIA_GENERATION_PROVIDER: "fake" })?.capabilities.offline,
    ).toBe(true);
    expect(() => createMediaGenerationProvider({ MEDIA_GENERATION_PROVIDER: "unknown" })).toThrow();
    expect(() => createMediaGenerationProvider({ MEDIA_GENERATION_PROVIDER: "fal" })).toThrow();
    expect(
      createMediaGenerationProvider({
        MEDIA_GENERATION_PROVIDER: "fal",
        MEDIA_GENERATION_API_KEY: "fake-key",
        MEDIA_GENERATION_IMAGE_MODEL: "fal-ai/flux/schnell",
        MEDIA_GENERATION_BASE_URL: "https://media.example.test",
      })?.capabilities,
    ).toEqual({ images: true, video: false, offline: false });
  });
  it("has an offline image and async video implementation", async () => {
    const provider = new FakeMediaGenerationProvider();
    expect((await provider.generateImage({ prompt: "draw" }, context)).mimeType).toBe("image/png");
    const job = await provider.generateVideo({ prompt: "move" }, context);
    expect(job.status).toBe("queued");
    expect((await provider.pollVideo(job.id, context)).status).toBe("completed");
  });
  it("translates one image generation and downloads without forwarding credentials", async () => {
    const { fetch, provider } = setup(
      json(job),
      json({ status: "COMPLETED" }),
      json(imageResult),
      new Response("image", { headers: { "content-type": "image/png" } }),
    );
    expect(await provider.generateImage({ prompt: "draw" }, context)).toEqual({
      mimeType: "image/png",
      bytes: new TextEncoder().encode("image"),
    });
    expect(fetch.mock.calls[0]![0]).toBe("https://queue.fal.run/fal-ai/flux/schnell");
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      prompt: "draw",
      num_images: 1,
      output_format: "png",
    });
    expect(new Headers(fetch.mock.calls[3]![1]?.headers).has("authorization")).toBe(false);
  });
  it("translates async submission, queue status, completion and failure", async () => {
    const { provider, fetch } = setup(
      json(job),
      json({ status: "IN_PROGRESS" }),
      json({ status: "COMPLETED" }),
      json(videoResult),
      new Response("video", { headers: { "content-type": "video/mp4" } }),
      json({ status: "COMPLETED", error: "private provider failure" }),
    );
    expect(await provider.generateVideo({ prompt: "move" }, context)).toEqual({
      id: jobId,
      status: "queued",
    });
    expect(await provider.pollVideo(jobId, context)).toMatchObject({ status: "running" });
    expect(await provider.pollVideo(jobId, context)).toMatchObject({
      status: "completed",
      output: { mimeType: "video/mp4" },
    });
    expect(fetch.mock.calls[3]![0]).toBe(job.response_url);
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "failed" });
  });
  it.each(["Image/PNG", "IMAGE/PNG", "Image/PNG ; name=render.png"])(
    "accepts image Content-Type %s and returns canonical MIME",
    async (contentType) => {
      const { provider } = setup(
        json(job),
        json({ status: "COMPLETED" }),
        json(imageResult),
        new Response("image", { headers: { "content-type": contentType } }),
      );
      expect(await provider.generateImage({ prompt: "draw" }, context)).toEqual({
        mimeType: "image/png",
        bytes: new TextEncoder().encode("image"),
      });
    },
  );
  it.each(["Video/MP4", "VIDEO/MP4", "Video/MP4 ; name=render.mp4"])(
    "accepts video Content-Type %s and returns canonical MIME",
    async (contentType) => {
      const { provider } = setup(
        json({ status: "COMPLETED" }),
        json(videoResult),
        new Response("video", { headers: { "content-type": contentType } }),
      );
      expect(await provider.pollVideo(jobId, context)).toEqual({
        id: jobId,
        status: "completed",
        output: { mimeType: "video/mp4", bytes: new TextEncoder().encode("video") },
      });
    },
  );
  it.each([
    [429, "rate_limit"],
    [401, "authentication"],
    [503, "provider_failure"],
  ])("sanitizes HTTP %i without retrying", async (status, code) => {
    const { provider, fetch } = setup(
      new Response("private provider response", { status: Number(status) }),
    );
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toMatchObject({
      code,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("sanitizes network errors and malformed responses", async () => {
    const { provider, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error("fake-key private endpoint"));
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toThrow(
      "Media generation: provider_failure",
    );
    fetch.mockResolvedValueOnce(new Response("bad JSON"));
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toThrow(
      "Media generation: provider_failure",
    );
  });
  it("rejects unsupported capabilities and invalid prompts before HTTP", async () => {
    const { provider, fetch } = setup();
    await expect(provider.generateImage({ prompt: " " }, context)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      provider.generateVideo({ prompt: "x".repeat(4001) }, context),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      new FalMediaGenerationProvider({ apiKey: "fake" }).generateVideo({ prompt: "move" }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
  it("rejects oversized output with and without Content-Length", async () => {
    for (const headers of [
      new Headers({
        "content-length": String(ATTACHMENT_MAX_BYTES + 1),
        "content-type": "video/mp4",
      }),
      new Headers({ "content-type": "video/mp4" }),
    ]) {
      const { provider } = setup(
        json({ status: "COMPLETED" }),
        json(videoResult),
        new Response(new Uint8Array(ATTACHMENT_MAX_BYTES + 1), { headers }),
      );
      await expect(provider.pollVideo(jobId, context)).rejects.toMatchObject({
        code: "output_limit",
      });
    }
  });
  it("rejects wrong output MIME and invalid statuses", async () => {
    await expect(
      setup(
        json({ status: "COMPLETED" }),
        json(videoResult),
        new Response("html", { headers: { "content-type": "text/html" } }),
      ).provider.pollVideo(jobId, context),
    ).rejects.toMatchObject({ code: "provider_failure" });
    await expect(
      setup(json({ status: "unknown" })).provider.pollVideo(jobId, context),
    ).rejects.toMatchObject({ code: "provider_failure" });
  });
  it("rejects cross-origin queue URLs before forwarding credentials", async () => {
    const { provider, fetch } = setup(
      json({ ...job, status_url: "https://attacker.example.test/status" }),
    );
    await expect(provider.generateVideo({ prompt: "move" }, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    "http://127.0.0.1/private",
    "http://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
  ])("rejects unsafe output URL %s", async (url) => {
    const { provider, fetch } = setup(json({ status: "COMPLETED" }), json({ video: { url } }));
    await expect(provider.pollVideo(jobId, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects redirects from output downloads", async () => {
    const { provider } = setup(
      json({ status: "COMPLETED" }),
      json(videoResult),
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );
    await expect(provider.pollVideo(jobId, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
  });
  it("preserves cancellation without making a submission", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, fetch } = setup();
    await expect(
      provider.generateImage({ prompt: "draw" }, { ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
