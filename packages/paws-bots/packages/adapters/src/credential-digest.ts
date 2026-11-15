import { createHash } from "node:crypto";

/** Compare held credentials without retaining an extra plaintext copy. */
export function credentialDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
