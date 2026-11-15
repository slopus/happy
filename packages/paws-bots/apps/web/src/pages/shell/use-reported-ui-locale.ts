import { reportUiLocale } from "@rakazo/core";
import { useEffect, useRef } from "react";
import { i18n } from "../../lib/i18n";
import type { createSpaceRpc } from "../../lib/rpc";
import { normalizeUiLocale } from "../../lib/ui-locale";

/**
 * Keeps the account's saved app language current, so emails are written in it. `saved` is
 * undefined until the bootstrap arrives, and on servers that predate it.
 */
export function useReportedUiLocale(
  rpc: ReturnType<typeof createSpaceRpc>,
  saved: string | null | undefined,
): void {
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (saved === undefined) return;
    const report = () => {
      // Lingui announces a change before the app records it, so read its own locale.
      const locale = i18n.locale;
      if (!locale || locale === (reported.current ?? saved)) return;
      reported.current = locale;
      void reportUiLocale(
        () => normalizeUiLocale(i18n.locale),
        (locale) => rpc.preferences.update({ locale }),
      ).catch(() => {});
    };
    report();
    return i18n.on("change", report);
  }, [rpc, saved]);
}
