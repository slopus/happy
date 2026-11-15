import { localStore } from "../paws/runtime";
/** Set once a session is seen, so a signed-out return to `/` opens sign-in instead of sign-up. */
export const SIGNED_IN_BEFORE_KEY = "rakazo.signed-in-before";

export function hasSignedInBefore(): boolean {
  try {
    return localStore.getItem(SIGNED_IN_BEFORE_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberSignedIn(): void {
  try {
    localStore.setItem(SIGNED_IN_BEFORE_KEY, "1");
  } catch {
    // Private mode / blocked storage: new visitors and returning ones both land on sign-up.
  }
}

/** A deleted account has nothing to sign in to, so the next visit offers sign up again. */
export function forgetSignedIn(): void {
  try {
    localStore.removeItem(SIGNED_IN_BEFORE_KEY);
  } catch {
    // Blocked storage never held the flag.
  }
}
