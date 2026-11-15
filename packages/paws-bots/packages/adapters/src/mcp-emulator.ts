import type { Server } from "node:http";
import { createServer } from "node:http";

export interface McpCall {
  method: string;
  params: Record<string, unknown>;
}

export class McpEmulator {
  private server: Server | undefined;
  port = 0;
  readonly writes: Array<{ path: string; text: string }> = [];

  async start(port = 0): Promise<number> {
    this.server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as McpCall;
        if (body.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              tools: [
                {
                  name: "notes.write",
                  description: "Write a note in the destination filesystem",
                  inputSchema: {
                    type: "object",
                    properties: { path: { type: "string" }, text: { type: "string" } },
                  },
                },
              ],
            }),
          );
          return;
        }
        if (body.method === "tools/call" && body.params.name === "notes.write") {
          const args = (body.params.arguments ?? {}) as { path?: string; text?: string };
          this.writes.push({ path: args.path ?? "note.md", text: args.text ?? "" });
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(400).end("unknown method");
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(port, "127.0.0.1", () => resolve()));
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : port;
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server?.close((err) => (err ? reject(err) : resolve())),
    );
  }

  inspect() {
    return { writes: this.writes };
  }
}
