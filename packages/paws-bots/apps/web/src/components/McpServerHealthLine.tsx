import { Trans } from "@lingui/react/macro";
import type { McpServerHealth } from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import { Disclosure } from "@rakazo/ui-web";
import { CircleDashed, LoaderCircle, TriangleAlert } from "lucide-react";

/**
 * What needs attention on a configured MCP server; a working one shows nothing. Never
 * colour-only: every state pairs an icon with text, and a failure opens its raw log from the
 * status itself so the row stays compact.
 */
export function McpServerHealthLine({
  health,
  checking = false,
}: {
  health: McpServerHealth;
  /** A Test connection run is in flight; shown until the server reports installing. */
  checking?: boolean;
}) {
  if (checking && health.status !== "installing") {
    return (
      <p
        role="status"
        data-testid="mcp-health"
        data-status="checking"
        className="flex items-center gap-1.5 text-label text-muted-foreground"
      >
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        <span>
          <Trans>Checking connection…</Trans>
        </span>
      </p>
    );
  }

  if (health.status === "installing") {
    return (
      <p
        role="status"
        data-testid="mcp-health"
        data-status="installing"
        className="flex items-center gap-1.5 text-label text-muted-foreground"
      >
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        <span>
          <Trans>Installing…</Trans>
        </span>
      </p>
    );
  }

  if (health.status === "ok") return null;

  if (health.status === "error") {
    const summary = (
      <span role="status" className="flex items-center gap-1.5 text-label text-destructive">
        <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        {health.code === MCP_OAUTH_CLIENT_REQUIRED ? (
          <Trans>Needs an OAuth client ID</Trans>
        ) : (
          <Trans>Not working</Trans>
        )}
      </span>
    );
    return (
      <div data-testid="mcp-health" data-status="error">
        {health.message ? (
          <Disclosure data-testid="mcp-health-details" summary={summary}>
            <pre
              dir="ltr"
              className="rk-scroll mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted p-2 text-start font-mono text-caption leading-snug text-foreground wrap-anywhere"
            >
              {health.message}
            </pre>
          </Disclosure>
        ) : (
          summary
        )}
      </div>
    );
  }

  return (
    <p
      role="status"
      data-testid="mcp-health"
      data-status="unknown"
      className="flex items-center gap-1.5 text-label text-muted-foreground"
    >
      <CircleDashed aria-hidden="true" className="size-3.5 shrink-0" />
      <span>
        <Trans>Not checked yet</Trans>
      </span>
    </p>
  );
}
