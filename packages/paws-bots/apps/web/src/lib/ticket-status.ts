import { useLingui } from "@lingui/react/macro";
import type { TicketStatus } from "@rakazo/contracts";
import { useMemo } from "react";

export function useTicketStatusLabels(): Record<TicketStatus, string> {
  const { t } = useLingui();
  return useMemo(
    () => ({
      todo: t`To do`,
      doing: t`In progress`,
      review: t`In review`,
      blocked: t`Blocked`,
      done: t`Done`,
      closed: t`Won't do`,
    }),
    [t],
  );
}
