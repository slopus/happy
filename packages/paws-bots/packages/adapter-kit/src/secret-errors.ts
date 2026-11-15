export class SecretStoreUnavailableError extends Error {
  readonly code = "SECRET_STORE_UNAVAILABLE";
  constructor(
    readonly status?: number,
    message = "Secret storage is unavailable; retry later",
  ) {
    super(message);
    this.name = "SecretStoreUnavailableError";
  }
}
export class SecretNotFoundError extends Error {
  readonly code = "SECRET_NOT_FOUND";
  constructor() {
    super("Secret reference does not resolve");
    this.name = "SecretNotFoundError";
  }
}
