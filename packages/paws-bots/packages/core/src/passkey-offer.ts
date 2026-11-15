/** A session opened this soon after the account was created is its first one. */
const FIRST_SESSION_WINDOW_MS = 60 * 60_000;

/**
 * Whether to offer adding a passkey once, right after signup: the first
 * session of a new account that has no passkey and has not dismissed the offer.
 */
export function shouldOfferPasskey(input: {
  userCreatedAt: Date | string;
  sessionCreatedAt: Date | string;
  passkeyCount: number;
  dismissed: boolean;
}): boolean {
  if (input.dismissed || input.passkeyCount > 0) return false;
  const gap = new Date(input.sessionCreatedAt).getTime() - new Date(input.userCreatedAt).getTime();
  return Number.isFinite(gap) && gap >= 0 && gap < FIRST_SESSION_WINDOW_MS;
}

/** Storage key that remembers a dismissed offer for one account on this device. */
export function passkeyOfferDismissedKey(userId: string): string {
  return `rakazo.passkey-offer-dismissed.${userId}`;
}

/** WebAuthn requires the page host to equal the relying party ID or be a subdomain of it. */
export function hostMatchesPasskeyRpId(host: string, rpId: string | null | undefined): boolean {
  if (!rpId) return false;
  const normalized = host.toLowerCase();
  const rp = rpId.toLowerCase();
  return normalized === rp || normalized.endsWith(`.${rp}`);
}
