import { cn } from "@rakazo/ui-web/lib/utils";
import type * as React from "react";

/**
 * Joins controls side by side into one, such as a field and its button: the inner corners go
 * square and the shared border is drawn once. A field in the group takes the free width, and
 * its focus ring goes around the whole group, in the error colour while the field is invalid. Buttons stretch to the field's height, and a
 * password field's wrapper joins like a bare field.
 */
function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="button-group"
      className={cn(
        "flex w-fit items-stretch rounded-lg [&>*]:focus-visible:relative [&>*]:focus-visible:z-10 [&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none [&>*:not(:first-child)_input]:rounded-l-none [&>*:not(:first-child)_input]:border-l-0 [&>*:not(:last-child)_input]:rounded-r-none *:data-[slot=button]:h-auto [&>input]:flex-1 [&>[data-slot=input-reveal]]:flex-1 [&_input]:focus-visible:border-input [&_input]:focus-visible:ring-0 has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50 [&_input[aria-invalid=true]]:focus-visible:border-destructive has-[input[aria-invalid=true]:focus-visible]:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { ButtonGroup };
