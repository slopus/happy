import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Download } from "lucide-react";

/**
 * Saves the open page as a PDF through the browser's print dialog. Whatever surrounds the page
 * marks itself `data-page-print`, so only the page reaches the paper (styles.css).
 */
export function DownloadPdfButton({
  className,
  iconClassName = "size-4",
  labelClassName,
}: {
  className: string;
  iconClassName?: string;
  labelClassName?: string;
}) {
  const { t } = useLingui();
  return (
    <Button
      variant="ghost"
      className={className}
      title={t`Opens your browser's print dialog. Choose Save as PDF as the destination.`}
      onClick={() => window.print()}
    >
      <Download className={iconClassName} strokeWidth={1.5} />
      <span className={labelClassName}>
        <Trans>Download PDF</Trans>
      </span>
    </Button>
  );
}
