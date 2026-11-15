import { t } from "@lingui/core/macro";
import {
  CONNECTOR_AUTH_UNAVAILABLE,
  isVoiceAccountErrorCode,
  MCP_OAUTH_CLIENT_REQUIRED,
} from "@rakazo/contracts";
import type { CredentialField } from "@rakazo/core";
import {
  authErrorMessage,
  CALL_NOT_RINGING_ERROR,
  errorHelpUrl,
  MAX_PASSWORD_LENGTH,
  MODEL_IMAGE_INPUT_ERROR,
  MODEL_IMAGE_INPUT_UNKNOWN,
  userErrorMessage,
} from "@rakazo/core";

/** Text for a failure: human messages pass through; network and implementation detail become copy. */
export function errorText(error: unknown, fallback = t`Something went wrong. Try again.`): string {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? error.message
        : undefined;
  if (typeof message === "string" && message.trim() === MODEL_IMAGE_INPUT_ERROR)
    return t`This model cannot read images. Choose a model that supports images.`;
  if (typeof message === "string" && message.trim() === MODEL_IMAGE_INPUT_UNKNOWN)
    return t`Image input is not configured for this model.`;
  if (typeof message === "string" && message.trim() === CALL_NOT_RINGING_ERROR)
    return t`This call is no longer ringing.`;
  if (errorCode(error) === CONNECTOR_AUTH_UNAVAILABLE)
    return t`This app needs its own sign-in setup to connect.`;
  if (errorCode(error) === MCP_OAUTH_CLIENT_REQUIRED) return t`Needs an OAuth client ID`;
  return (
    voiceAccountErrorText(error) ??
    userErrorMessage(error, { fallback, offline: t`Could not reach the server` })
  );
}

/** Text for an RPC error or `/api/voice` body whose code says the voice account needs attention. */
export function voiceAccountErrorText(error: unknown): string | undefined {
  const code = errorCode(error);
  if (!isVoiceAccountErrorCode(code)) return undefined;
  return code === "VOICE_OUT_OF_CREDIT"
    ? t`Your voice provider is out of credit.`
    : t`Your voice provider key was rejected.`;
}

export function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

export function credentialIssueText(field: CredentialField): string {
  return field === "email" ? t`Enter a valid email` : t`Enter a password`;
}

/** Text for a failed Better Auth client result (`{ code, message }`). */
export function authErrorText(error: unknown, fallback: string): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "SSO_UNAVAILABLE") return t`SSO is temporarily unavailable. Try again.`;
  if (code === "account_not_linked")
    return t`Sign in to your account, then link this provider in settings`;
  if (code === "email_does_not_match") return t`Use an account with the same email address`;
  if (code === "ACCOUNT_DEACTIVATED") return t`This account is deactivated`;
  if (code === "REGISTRATION_CLOSED") return t`Registration is closed`;
  if (code === "EMAIL_NOT_ALLOWED") return t`Email is not allowed to register`;
  if (code === "EMAIL_VERIFICATION_REQUIRED" || code === "unable_to_link_account")
    return t`Email verification required`;
  if (code === "REAUTHENTICATION_REQUIRED") return t`Sign in again`;
  if (code === "PASSWORD_AUTH_DISABLED") return t`Password sign-in is turned off on this server`;
  if (code === "PASSWORD_TOO_LONG")
    return t`Password must be ${MAX_PASSWORD_LENGTH} characters or fewer`;
  if (code === "EMAIL_DELETION_UNAVAILABLE") return t`Could not continue`;
  if (code === "INVALID_OTP") return t`Invalid code`;
  if (code === "OTP_EXPIRED" || code === "TOO_MANY_ATTEMPTS") return t`Request a new code`;
  return authErrorMessage(error, {
    fallback,
    email: credentialIssueText("email"),
    password: credentialIssueText("password"),
  });
}

/** Keep the documented error code's help link when turning a failure into UI copy. */
export function errorDetails(error: unknown, fallback?: string) {
  return { message: errorText(error, fallback), helpUrl: errorHelpUrl(error) };
}

export type ErrorDetails = ReturnType<typeof errorDetails>;
