import type { AuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createManualAnthropicOAuthLogin,
  MAX_ANTHROPIC_TOKEN_RESPONSE_BYTES,
} from "./pi-anthropic-oauth.js";

describe("manual Anthropic OAuth", () => {
  it("runs concurrent paste-back flows without binding a callback port", async () => {
    const requests: RequestInit[] = [];
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Response.json({
        access_token: `access-${requests.length}`,
        refresh_token: `refresh-${requests.length}`,
        expires_in: 3600,
      });
    }) as typeof fetch;
    let verifier = 0;
    const login = createManualAnthropicOAuthLogin({
      fetch: fakeFetch,
      createVerifier: () => `verifier-${++verifier}`,
    });

    const [first, second] = await Promise.all([
      login(interactionFor("code-one#verifier-1")),
      login(interactionFor("code-two#verifier-2")),
    ]);

    expect(first.access).toBe("access-1");
    expect(second.access).toBe("access-2");
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      code: "code-one",
      state: "verifier-1",
      code_verifier: "verifier-1",
      redirect_uri: "http://localhost:53692/callback",
    });
  });

  it("sends clients without a loopback listener to Anthropic's code page", async () => {
    const requests: RequestInit[] = [];
    let authorizeUrl = "";
    const login = createManualAnthropicOAuthLogin({
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
      }) as typeof fetch,
      createVerifier: () => "verifier",
      codePage: true,
    });
    const interaction = interactionFor("code#verifier");
    const notify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeUrl = event.url;
      notify(event);
    };

    await login(interaction);

    const redirect = "https://platform.claude.com/oauth/code/callback";
    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(redirect);
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({ redirect_uri: redirect });
  });

  it("rejects a pasted callback with the wrong OAuth state before exchange", async () => {
    let requested = false;
    const login = createManualAnthropicOAuthLogin({
      fetch: (async () => {
        requested = true;
        return Response.json({});
      }) as typeof fetch,
      createVerifier: () => "expected-state",
    });

    await expect(
      login(interactionFor("http://localhost:53692/callback?code=x&state=wrong-state")),
    ).rejects.toThrow(/state mismatch/i);
    expect(requested).toBe(false);
  });

  it("rejects and cancels a declared oversized token response", async () => {
    const response = new Response("oversized", {
      headers: { "content-length": String(MAX_ANTHROPIC_TOKEN_RESPONSE_BYTES + 1) },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    const login = createManualAnthropicOAuthLogin({
      fetch: vi.fn().mockResolvedValue(response),
      createVerifier: () => "expected-state",
    });

    await expect(login(interactionFor("code#expected-state"))).rejects.toThrow(
      "Anthropic token exchange response is too large.",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait past cancellation when an oversized body cancel hangs", async () => {
    let cancelStarted = false;
    const hangingBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true;
        return new Promise(() => undefined);
      },
    });
    const abort = new AbortController();
    const login = createManualAnthropicOAuthLogin({
      fetch: vi.fn(async () => {
        setTimeout(() => abort.abort(), 20);
        return new Response(hangingBody, {
          headers: { "content-length": String(MAX_ANTHROPIC_TOKEN_RESPONSE_BYTES + 1) },
        });
      }),
      createVerifier: () => "expected-state",
    });

    const started = Date.now();
    await expect(login(interactionFor("code#expected-state", abort.signal))).rejects.toThrow(
      "Anthropic token exchange response is too large.",
    );
    expect(cancelStarted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("caps a streamed token response without a content length", async () => {
    const login = createManualAnthropicOAuthLogin({
      fetch: vi
        .fn()
        .mockResolvedValue(new Response(new Uint8Array(MAX_ANTHROPIC_TOKEN_RESPONSE_BYTES + 1))),
      createVerifier: () => "expected-state",
    });

    await expect(login(interactionFor("code#expected-state"))).rejects.toThrow(
      "Anthropic token exchange response is too large.",
    );
  });

  it("uses the request deadline while reading the token response", async () => {
    const requestSignals: AbortSignal[] = [];
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
      }),
    );
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestSignals.push(init?.signal as AbortSignal);
      return response;
    });
    const login = createManualAnthropicOAuthLogin({
      fetch: fetch as typeof globalThis.fetch,
      createVerifier: () => "expected-state",
    });
    const controller = new AbortController();
    const result = login(interactionFor("code#expected-state", controller.signal));
    controller.abort(new Error("login cancelled"));

    await expect(result).rejects.toThrow("login cancelled");
    expect(requestSignals[0]?.aborted).toBe(true);
  });
});

function interactionFor(input: string, signal = new AbortController().signal): AuthInteraction {
  return {
    signal,
    async prompt() {
      return input;
    },
    notify(event) {
      if (event.type === "auth_url") {
        expect(event.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
      }
    },
  };
}
