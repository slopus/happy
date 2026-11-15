import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import type { ErrorDetails } from "../lib/user-error";

/** Inline failures stay brief; documented recovery instructions open only on request. */
export function ErrorNotice({ error, children }: { error: ErrorDetails; children?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-body text-destructive">
      <span>{error.message}</span>
      {error.helpUrl ? (
        <a href={error.helpUrl} target="_blank" rel="noopener noreferrer" className="underline">
          <Trans>Troubleshoot</Trans>
        </a>
      ) : null}
      {children}
    </div>
  );
}
