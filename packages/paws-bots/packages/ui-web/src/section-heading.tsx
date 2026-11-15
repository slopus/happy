import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./lib/utils.js";

const sectionHeadingVariants = cva("font-medium", {
  variants: {
    variant: {
      heading: "text-heading3 text-foreground",
      title: "text-body-lg text-foreground",
      label: "text-label text-muted-foreground",
    },
  },
  defaultVariants: { variant: "title" },
});

/**
 * Names a section within a page or panel; `heading` is the larger tier for settings sections and
 * `label` the quieter tier for side-panel groups.
 */
function SectionHeading({
  as: Tag = "h3",
  variant,
  className,
  ...props
}: ComponentProps<"h3"> &
  VariantProps<typeof sectionHeadingVariants> & { as?: "h2" | "h3" | "h4" }) {
  return (
    <Tag
      data-slot="section-heading"
      className={cn(sectionHeadingVariants({ variant }), className)}
      {...props}
    />
  );
}

export { SectionHeading };
