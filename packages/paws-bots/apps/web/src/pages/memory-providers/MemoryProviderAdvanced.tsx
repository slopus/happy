import { Trans } from "@lingui/react/macro";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@rakazo/ui-web";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

export function MemoryProviderAdvanced({ children }: { children: ReactNode }) {
  return (
    <Collapsible className="mt-4">
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
        <Trans>Advanced</Trans>
        <ChevronDownIcon className="size-4" />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
