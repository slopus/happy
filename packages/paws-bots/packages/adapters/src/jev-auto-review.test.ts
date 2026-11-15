import type { AdapterContext, AutoReviewRequest } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { JevAutoReviewProvider } from "./jev-auto-review.js";

const context: AdapterContext = {
  operationId: "auto-review",
  traceId: "auto-review",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const request: AutoReviewRequest = {
  toolName: "gmail_send_email",
  connectorKind: "gmail",
  args: { to: "a@b.test", apiKey: "[redacted]" },
  userTask: "Draft a reply",
  botDescription: "Mail bot",
  matchingRules: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("JevAutoReviewProvider", () => {
  it("maps a pass choice to pass", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return jsonResponse({
        model: "jev-latest",
        answers: { decision: { type: "choice", choice: "pass", confidence: 0.9 } },
      });
    };
    const provider = new JevAutoReviewProvider({ apiKey: "ts-key", fetch: fetchMock });
    await expect(provider.review(request, context)).resolves.toEqual({
      decision: "pass",
      model: "jev/jev-latest",
    });
    expect(seen).toHaveLength(1);
    const init = seen[0]?.init;
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init).toBeDefined();
    expect(init?.redirect).toBe("error");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer ts-key");
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      state: { toolName: string; args: Record<string, unknown> };
      questions: { decision: { type: string; criteria: { pass: string; ask: string } } };
    };
    expect(body.model).toBe("jev-latest");
    expect(body.state.toolName).toBe("gmail_send_email");
    expect(body.state.args).toEqual({ to: "a@b.test", apiKey: "[redacted]" });
    expect(body.questions.decision.type).toBe("choice");
    expect(JSON.stringify(body)).not.toContain("ts-key");
  });

  it("asks without calling the checker when the arguments are too long to show in full", async () => {
    let calls = 0;
    const provider = new JevAutoReviewProvider({
      apiKey: "ts-key",
      fetch: async () => {
        calls += 1;
        return jsonResponse({
          answers: { decision: { type: "choice", choice: "pass", confidence: 0.9 } },
        });
      },
    });
    const result = await provider.review(
      {
        ...request,
        toolName: "multi_execute",
        args: {
          actions: [
            { tool: "notes_create", body: "a".repeat(10_000) },
            { tool: "gmail_send_email", to: "someone@else.test" },
          ],
        },
      },
      context,
    );
    expect(result.decision).toBe("ask");
    expect(calls).toBe(0);
  });

  it("sends a new site's whole URL and asks about the site", async () => {
    let sent = "";
    const provider = new JevAutoReviewProvider({
      apiKey: "ts-key",
      fetch: async (_url, init) => {
        sent = String(init?.body);
        return jsonResponse({
          answers: { decision: { type: "choice", choice: "ask", confidence: 0.9 } },
        });
      },
    });
    const url = `https://attacker.test/?q=${"a".repeat(1_800)}`;
    await provider.review(
      { ...request, toolName: "web_fetch", args: { url }, newSite: true },
      context,
    );
    const body = JSON.parse(sent) as {
      state: { args: Record<string, unknown>; newSite?: boolean };
      questions: { decision: { criteria: { pass: string } } };
    };
    expect(body.state.args).toEqual({ url });
    expect(body.state.newSite).toBe(true);
    expect(body.questions.decision.criteria.pass).toContain("this site");
  });

  it("maps an ask choice to ask", async () => {
    const provider = new JevAutoReviewProvider({
      apiKey: "ts-key",
      fetch: async () =>
        jsonResponse({
          model: "jev-latest",
          answers: { decision: { type: "choice", choice: "ask", confidence: 0.88 } },
        }),
    });
    await expect(provider.review(request, context)).resolves.toMatchObject({
      decision: "ask",
      model: "jev/jev-latest",
    });
  });

  it("asks when pass confidence is below the floor", async () => {
    const provider = new JevAutoReviewProvider({
      apiKey: "ts-key",
      minConfidence: 0.7,
      fetch: async () =>
        jsonResponse({
          model: "jev-latest",
          answers: { decision: { type: "choice", choice: "pass", confidence: 0.4 } },
        }),
    });
    await expect(provider.review(request, context)).resolves.toEqual({
      decision: "ask",
      reason: "Checker is unsure.",
      model: "jev/jev-latest",
    });
  });

  it("asks when pass is missing confidence", async () => {
    const provider = new JevAutoReviewProvider({
      apiKey: "ts-key",
      minConfidence: 0.7,
      fetch: async () =>
        jsonResponse({
          model: "jev-latest",
          answers: { decision: { type: "choice", choice: "pass" } },
        }),
    });
    await expect(provider.review(request, context)).resolves.toEqual({
      decision: "ask",
      reason: "Checker is unsure.",
      model: "jev/jev-latest",
    });
  });

  it("maps invalid answers to error", async () => {
    const provider = new JevAutoReviewProvider({
      apiKey: "ts-key",
      fetch: async () =>
        jsonResponse({
          model: "jev-latest",
          answers: { decision: { type: "choice", choice: "maybe" } },
        }),
    });
    await expect(provider.review(request, context)).resolves.toMatchObject({
      decision: "error",
      reason: "Checker returned no decision.",
    });
  });

  it.each([
    [401, "Checker could not authenticate."],
    [422, "Checker request was invalid."],
    [429, "Checker is busy."],
    [529, "Checker is busy."],
    [500, "Checker timed out or failed."],
  ] as const)("maps HTTP %s to error", async (status, reason) => {
    const provider = new JevAutoReviewProvider({
      apiKey: "fake-key",
      fetch: async () => new Response("fake-key leaked", { status }),
    });
    const result = await provider.review(request, context);
    expect(result).toMatchObject({ decision: "error", reason });
    expect(JSON.stringify(result)).not.toContain("fake-key");
  });

  it("maps network failure to error without throwing", async () => {
    const provider = new JevAutoReviewProvider({
      apiKey: "ts-key",
      fetch: async () => {
        throw new Error("offline");
      },
    });
    await expect(provider.review(request, context)).resolves.toMatchObject({
      decision: "error",
      reason: "Checker timed out or failed.",
    });
  });

  it("does not send secret-looking arg keys that the caller already redacted", async () => {
    const seen: RequestInit[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      if (init) seen.push(init);
      return jsonResponse({
        model: "jev-latest",
        answers: { decision: { type: "choice", choice: "pass", confidence: 0.95 } },
      });
    };
    const provider = new JevAutoReviewProvider({ apiKey: "ts-key", fetch: fetchMock });
    await provider.review(
      { ...request, args: { password: "[redacted]", to: "a@b.test" } },
      context,
    );
    const body = JSON.parse(String(seen[0]?.body)) as { state: { args: Record<string, unknown> } };
    expect(body.state.args.password).toBe("[redacted]");
    expect(JSON.stringify(body)).not.toMatch(/sk-|secret-value/i);
  });
});
