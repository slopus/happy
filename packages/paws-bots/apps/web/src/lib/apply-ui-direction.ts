import { hostRoot } from "../paws/runtime";
import { textDirectionForLocale } from "@rakazo/core";
import { resolveUiLocale } from "./ui-locale";

export function applyUiDirection(locale: string = resolveUiLocale()) {
  const direction = textDirectionForLocale(locale);
  hostRoot().dir = direction;
  hostRoot().lang = locale;
  return direction;
}
