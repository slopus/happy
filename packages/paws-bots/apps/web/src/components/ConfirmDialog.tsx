import { Trans } from "@lingui/react/macro";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@rakazo/ui-web";
import type { ReactNode } from "react";

/**
 * A confirmation with Cancel and one action. While `busy`, both buttons are disabled and the
 * dialog cannot be dismissed. `confirmDisabled` disables only the action.
 */
export function ConfirmDialog({
  open = true,
  onCancel,
  title,
  description,
  children,
  error,
  confirmLabel,
  onConfirm,
  busy = false,
  confirmDisabled = false,
  variant = "destructive",
}: {
  open?: boolean;
  onCancel: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  error?: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  busy?: boolean;
  confirmDisabled?: boolean;
  variant?: "destructive" | "default";
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        {error ? (
          <p role="alert" className="text-body text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            variant={variant}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
