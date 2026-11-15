import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The web type scale in styles.css. Registered as font sizes so `text-heading2 text-foreground`
// keeps both instead of being merged as two text colours.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "caption",
        "label",
        "body-sm",
        "body",
        "body-lg",
        "heading3",
        "heading2",
        "heading1",
        "display",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
