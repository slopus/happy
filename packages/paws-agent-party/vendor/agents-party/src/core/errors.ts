/**
 * Stable error codes — one vocabulary for the whole system. Core and stores throw `PartyError`s; the HTTP server maps
 * codes onto statuses; the remote client maps them back onto the same errors. No message-string matching anywhere.
 */

export type PartyErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'PARTY_NOT_FOUND'
  | 'INVALID_NAME'
  | 'NAME_TAKEN'
  | 'NOT_A_PARTICIPANT'
  | 'RATE_LIMITED'
  | 'STORAGE_FULL'
  | 'INTERNAL'

export class PartyError extends Error {
  constructor(
    readonly code: PartyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PartyError'
  }
}

export const HTTP_STATUS: Record<PartyErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PARTY_NOT_FOUND: 404,
  INVALID_NAME: 400,
  NAME_TAKEN: 409,
  NOT_A_PARTICIPANT: 403,
  RATE_LIMITED: 429,
  STORAGE_FULL: 507,
  INTERNAL: 500,
}

/** Rebuild a PartyError from a wire `{ code, message }`; unknown codes stay visible as INTERNAL, not BAD_REQUEST. */
export const errorFromCode = (code: string, message: string): PartyError =>
  new PartyError((Object.keys(HTTP_STATUS) as PartyErrorCode[]).find((c) => c === code) ?? 'INTERNAL', message)
