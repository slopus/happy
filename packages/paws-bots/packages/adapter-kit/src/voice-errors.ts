import type { VoiceAccountErrorCode } from "@rakazo/contracts";

/**
 * The user's voice provider account refused the request; not a server fault. Without a code,
 * the provider gave a reason clients have no copy for, such as a missing key permission.
 */
export class VoiceAccountError extends Error {
  constructor(
    readonly code: VoiceAccountErrorCode | undefined,
    message: string,
  ) {
    super(message);
    this.name = "VoiceAccountError";
  }
}
