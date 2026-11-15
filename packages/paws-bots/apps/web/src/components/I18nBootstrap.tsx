import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { useLingui } from "@lingui/react/macro";
import { InputRevealLabelsProvider } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { bootstrapI18n, getActiveUiLocale } from "../lib/i18n";
import { resolveUiLocale } from "../lib/ui-locale";
import { MarkdownChrome } from "./markdown-copy";

export function I18nBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(() => i18n.locale === getActiveUiLocale());

  useEffect(() => {
    let cancelled = false;
    // activateUiLocale already falls back to English on catalog failure.
    void bootstrapI18n(resolveUiLocale()).finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div
        className="grid h-full place-items-center text-muted-foreground/80"
        data-rakazo-app-state="i18n-pending"
      />
    );
  }

  return (
    <I18nProvider i18n={i18n}>
      <KitLabels>
        <MarkdownChrome>{children}</MarkdownChrome>
      </KitLabels>
    </I18nProvider>
  );
}

/** Translations for the text the UI kit draws itself. */
function KitLabels({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  return (
    <InputRevealLabelsProvider show={t`Show password`} hide={t`Hide password`}>
      {children}
    </InputRevealLabelsProvider>
  );
}
