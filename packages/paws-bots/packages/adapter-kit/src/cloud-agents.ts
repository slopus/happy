/**
 * A provider definitively refused a request. `not_found` means the agent or run no
 * longer exists; `expired` means the agent can no longer accept runs.
 */
export class CloudAgentRequestRejected extends Error {
  constructor(readonly reason: "invalid" | "not_found" | "expired" = "invalid") {
    super("Cloud agent request was rejected. Check the provider configuration and request.");
    this.name = "CloudAgentRequestRejected";
  }
}

/**
 * The provider refused the credential, rate limited the request, or failed before
 * a mutation was sent. None says anything about the agent itself and nothing was
 * accepted, so callers retry instead of failing it.
 */
export class CloudAgentRetryLater extends Error {
  constructor(
    readonly reason: "credential" | "rate_limited" | "unavailable",
    readonly retryAfterMs?: number,
  ) {
    super(
      reason === "credential"
        ? "Cloud agent credential was rejected."
        : reason === "rate_limited"
          ? "Cloud agent requests are rate limited."
          : "Cloud agent provider is unavailable.",
    );
    this.name = "CloudAgentRetryLater";
  }
}
