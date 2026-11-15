import { createHash, randomBytes } from "node:crypto";
import type { AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Desktop listens here and receives the code itself. */
const LOOPBACK_REDIRECT_URI = "http://localhost:53692/callback";
/** Anthropic's page that shows the code to copy, for clients with no loopback listener. */
const CODE_PAGE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
export const MAX_ANTHROPIC_TOKEN_RESPONSE_BYTES = 64 * 1024;

// Public OAuth client identifier used by Claude Code. This is not a client secret.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

type ManualAnthropicOAuthOptions = {
  fetch?: typeof fetch;
  createVerifier?: () => string;
  codePage?: boolean;
};

export function createManualAnthropicOAuthLogin(options: ManualAnthropicOAuthOptions = {}) {
  const request = options.fetch ?? fetch;
  const createVerifier = options.createVerifier ?? (() => randomBytes(32).toString("base64url"));
  const redirectUri = options.codePage ? CODE_PAGE_REDIRECT_URI : LOOPBACK_REDIRECT_URI;

  return async (interaction: AuthInteraction): Promise<OAuthCredential> => {
    const signal = interaction.signal ?? new AbortController().signal;
    const verifier = createVerifier();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.search = new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: verifier,
    }).toString();

    interaction.notify({
      type: "auth_url",
      url: authorizeUrl.toString(),
      instructions: "Complete login in your browser, then paste the code it shows.",
    });
    const input = await interaction.prompt({
      type: "manual_code",
      message: "Paste the authorization code:",
      signal,
    });
    const authorization = parseAuthorizationInput(input);
    if (!authorization.code) throw new Error("Missing authorization code.");
    if (authorization.state && authorization.state !== verifier) {
      throw new Error("OAuth state mismatch.");
    }

    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const response = await request(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: authorization.code,
        state: authorization.state ?? verifier,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      signal: requestSignal,
    });
    if (!response.ok) {
      throw new Error(`Anthropic token exchange failed (${response.status}). Start sign-in again.`);
    }

    const body = await readTokenResponse(response, requestSignal);
    if (!body || typeof body !== "object") {
      throw new Error("Anthropic token exchange returned an invalid credential.");
    }
    const credential = body as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof credential.access_token !== "string" ||
      typeof credential.refresh_token !== "string" ||
      typeof credential.expires_in !== "number" ||
      !Number.isFinite(credential.expires_in) ||
      credential.expires_in <= 0
    ) {
      throw new Error("Anthropic token exchange returned an invalid credential.");
    }
    return {
      type: "oauth",
      access: credential.access_token,
      refresh: credential.refresh_token,
      expires: Date.now() + credential.expires_in * 1000 - 5 * 60 * 1000,
    };
  };
}

async function readTokenResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_ANTHROPIC_TOKEN_RESPONSE_BYTES) {
    const cancel = response.body?.cancel() ?? Promise.resolve();
    await withAbort(
      cancel.catch(() => undefined),
      signal,
    ).catch(() => undefined);
    throw new Error("Anthropic token exchange response is too large.");
  }
  try {
    const bytes = await readBodyCapped(response, MAX_ANTHROPIC_TOKEN_RESPONSE_BYTES, signal);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error("Anthropic token exchange response is too large.");
    }
    throw error;
  }
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Continue with the compact forms supported by the provider flow.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}
