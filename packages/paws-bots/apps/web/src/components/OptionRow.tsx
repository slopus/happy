import { Button, cn } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

/** A lettered answer row for question cards; it only fills on hover or once chosen. */
export function OptionRow({
  letter,
  selected,
  disabled,
  onClick,
  children,
}: {
  letter: string;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      disabled={disabled}
      aria-pressed={selected || undefined}
      onClick={onClick}
      className={cn(
        "-mx-2 h-auto w-[calc(100%+1rem)] min-w-0 justify-start gap-3 whitespace-normal px-2 py-2 text-start text-body-lg font-normal",
        selected && "bg-accent disabled:opacity-100",
      )}
    >
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-muted text-body-sm text-muted-foreground"
      >
        {letter}
      </span>
      <span className="flex-1">{children}</span>
      {selected ? <Check aria-hidden className="text-muted-foreground" /> : null}
    </Button>
  );
}

export function optionLetter(index: number): string {
  return String.fromCharCode(65 + index);
}
