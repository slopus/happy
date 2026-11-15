import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { PageTileIcon } from "./page-icon";

/** Why a page is not showing where it should, and what the user can do next. */
export function PageNotice({
  title,
  detail,
  onRetry,
  onClose,
}: {
  title: string;
  detail: string;
  onRetry?: () => void;
  onClose?: () => void;
}) {
  return (
    <div role="alert" className="absolute inset-0 grid place-items-center bg-card px-6 text-center">
      <div className="flex max-w-[360px] flex-col items-center gap-3">
        <PageTileIcon />
        <h2 className="text-heading3 font-medium text-foreground">{title}</h2>
        <p className="text-body text-muted-foreground">{detail}</p>
        <div className="mt-1 flex gap-2">
          {onRetry ? (
            <Button size="sm" onClick={onRetry}>
              <Trans>Try again</Trans>
            </Button>
          ) : null}
          {onClose ? (
            <Button size="sm" variant="outline" onClick={onClose}>
              <Trans>Back to chat</Trans>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The page's shape while it draws: a title bar and a few blocks, still under reduced motion. */
export function PageLoading() {
  return (
    <div
      aria-hidden="true"
      data-testid="page-loading"
      className="pointer-events-none absolute inset-0 flex justify-center bg-card px-6 pt-12"
    >
      <div className="flex w-full max-w-[720px] flex-col gap-4 motion-safe:animate-pulse">
        <div className="h-8 w-2/5 rounded-sm bg-foreground/[0.06]" />
        <div className="h-4 w-3/5 rounded-[6px] bg-foreground/[0.05]" />
        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="h-20 rounded-lg bg-foreground/[0.05]" />
          <div className="h-20 rounded-lg bg-foreground/[0.05]" />
          <div className="h-20 rounded-lg bg-foreground/[0.05]" />
        </div>
        <div className="h-48 rounded-lg bg-foreground/[0.04]" />
      </div>
    </div>
  );
}
