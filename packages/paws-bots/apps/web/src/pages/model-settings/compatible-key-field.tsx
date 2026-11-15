import { Trans } from "@lingui/react/macro";
import { Disclosure } from "@rakazo/ui-web";
import type { ReactNode } from "react";

/** A hosted endpoint needs its key, so the field shows; elsewhere it stays tucked away. */
export function CompatibleKeyField({
  keyRequired,
  className,
  children,
}: {
  keyRequired: boolean;
  className?: string;
  children: ReactNode;
}) {
  return keyRequired ? (
    <div className={className}>
      <span>
        <Trans>API key</Trans>
      </span>
      {children}
    </div>
  ) : (
    <Disclosure className={className} summary={<Trans>API key</Trans>}>
      {children}
    </Disclosure>
  );
}
