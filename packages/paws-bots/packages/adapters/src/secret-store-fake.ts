import { expect, vi } from "vitest";
import type { InfisicalSecretStoreOptions } from "./infisical-secret-store.js";

const errorNames = { GET: "GetSecretByName", POST: "CreateSecret", DELETE: "DeleteSecret" };

/** Strict offline REST fake shared by provider and credential-boundary tests. */
export function infisicalFake() {
  const values = new Map<string, string>();
  const folders = new Set(["/rakazo"]);
  const statuses: number[] = [];
  const loginStatuses: number[] = [];
  let logins = 0;
  let expiresIn = 3600;
  let retryAfter: string | undefined = "1";
  let offline = false;
  let gate: (() => Promise<void>) | undefined;
  // Infisical's rate limiter always sends Retry-After with a 429.
  const failure = (status: number, message = "private response value") =>
    Response.json(
      { statusCode: status, message },
      { status, headers: status === 429 && retryAfter ? { "Retry-After": retryAfter } : {} },
    );
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://secrets.example.test");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    init?.signal?.throwIfAborted();
    if (offline) throw new Error("private response value");
    if (gate) await gate();
    init?.signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    if (url.pathname === "/api/v1/auth/universal-auth/login") {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        clientId: "fake-client",
        clientSecret: "fake-client-secret",
      });
      logins++;
      const status = loginStatuses.shift() ?? 200;
      if (status !== 200) return failure(status);
      return Response.json({ accessToken: `token-${logins}`, expiresIn });
    }
    expect(headers.get("authorization")).toMatch(/^Bearer token-[1-9][0-9]*$/);
    expect(Number(headers.get("authorization")?.split("-").at(-1))).toBeLessThanOrEqual(logins);
    expect(url.pathname).toMatch(
      /^\/api\/v4\/secrets\/(rakazo_[a-f0-9]{24}_[a-f0-9-]{36}|rakazo_start_check)$/,
    );
    const key = url.pathname.split("/").at(-1)!;
    const method = init?.method as keyof typeof errorNames;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const request = method === "GET" ? Object.fromEntries(url.searchParams) : body;
    const scope = {
      projectId: "fake-project",
      environment: expect.any(String),
      secretPath: expect.any(String),
      type: "shared",
    };
    expect(request).toEqual(
      method === "GET"
        ? { ...scope, expandSecretReferences: "false", includeImports: "false" }
        : method === "POST"
          ? { ...scope, secretValue: expect.any(String) }
          : scope,
    );
    const status = statuses.shift();
    if (status && status !== 200) return failure(status);
    if (request.environment !== "test" || !folders.has(request.secretPath))
      return Response.json(
        {
          statusCode: 404,
          message: `Folder with path '${request.secretPath}' in environment with slug '${request.environment}' not found`,
          error: errorNames[method],
        },
        { status: 404 },
      );
    if (method === "POST") {
      values.set(key, body.secretValue);
      return Response.json({ secret: { secretValue: body.secretValue } });
    }
    if (!values.has(key))
      return Response.json(
        {
          statusCode: 404,
          message: method === "DELETE" ? "Secret not found" : `Secret with name '${key}' not found`,
          error: "NotFound",
        },
        { status: 404 },
      );
    if (method === "DELETE") {
      const secretValue = values.get(key);
      values.delete(key);
      return Response.json({ secret: { secretValue } });
    }
    return Response.json({ secret: { secretValue: values.get(key) } });
  });
  const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
    signal.throwIfAborted();
  });
  const options: InfisicalSecretStoreOptions = {
    baseUrl: "https://secrets.example.test",
    clientId: "fake-client",
    clientSecret: "fake-client-secret",
    projectId: "fake-project",
    environment: "test",
    folder: "/rakazo",
    fetch: fetcher,
    sleep,
  };
  return {
    values,
    folders,
    statuses,
    loginStatuses,
    fetcher,
    sleep,
    options,
    get logins() {
      return logins;
    },
    set expiresIn(value: number) {
      expiresIn = value;
    },
    set retryAfter(value: string | undefined) {
      retryAfter = value;
    },
    set offline(value: boolean) {
      offline = value;
    },
    set gate(value: (() => Promise<void>) | undefined) {
      gate = value;
    },
  };
}
