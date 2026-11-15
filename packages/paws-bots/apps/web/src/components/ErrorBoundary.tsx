import { Trans } from "@lingui/react/macro";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@rakazo/ui-web";
import type { ComponentType, ReactNode } from "react";
import { Component } from "react";
import { lazyComponent } from "../lib/preload-recovery";

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
};

/** Keeps a render failure (or a lazy chunk that failed to load) inside its subtree. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Inline fallback for a lazily loaded section inside an otherwise working panel. */
export function SectionLoadFailed() {
  return (
    <div className="px-2.5 pb-2 text-body-sm text-destructive">
      <Trans>Could not load</Trans>
    </div>
  );
}

/**
 * Lazy-loads an overlay. If its chunk fails to load (network blip, missing
 * chunk) or it throws while rendering, the shell and the composer draft stay
 * up. Browsers keep a failed module import for the page's lifetime, so loading
 * the chunk again takes a page refresh.
 */
export function lazyOverlay<Props extends { onClose: () => void }>(
  load: () => Promise<ComponentType<Props>>,
) {
  const Overlay = lazyComponent(load);
  // biome-ignore lint/correctness/noComponentHookFactories: called once per overlay at module scope, like lazy().
  return function LazyOverlay(props: Props) {
    return (
      <ErrorBoundary
        fallback={
          <AlertDialog
            open
            onOpenChange={(open) => {
              if (!open) props.onClose();
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>Could not load</Trans>
                </AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Close</Trans>
                </AlertDialogCancel>
                <Button onClick={() => window.location.reload()}>
                  <Trans>Refresh</Trans>
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        }
      >
        <Overlay {...props} />
      </ErrorBoundary>
    );
  };
}
