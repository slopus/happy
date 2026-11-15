import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The top of an item or form opened inside Settings → Vault, in place of the list: Back returns
 * to where it came from, so nothing opens a dialog over the Settings dialog.
 */
export function VaultPageHeader({
  title,
  subtitle,
  leading,
  onBack,
}: {
  title: string;
  subtitle?: ReactNode;
  leading?: ReactNode;
  onBack: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t`Back`}
        data-testid="vault-back"
        // The list was the focus before; the page starts from its way back.
        autoFocus
        className="-ms-2 shrink-0 text-muted-foreground"
        onClick={onBack}
      >
        <ArrowLeft className="rtl:rotate-180" />
      </Button>
      {leading}
      <div className="min-w-0">
        <h3 className="truncate text-body-lg font-medium text-foreground">{title}</h3>
        {subtitle ? <p className="text-body-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
    </div>
  );
}
