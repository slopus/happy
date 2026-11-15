/** Voice failures the user fixes in their own provider account. Clients show their own copy. */
export const VOICE_ACCOUNT_ERROR_CODES = ["VOICE_OUT_OF_CREDIT", "VOICE_KEY_REJECTED"] as const;

export type VoiceAccountErrorCode = (typeof VOICE_ACCOUNT_ERROR_CODES)[number];

export function isVoiceAccountErrorCode(value: unknown): value is VoiceAccountErrorCode {
  return (VOICE_ACCOUNT_ERROR_CODES as readonly unknown[]).includes(value);
}
