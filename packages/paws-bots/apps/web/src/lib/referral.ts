import { localStore } from "../paws/runtime";
import type { BillingStatus } from "@rakazo/contracts";
import type { RpcClient } from "./rpc";

const STORAGE_KEY = "rakazo:referral";
// What a server-issued invite code can look like; anything else would make billing status fail.
const CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** Keeps an invite code from the landing URL until the account exists to claim it. */
export function captureReferral(search: string): void {
  const code = new URLSearchParams(search).get("ref")?.trim();
  if (!code || !CODE.test(code)) return;
  try {
    localStore.setItem(STORAGE_KEY, code);
  } catch {
    // Storage can be unavailable; the invite just goes unattributed.
  }
}

/**
 * Billing status, with any stored invite code sent along: the server claims it first, so an
 * invited friend's first status already offers the longer trial. The code is kept until a
 * request carrying it succeeds.
 */
export async function loadBillingStatus(client: RpcClient): Promise<BillingStatus> {
  let code: string | null = null;
  try {
    code = localStore.getItem(STORAGE_KEY);
    // A malformed code stored by an older build is dropped rather than sent.
    if (code && !CODE.test(code)) {
      localStore.removeItem(STORAGE_KEY);
      code = null;
    }
  } catch {
    // Storage can be unavailable; billing still loads.
  }
  const status = await client.billing.status(code ? { referralCode: code } : undefined);
  if (code) {
    try {
      localStore.removeItem(STORAGE_KEY);
    } catch {}
  }
  return status;
}
