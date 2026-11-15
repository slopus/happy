import { cn } from "@rakazo/ui-web/lib/utils";
import { CheckIcon } from "lucide-react";
import * as React from "react";

type StepperStatus = "complete" | "current" | "upcoming";

type StepperStep = {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  status: StepperStatus;
  /** Whether the step can be opened from the list. The current step never can. */
  selectable?: boolean;
  /** Something is happening in the step; its description shimmers. */
  busy?: boolean;
};

/**
 * A vertical list of steps that shows which are done, which is open, and which are left. When a
 * step is completed its circle fills from the top, then the line to the next step draws down;
 * going back plays the same in reverse. Steps that are already done when the list appears are
 * drawn filled, without the animation. Each delay sits on the state a change goes into.
 */
function Stepper({
  steps,
  onSelect,
  completeLabel,
  className,
  ...props
}: Omit<React.ComponentProps<"ol">, "onSelect"> & {
  steps: readonly StepperStep[];
  onSelect?: (id: string) => void;
  /** Read out after a completed step's title, in the app's language; the kit is not translated. */
  completeLabel: string;
}) {
  const baseId = React.useId();
  return (
    <ol data-slot="stepper" className={cn("flex flex-col", className)} {...props}>
      {steps.map((step, index) => {
        const selectable = step.selectable === true && step.status !== "current" && onSelect;
        const complete = step.status === "complete";
        // From the list's own id and the position: a step id may hold characters an id cannot.
        const titleId = `${baseId}-title-${index}`;
        const statusId = `${baseId}-status-${index}`;
        return (
          <li
            key={step.id}
            data-slot="stepper-step"
            data-status={step.status}
            aria-current={step.status === "current" ? "step" : undefined}
            className="group/step relative"
          >
            {index < steps.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute top-9 bottom-1 left-[15.5px] w-px overflow-hidden bg-border"
              >
                <span
                  className={cn(
                    "absolute inset-0 origin-top bg-primary transition-transform duration-300 ease-out motion-reduce:transition-none",
                    complete ? "scale-y-100 delay-300" : "scale-y-0",
                  )}
                />
              </span>
            ) : null}
            {/* The content stays one element whatever the status, so a change animates. */}
            <div className="flex gap-4">
              {/* The number and check are drawn for the eye; the status is read from text. */}
              <span
                aria-hidden="true"
                className={cn(
                  "relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-full text-body font-medium",
                  step.status === "upcoming"
                    ? "border border-border text-muted-foreground"
                    : "border-2 border-primary text-foreground",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-0 bg-primary transition-[clip-path] duration-300 ease-in-out motion-reduce:transition-none",
                    complete ? "[clip-path:inset(0)]" : "[clip-path:inset(0_0_100%_0)] delay-300",
                  )}
                />
                <span
                  className={cn(
                    "relative transition-opacity motion-reduce:transition-none",
                    complete ? "opacity-0" : "delay-300",
                  )}
                >
                  {index + 1}
                </span>
                <CheckIcon
                  className={cn(
                    "absolute size-4 text-primary-foreground transition-opacity duration-200 motion-reduce:transition-none",
                    complete ? "opacity-100 delay-200" : "opacity-0 delay-200",
                  )}
                />
              </span>
              <span className="flex min-w-0 flex-col gap-1 pt-1.5 pb-6 text-left">
                <span
                  id={titleId}
                  className={cn(
                    "text-body font-medium",
                    selectable && "group-hover/step:underline",
                    step.status === "upcoming" ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {step.title}
                </span>
                {complete ? (
                  <span id={statusId} className="sr-only">
                    {completeLabel}
                  </span>
                ) : null}
                {step.description ? (
                  <span
                    className={cn("text-body text-muted-foreground", step.busy && "text-shimmer")}
                  >
                    {step.description}
                  </span>
                ) : null}
              </span>
            </div>
            {selectable ? (
              <button
                type="button"
                aria-labelledby={complete ? `${titleId} ${statusId}` : titleId}
                onClick={() => onSelect(step.id)}
                className="absolute inset-0 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export { Stepper, type StepperStatus, type StepperStep };
