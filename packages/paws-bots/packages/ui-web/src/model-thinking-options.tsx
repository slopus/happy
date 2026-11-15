import { MAX_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { useId } from "react";
import { Checkbox } from "./components/ui/checkbox.js";
import { Disclosure } from "./components/ui/disclosure.js";
import { Field, FieldLabel } from "./components/ui/field.js";
import { Input } from "./components/ui/input.js";
import { OptionSelect } from "./components/ui/option-select.js";

export function ModelThinkingOptions({
  children,
  reasoning = false,
  onReasoningChange,
  supportsImages,
  onSupportsImagesChange,
  maxImagesPerPrompt,
  onMaxImagesPerPromptChange,
  disabled,
  advancedLabel,
  thinkingLabel,
  showThinking = true,
  thinkingLevel,
  onThinkingLevelChange,
  thinkingLevelOptions,
  thinkingLevelLabel,
  thinkingLevelDefaultLabel,
  maxTokens,
  onMaxTokensChange,
  maxTokensLabel,
  contextWindow,
  onContextWindowChange,
  contextWindowLabel,
  imagesLabel,
  maxImagesLabel,
}: {
  children?: ReactNode;
  reasoning?: boolean;
  onReasoningChange?: (reasoning: boolean) => void;
  supportsImages?: boolean;
  onSupportsImagesChange?: (supportsImages: boolean) => void;
  maxImagesPerPrompt?: string;
  onMaxImagesPerPromptChange?: (maxImagesPerPrompt: string) => void;
  disabled?: boolean;
  advancedLabel: string;
  thinkingLabel?: string;
  showThinking?: boolean;
  thinkingLevel?: string | null;
  onThinkingLevelChange?: (thinkingLevel: string | null) => void;
  thinkingLevelOptions?: ReadonlyArray<{ value: string; label: string }>;
  thinkingLevelLabel?: string;
  thinkingLevelDefaultLabel?: string;
  maxTokens?: string;
  onMaxTokensChange?: (maxTokens: string) => void;
  maxTokensLabel?: string;
  contextWindow?: string;
  onContextWindowChange?: (contextWindow: string) => void;
  contextWindowLabel?: string;
  imagesLabel?: string;
  maxImagesLabel?: string;
}) {
  const id = useId();
  const thinkingLevelId = useId();
  const maxTokensId = useId();
  const contextWindowId = useId();
  const imagesId = useId();
  const maxImagesId = useId();
  return (
    <Disclosure className="mt-4 text-body text-muted-foreground" summary={advancedLabel}>
      {showThinking && onReasoningChange && thinkingLabel ? (
        <label htmlFor={id} className="mt-3 flex items-center gap-2">
          <Checkbox
            id={id}
            checked={reasoning}
            onCheckedChange={(checked) => onReasoningChange(checked === true)}
            disabled={disabled}
          />
          {thinkingLabel}
        </label>
      ) : null}
      {showThinking &&
      reasoning &&
      onThinkingLevelChange &&
      thinkingLevelLabel &&
      thinkingLevelDefaultLabel &&
      thinkingLevelOptions &&
      thinkingLevelOptions.length > 0 ? (
        <Field orientation="horizontal" className="mt-3">
          <FieldLabel htmlFor={thinkingLevelId}>{thinkingLevelLabel}</FieldLabel>
          <OptionSelect
            id={thinkingLevelId}
            value={thinkingLevel ?? ""}
            onValueChange={(next) => onThinkingLevelChange(next || null)}
            disabled={disabled}
            aria-label={thinkingLevelLabel}
            className="w-32"
            options={[{ value: "", label: thinkingLevelDefaultLabel }, ...thinkingLevelOptions]}
          />
        </Field>
      ) : null}
      {onMaxTokensChange && maxTokensLabel ? (
        <Field orientation="horizontal" className="mt-3">
          <FieldLabel htmlFor={maxTokensId}>{maxTokensLabel}</FieldLabel>
          <Input
            id={maxTokensId}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_MODEL_MAX_TOKENS}
            step={1}
            value={maxTokens ?? ""}
            onChange={(event) => onMaxTokensChange(event.target.value)}
            disabled={disabled}
            aria-label={maxTokensLabel}
            className="w-24 text-center text-foreground"
          />
        </Field>
      ) : null}
      {onContextWindowChange && contextWindowLabel ? (
        <Field orientation="horizontal" className="mt-3">
          <FieldLabel htmlFor={contextWindowId}>{contextWindowLabel}</FieldLabel>
          <Input
            id={contextWindowId}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_MODEL_CONTEXT_WINDOW}
            step={1}
            value={contextWindow ?? ""}
            onChange={(event) => onContextWindowChange(event.target.value)}
            disabled={disabled}
            aria-label={contextWindowLabel}
            className="w-24 text-center text-foreground"
          />
        </Field>
      ) : null}
      {onSupportsImagesChange ? (
        <label htmlFor={imagesId} className="mt-3 flex items-center gap-2">
          <Checkbox
            id={imagesId}
            checked={supportsImages === true}
            onCheckedChange={(checked) => onSupportsImagesChange(checked === true)}
            disabled={disabled}
          />
          {imagesLabel}
        </label>
      ) : null}
      {supportsImages && onMaxImagesPerPromptChange ? (
        <Field orientation="horizontal" className="mt-3">
          <FieldLabel htmlFor={maxImagesId}>{maxImagesLabel}</FieldLabel>
          <Input
            id={maxImagesId}
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            step={1}
            value={maxImagesPerPrompt ?? ""}
            onChange={(event) => onMaxImagesPerPromptChange(event.target.value)}
            disabled={disabled}
            aria-label={maxImagesLabel}
            className="w-20 text-center text-foreground"
          />
        </Field>
      ) : null}
      {children}
    </Disclosure>
  );
}
