import { I18nManager } from "react-native";

// Hebrew, Arabic and the other right-to-left scripts, with their presentation forms.
const RTL_LETTER =
  /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

// iOS shapes each paragraph by its first letter but aligns it, and orders rows, by the app's
// direction. Returns the text's direction when it differs from the app's.
export function contraryDirection(text: string) {
  const rtl = RTL_LETTER.test(/\p{L}/u.exec(text)?.[0] ?? "");
  if (rtl === I18nManager.isRTL) return undefined;
  return rtl ? "rtl" : "ltr";
}
