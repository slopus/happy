import { i18n } from "@lingui/core";
import { t } from "./lingui-core-macro.js";

/** `useLingui` from the macro package, as a test runs it: English text and the shared `i18n`. */
export function useLingui() {
  return { t, i18n, _: i18n._.bind(i18n) };
}
