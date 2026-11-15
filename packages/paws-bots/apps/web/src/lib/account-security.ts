import { pawsFetch } from "../paws/runtime";
import { t } from "@lingui/core/macro";
import { accountSecuritySchema, legacyAccountSecurity } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";
import { authErrorText } from "./user-error";

export async function fetchAccountSecurity() {
  const response = await pawsFetch("/api/auth/account-security", {
    signal: AbortSignal.timeout(8_000),
  });
  // Electron ships this client independently of the connected API version.
  if (response.status === 404) return legacyAccountSecurity;
  if (!response.ok) throw new Error(t`Could not load sign-in options`);
  try {
    return accountSecuritySchema.parse(await readBoundedJsonResponse<unknown>(response, 64 * 1024));
  } catch {
    throw new Error(t`Could not load sign-in options`);
  }
}

async function postAuth(path: string, body?: Record<string, string>) {
  const response = await pawsFetch(`/api/auth${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  if (!response.ok) {
    let error: unknown;
    try {
      error = await readBoundedJsonResponse<unknown>(response, 64 * 1024);
    } catch {
      // Gateways may return HTML or an empty body.
    }
    throw new Error(authErrorText(error, t`Could not continue`));
  }
}

export const requestAccountDeletionCode = () => postAuth("/request-account-deletion");

/** Emails a confirmation code to an account without a password. */
export const requestIdentityCode = () => postAuth("/request-identity-code");

/** Confirms this session's identity for the next few minutes. */
export const confirmIdentity = (proof: { password: string } | { code: string }) =>
  postAuth("/confirm-identity", proof);
