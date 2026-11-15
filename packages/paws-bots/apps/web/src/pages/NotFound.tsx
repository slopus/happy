import { Trans } from "@lingui/react/macro";
import { Link } from "react-router-dom";
import { WindowChrome } from "./WindowChrome";

export function NotFoundPage() {
  return (
    <div className="flex min-h-full flex-col bg-background" data-rakazo-surface="not-found">
      <div className="app-drag flex gap-2 px-5 py-[18px]">
        <WindowChrome />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-5 pb-[90px] text-center">
        <div className="flex size-20 items-center justify-center gap-3 rounded-full bg-primary sm:size-24">
          <span className="h-5 w-2.5 translate-x-1.5 -translate-y-1 rounded-full bg-primary-foreground sm:h-6 sm:w-[11px]" />
          <span className="h-5 w-2.5 translate-x-1.5 -translate-y-1 rounded-full bg-primary-foreground sm:h-6 sm:w-[11px]" />
        </div>
        <div className="flex flex-col items-center gap-3">
          <p className="text-body-lg tracking-[0.2em] text-muted-foreground">404</p>
          {/* off-scale: 404 hero display title */}
          <h1 className="text-[40px] leading-tight tracking-[-0.03em] text-foreground sm:text-[52px]">
            <Trans>Page not found</Trans>
          </h1>
        </div>
        <Link
          to="/"
          className="app-no-drag rounded-full bg-accent px-[30px] py-[13px] text-heading3 text-foreground transition hover:scale-[1.04]"
        >
          <Trans>Go home</Trans>
        </Link>
      </main>
    </div>
  );
}
