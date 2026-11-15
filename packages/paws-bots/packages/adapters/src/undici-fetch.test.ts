import { createServer } from "node:http";
import { parseErrorResponse } from "@modelcontextprotocol/sdk/client/auth.js";
import { Agent, Response as UndiciResponse } from "undici";
import { describe, expect, it } from "vitest";
import { dispatcherFetch, fetchPairedWithDispatcher } from "./undici-fetch.js";

describe("fetchPairedWithDispatcher", () => {
  it("sends global FormData fields with the multipart boundary", async () => {
    const form = new FormData();
    form.set("model", "whisper-1");
    form.set(
      "file",
      new Blob([Uint8Array.from([1, 2, 3, 4])], { type: "audio/webm" }),
      "speech.webm",
    );
    const posted = await postThroughPackageFetch((url, dispatcher) =>
      fetchPairedWithDispatcher(globalThis.fetch)(url, {
        method: "POST",
        body: form,
        dispatcher,
      } as RequestInit & { dispatcher: Agent }),
    );

    expect(posted.status).toBe(204);
    expect(posted.lookups).toBeGreaterThan(0);
    const boundary = boundaryOf(posted.contentType);
    const raw = posted.body.toString("latin1");
    expect(raw).toContain(`--${boundary}`);
    expect(raw).toContain(`--${boundary}--`);
    expect(raw).toContain('name="model"');
    expect(raw).toContain("whisper-1");
    expect(raw).toContain('name="file"');
    expect(raw).toContain('filename="speech.webm"');
    expect(raw).toContain("audio/webm");
    expect(posted.body.includes(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(raw).not.toContain("[object FormData]");
  });

  it("passes other bodies through the same dispatcher", async () => {
    const posted = await postThroughPackageFetch((url, dispatcher) =>
      dispatcherFetch(url, {
        method: "POST",
        body: "plain-body",
        dispatcher,
      } as RequestInit & { dispatcher: Agent }),
    );

    expect(posted.status).toBe(204);
    expect(posted.lookups).toBeGreaterThan(0);
    expect(posted.body.toString("utf8")).toBe("plain-body");
    expect(posted.contentType ?? "").not.toMatch(/multipart\/form-data/i);
  });

  it("leaves a caller-supplied fetch and its FormData unchanged", async () => {
    const form = new FormData();
    form.set("a", "b");
    let seen: BodyInit | null | undefined;
    const custom = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.body;
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const transport = fetchPairedWithDispatcher(custom);

    expect(transport).toBe(custom);
    const response = await transport("https://example.test/upload", { method: "POST", body: form });
    expect(response.status).toBe(204);
    expect(seen).toBe(form);
  });
});

describe("dispatcherFetch OAuth responses", () => {
  it("lets the MCP SDK read an undici error response", async () => {
    const body = JSON.stringify({
      error: "registration_not_supported",
      error_description: "Dynamic client registration is not supported",
    });
    const foreign = new UndiciResponse(body, {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    expect(foreign instanceof Response).toBe(false);
    const masked = await parseErrorResponse(foreign as unknown as Response);
    expect(masked.message).toContain("[object Response]");
    expect(masked.message).not.toContain("HTTP 403");

    const served = await withPackageResponse(
      body,
      403,
      {
        "content-type": "application/json",
        "www-authenticate": 'Bearer error="invalid_token"',
      },
      async (response) => {
        expect(response instanceof Response).toBe(true);
        expect(response.status).toBe(403);
        expect(response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
        return parseErrorResponse(response);
      },
    );
    expect(served.message).toBe("Dynamic client registration is not supported");
    expect(served.message).not.toContain("[object Response]");

    const fallback = await withPackageResponse(
      "missing bearer token",
      401,
      { "content-type": "text/plain" },
      (response) => parseErrorResponse(response),
    );
    expect(fallback.message).toContain("HTTP 401");
    expect(fallback.message).toContain("missing bearer token");
    expect(fallback.message).not.toContain("[object Response]");
  });
});

async function withPackageResponse<T>(
  body: string,
  status: number,
  headers: Record<string, string>,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const server = createServer((_request, response) => {
    response.writeHead(status, headers);
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("Missing test server address");
  }
  try {
    const response = await dispatcherFetch(`http://127.0.0.1:${address.port}/oauth-error`);
    return await read(response);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function boundaryOf(contentType: string | undefined): string {
  const match = /boundary="?([^";]+)"?/i.exec(contentType ?? "");
  const boundary = match?.[1];
  if (!boundary) throw new Error("multipart Content-Type is missing a boundary");
  return boundary;
}

async function postThroughPackageFetch(
  send: (url: string, dispatcher: Agent) => Promise<Response>,
): Promise<{ status: number; contentType: string | undefined; body: Buffer; lookups: number }> {
  const chunks: Buffer[] = [];
  let contentType: string | undefined;
  const server = createServer((request, response) => {
    // A local tool can probe any listening loopback port; only uploads are captured.
    if (request.method !== "POST" || request.url !== "/upload") {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    contentType = request.headers["content-type"];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === "string")
    throw new Error("Missing test server address");
  let lookups = 0;
  const dispatcher = new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        lookups += 1;
        const all =
          typeof options === "object" &&
          options != null &&
          "all" in options &&
          options.all === true;
        if (all) {
          callback(null, [{ address: "127.0.0.1", family: 4 }]);
          return;
        }
        callback(null, "127.0.0.1", 4);
      },
    },
  });
  try {
    const response = await send(`http://upload.example.test:${address.port}/upload`, dispatcher);
    return { status: response.status, contentType, body: Buffer.concat(chunks), lookups };
  } finally {
    await dispatcher.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
