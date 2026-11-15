/** The app has no sign-in its connector can offer until its own auth is set up. Clients show their own copy. */
export const CONNECTOR_AUTH_UNAVAILABLE = "CONNECTOR_AUTH_UNAVAILABLE";

/** The MCP server's authorization server cannot register clients itself, so the user must
 * enter a client registered with it. Also the health code of a server that hit this. */
export const MCP_OAUTH_CLIENT_REQUIRED = "MCP_OAUTH_CLIENT_REQUIRED";

export const MCP_OAUTH_REDIRECT_MISMATCH = "MCP_OAUTH_REDIRECT_MISMATCH";
