import type { HostOptions } from "./runtime";
type HostTool = NonNullable<HostOptions["onSessionTool"]>;
/** One lease-bound stream. A loss cancels work; writes are never replayed or reconnected. */
export async function serveSessionTools(
  request: typeof fetch,
  execute: HostTool,
  signal: AbortSignal,
) {
  const lifetime = new AbortController();
  const ownedSignal = AbortSignal.any([signal, lifetime.signal]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => {
    void reader?.cancel().catch(() => {});
  };
  ownedSignal.addEventListener("abort", abort, { once: true });
  const tasks = new Set<Promise<void>>();
  try {
    const response = await request("/api/paws-session-tools/stream", {
      signal: ownedSignal,
    });
    if (!response.ok || !response.body)
      throw new Error("session-tools-unavailable");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done || ownedSignal.aborted) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 32768)
        throw new Error("session-tool-frame-too-large");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = frame
          .split("\n")
          .find((value) => value.startsWith("data: "));
        if (!line) continue;
        const input = JSON.parse(line.slice(6));
        if (
          typeof input.id !== "string" ||
          input.id.length > 200 ||
          typeof input.tool !== "string" ||
          !input.args ||
          typeof input.args !== "object" ||
          Array.isArray(input.args)
        )
          throw new Error("invalid-session-tool-frame");
        if (tasks.size >= 8) throw new Error("session-tool-capacity");
        const task = (async () => {
          let result: unknown;
          try {
            result = await execute(input, ownedSignal);
          } catch {
            result = { error: "web-client-disconnected-or-outcome-unknown" };
          }
          if (ownedSignal.aborted) return;
          await request("/api/paws-session-tools/result", {
            method: "POST",
            signal: ownedSignal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: input.id, result }),
          });
        })();
        tasks.add(task);
        void task
          .finally(() => tasks.delete(task))
          .catch(() => lifetime.abort());
      }
    }
  } finally {
    lifetime.abort();
    ownedSignal.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => {});
    await Promise.allSettled(tasks);
  }
}
