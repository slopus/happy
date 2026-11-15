import { cn } from "@rakazo/ui-web/lib/utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select.js";

/** One choice in an {@link OptionSelect}. */
type SelectOption<T extends string> = {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
};

/**
 * A dropdown over a fixed list of options: the app's menu, never the browser's own, so every
 * dropdown looks and behaves the same. Give it an `id` to pair it with a `FieldLabel`.
 */
function OptionSelect<T extends string>({
  id,
  value,
  options,
  onValueChange,
  disabled = false,
  size = "default",
  className,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  id?: string;
  /** null shows nothing chosen yet. */
  value: T | null;
  options: readonly SelectOption<T>[];
  onValueChange: (value: T) => void;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  return (
    <Select
      value={value}
      items={options}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((entry) => entry.value === next);
        if (option) onValueChange(option.value);
      }}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        data-testid={testId}
        className={cn("w-full", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export type { SelectOption };
export { OptionSelect };
