import { useLingui } from "@lingui/react/macro";
import { ImageOff } from "lucide-react";

/** Subtle warning for a model that cannot read images. Screen readers get the words via `aria-describedby`. */
export function TextOnlyMark() {
  const { t } = useLingui();
  return (
    <span className="flex items-center" title={t`Can't read images`} aria-hidden="true">
      <ImageOff size={14} strokeWidth={1.8} />
    </span>
  );
}
