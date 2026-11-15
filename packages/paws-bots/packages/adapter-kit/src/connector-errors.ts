import { CONNECTOR_AUTH_UNAVAILABLE } from "@rakazo/contracts";

/** The connector cannot start a sign-in for this app until the app's own auth is set up there. */
export class ConnectorAuthUnavailableError extends Error {
  readonly code = CONNECTOR_AUTH_UNAVAILABLE;
  constructor(options?: { cause?: unknown }) {
    super("This app needs its own sign-in setup to connect.", options);
    this.name = "ConnectorAuthUnavailableError";
  }
}
