import { t } from "@lingui/core/macro";
import type { ComposerMention, ComposerMentionBinding, SlashActionId } from "@rakazo/core";
import { composerMentionSegments, mentionChipKey } from "@rakazo/core";
import { BotAvatar, resolvePersonaColorDef } from "@rakazo/ui-web";
import { Clock, Puzzle, X } from "lucide-react";
import type { ComponentProps, ReactNode, Ref } from "react";
import { Fragment } from "react";
import { FALLBACK_BOT_COLOR } from "./chat-shared";

export function slashActionLabel(id: SlashActionId) {
  switch (id) {
    case "chat-settings":
      return t`Chat Settings`;
    case "settings-general":
      return t`Settings: General`;
    case "settings-usage":
      return t`Settings: Usage`;
  }
}

export function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "group") {
    return (
      <span
        // off-scale: glyph must fit the small icon dot
        className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75"
      >
        G
      </span>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <span
        // off-scale: glyph must fit the small icon dot
        className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75"
      >
        @
      </span>
    );
  }
  return (
    <BotAvatar
      avatarSet={mention.avatarSet}
      color={mention.color ?? FALLBACK_BOT_COLOR}
      identity={mention.id}
      size={16}
    />
  );
}

function MentionCardIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={12} strokeWidth={1.7} className="text-muted-foreground/70" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={12} strokeWidth={1.7} className="text-muted-foreground/70" />;
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <span
        // off-scale: glyph must fit the small icon dot
        className="grid size-3 place-items-center rounded-full bg-accent text-[9px] leading-none text-foreground/75"
      >
        {mention.kind === "group" ? "G" : "@"}
      </span>
    );
  }
  return (
    <BotAvatar
      avatarSet={mention.avatarSet}
      color={mention.color ?? FALLBACK_BOT_COLOR}
      identity={mention.id}
      size={12}
    />
  );
}

export function ComposerMentionHighlights({
  ref,
  text,
  bindings,
  targets,
  className,
}: {
  ref: Ref<HTMLDivElement>;
  text: string;
  bindings: readonly ComposerMentionBinding[];
  targets: readonly ComposerMention[];
  className: string;
}) {
  const current = new Map(targets.map((target) => [mentionChipKey(target), target]));
  return (
    <div ref={ref} inert aria-hidden className={className}>
      {composerMentionSegments(text, bindings).map((segment, index) => {
        const binding = segment.binding;
        if (!binding) return <Fragment key={index}>{segment.text}</Fragment>;
        const mention = current.get(mentionChipKey(binding.mention)) ?? binding.mention;
        return (
          <span
            key={index}
            data-testid="mention-chip"
            data-mention-kind={mention.kind}
            className="rounded-full bg-accent ring-1 ring-accent box-decoration-clone"
            style={
              mention.kind === "bot" && mention.color
                ? { color: resolvePersonaColorDef(mention.id, mention.color).hex }
                : undefined
            }
          >
            <span className="relative text-transparent">
              @
              <span className="absolute inset-0 grid place-items-center">
                <MentionCardIcon mention={mention} />
              </span>
            </span>
            {segment.text.slice(1)}
          </span>
        );
      })}
      {text.endsWith("\n") ? " " : null}
    </div>
  );
}

/** The selected skill, shown before the draft in the composer field. */
export function ComposerChip({
  icon,
  label,
  removeLabel,
  onRemove,
  ...props
}: {
  icon: ReactNode;
  label: string;
  removeLabel: string;
  onRemove: () => void;
} & ComponentProps<"span">) {
  return (
    <span
      {...props}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-body-sm text-foreground"
    >
      {icon}
      <span dir="auto" className="truncate">
        {label}
      </span>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground"
      >
        <X size={12} strokeWidth={2} />
      </button>
    </span>
  );
}
