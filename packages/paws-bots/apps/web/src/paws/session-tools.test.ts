import { expect, it } from "vitest";
import { serveSessionTools } from "./session-tools";
it("consumes split SSE frames and returns a bounded tool result without exposing host credentials", async () => {
  const encoder = new TextEncoder();
  let calls = 0;
  const replies: any[] = [];
  let release: () => void = () => {};
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"id":"one","tool":"paws_sessions_'),
      );
      controller.enqueue(encoder.encode('list","args":{}}\n\n'));
      release = () => controller.close();
    },
  });
  const controller = new AbortController();
  const run = serveSessionTools(
    async (_url, init) => {
      if (init?.method === "POST") {
        replies.push(JSON.parse(String(init.body)));
        release();
        return new Response("{}");
      }
      return new Response(body);
    },
    async (request) => {
      calls++;
      expect(request.id).toBe("one");
      return { sessions: [{ id: "s" }] };
    },
    controller.signal,
  );
  await run;
  expect(calls).toBe(1);
  expect(replies).toEqual([{ id: "one", result: { sessions: [{ id: "s" }] } }]);
});
it("aborts pending host work on stream loss and never retries the request", async () => {
  const encoder = new TextEncoder();
  let hostSignal: AbortSignal | undefined;
  let calls = 0;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(
        encoder.encode(
          'data: {"id":"one","tool":"paws_session_send","args":{}}\n\n',
        ),
      );
      c.close();
    },
  });
  await serveSessionTools(
    async () => {
      calls++;
      return new Response(body);
    },
    async (_request, signal) => {
      hostSignal = signal;
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve({ error: "closed" })),
      );
    },
    new AbortController().signal,
  );
  expect(calls).toBe(1);
  expect(hostSignal?.aborted).toBe(true);
});
