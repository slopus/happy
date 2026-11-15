import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Check, Link } from "lucide-react";
import { useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import { DownloadPdfButton } from "./DownloadPdfButton";
import { PageFrame } from "./PageFrame";
import { ManualCopy } from "./SharePopover";

const ACTION =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-body-sm font-medium whitespace-nowrap text-foreground ring-[0.5px] ring-border outline-none hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-ring";

/** A shared page for someone without a Rakazo account: a slim header and the page. */
export function PublicPageShell({ title, document }: { title: string; document: string | null }) {
  const { t } = useLingui();
  const [copied, copy, copyFailed] = useCopyText();
  const [height, setHeight] = useState(0);
  return (
    <div
      data-page-print
      className="flex h-full min-h-0 flex-col overflow-auto bg-card text-foreground print:h-auto print:overflow-visible print:bg-transparent"
    >
      <header className="z-10 flex h-12 shrink-0 bg-card print:hidden items-center justify-between gap-3 pr-2 pl-3.5">
        <a
          href="/"
          target="_blank"
          rel="noopener"
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full py-1 pr-2 text-body-sm text-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img src="/favicon-32x32.png" alt="" className="size-4 rounded-full" />
          <Trans>Open Rakazo</Trans>
        </a>
        <h1 className="sr-only">{title}</h1>
        <nav aria-label={t`Page actions`} className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            className={`${ACTION} ${copied ? "text-success" : ""}`}
            onClick={() => copy(window.location.href)}
          >
            {copied ? (
              <Check className="size-4" strokeWidth={1.5} />
            ) : (
              <Link className="size-4" strokeWidth={1.5} />
            )}
            <span className="max-[560px]:sr-only">
              {copied ? <Trans>Copied</Trans> : <Trans>Copy link</Trans>}
            </span>
          </Button>
          <DownloadPdfButton className={ACTION} labelClassName="max-[560px]:sr-only" />
          <span role="status" className="sr-only">
            {copied ? t`Link copied` : ""}
          </span>
        </nav>
      </header>
      {copyFailed ? (
        <div className="z-10 shrink-0 bg-card px-3.5 pb-3 print:hidden">
          <div className="mx-auto max-w-[480px]">
            <ManualCopy url={window.location.href} />
          </div>
        </div>
      ) : null}
      {/* Keep anchor scrolling below the header; expand the whole document when printing. */}
      <div className="min-h-32 flex-1 overflow-auto print:min-h-0 print:overflow-visible">
        <div className="min-h-full" style={{ height: height || undefined }}>
          {document !== null ? (
            <PageFrame document={document} title={title} interactive onHeight={setHeight} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
