import { Dialog, DialogContent } from "@rakazo/ui-web/components/ui/dialog";
import { useIsMobile } from "@rakazo/ui-web/hooks/use-mobile";
import { cn } from "@rakazo/ui-web/lib/utils";
import type { ReactNode } from "react";
import { useRef } from "react";

/**
 * A call's window. Below md it covers the app, so it is a modal dialog that holds focus and
 * returns it; from md up it is a card beside the app, which stays usable.
 */
export function CallWindow({
  className,
  children,
  ...attributes
}: {
  "data-testid": string;
  role: "dialog" | "alertdialog";
  "aria-label": string;
  className: string;
  children: ReactNode;
}) {
  const fullScreen = useIsMobile();
  const popup = useRef<HTMLDivElement>(null);
  if (!fullScreen) {
    return (
      <div {...attributes} className={className}>
        {children}
      </div>
    );
  }
  return (
    <Dialog
      open
      disablePointerDismissal
      // The call's own state opens and closes the window; Escape stays with the call's handlers.
      onOpenChange={(_, details) => {
        details.cancel();
        details.allowPropagation();
      }}
    >
      <DialogContent
        ref={popup}
        // Focus the window itself, so a key meant for the composer cannot press a call button.
        initialFocus={popup}
        showCloseButton={false}
        {...attributes}
        className={cn(
          "max-w-none translate-none gap-0 rounded-none p-0 ring-0 sm:max-w-none",
          className,
        )}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
