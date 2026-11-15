import { useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { ComposerMention, SLASH_ACTIONS, SlashActionId } from "@rakazo/core";
import { mentionChipKey, truncateSlashDescription } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { ArrowUp, Box, Paperclip, Settings, Square, X } from "lucide-react";
import type { CSSProperties, RefObject } from "react";
import type { useHoldToTalk } from "../../components/composer/HoldToTalk";
import { HoldToTalkControls } from "../../components/composer/HoldToTalk";
import type { PendingAttachment } from "./chat-shared";
import { MentionOptionIcon, slashActionLabel } from "./composer-mentions";

/** The files waiting to go with the next message, each with its remove button. */
export function PendingAttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (attachment: PendingAttachment) => void;
}) {
  const { t } = useLingui();
  if (!attachments.length) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-body-sm text-foreground/75"
        >
          {attachment.previewUrl ? (
            <img
              src={attachment.previewUrl}
              alt={attachment.file.name}
              className="h-8 w-8 rounded object-cover"
            />
          ) : (
            <Paperclip size={14} strokeWidth={1.8} />
          )}
          <span className="max-w-[180px] truncate" dir="auto">
            {attachment.file.name}
          </span>
          <button
            type="button"
            aria-label={t`Remove ${attachment.file.name}`}
            onClick={() => onRemove(attachment)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The `@` list; the message field keeps focus and points at the highlighted option. */
export function MentionPicker({
  listboxId,
  options,
  activeIndex,
  onPick,
  onHighlight,
}: {
  listboxId: string;
  options: ComposerMention[];
  activeIndex: number;
  onPick: (mention: ComposerMention) => void;
  onHighlight: (mention: ComposerMention) => void;
}) {
  const { t } = useLingui();
  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label={t`Mentions`}
      data-testid="mention-picker"
      className="mb-2 overflow-hidden rounded-[14px] border border-border bg-muted animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
    >
      {options.map((mention, index) => {
        const optionId = `${listboxId}-option-${index}`;
        const highlighted = index === activeIndex;
        return (
          <button
            id={optionId}
            key={mentionChipKey(mention)}
            type="button"
            role="option"
            aria-selected={highlighted}
            aria-label={t`@${mention.name}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(mention)}
            // Opening the list under a stationary pointer must not steal the keyboard highlight.
            onMouseMove={() => onHighlight(mention)}
            className={`flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent ${
              highlighted ? "bg-accent" : ""
            }`}
          >
            <MentionOptionIcon mention={mention} />
            <span className="min-w-0">
              <span dir="auto" className="block text-body text-foreground">
                @{mention.name}
              </span>
              {mention.subtitle ? (
                <span dir="auto" className="block truncate text-body-sm text-muted-foreground">
                  {mention.subtitle}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The leading-`/` list: skills to attach, then actions to run. */
export function SlashPicker({
  skills,
  actions,
  onSkill,
  onAction,
}: {
  skills: AgentSkillCatalogEntry[];
  actions: ReadonlyArray<(typeof SLASH_ACTIONS)[number]>;
  onSkill: (skill: AgentSkillCatalogEntry) => void;
  onAction: (action: SlashActionId) => void;
}) {
  const { t } = useLingui();
  return (
    <div
      data-testid="slash-picker"
      className="mb-2 overflow-hidden rounded-[14px] border border-border bg-muted"
    >
      {skills.map((skill) => (
        <button
          key={skill.id}
          type="button"
          aria-label={t`Skill ${skill.name}`}
          onClick={() => onSkill(skill)}
          className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent"
        >
          <Box size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span dir="auto" className="block text-body text-foreground">
              {skill.name}
            </span>
            <span dir="auto" className="block truncate text-body-sm text-muted-foreground">
              {truncateSlashDescription(skill.description)}
            </span>
          </span>
        </button>
      ))}
      {actions.map((action) => {
        const label = slashActionLabel(action.id);
        return (
          <button
            key={action.id}
            type="button"
            aria-label={label}
            onClick={() => onAction(action.id)}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent"
          >
            <Settings size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
            <span className="text-body text-foreground">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Hold-to-talk, Send, and while a reply runs, Stop. */
export function ComposerActions({
  actionsRef,
  expanded,
  talk,
  running,
  showTalk,
  talkDisabled,
  sendDisabled,
  stopDisabled,
  sendColors,
  onSend,
  onStop,
}: {
  actionsRef: RefObject<HTMLDivElement | null>;
  expanded: boolean;
  talk: ReturnType<typeof useHoldToTalk>;
  running: boolean;
  /** Hold-to-talk shows beside Send while the draft is empty. */
  showTalk: boolean;
  talkDisabled: boolean;
  sendDisabled: boolean | undefined;
  stopDisabled: boolean;
  /** The bot's color, as your messages to it wear it; the send button matches them. */
  sendColors?: { background: string; foreground: string };
  onSend: () => void;
  onStop: () => void;
}) {
  const { t } = useLingui();
  // The same chat-user colors your bubbles in this chat wear (set the same way in the transcript).
  const sendStyle = sendColors
    ? ({
        "--chat-user": sendColors.background,
        "--chat-user-foreground": sendColors.foreground,
      } as CSSProperties)
    : undefined;
  // An empty draft keeps the quiet disabled look either way; the bot's color shows once it can go.
  const sendClassName = `size-8 shrink-0 rounded-full transition-transform active:scale-95 disabled:bg-primary-disabled disabled:text-foreground/30 disabled:opacity-100 ${sendColors ? "bg-chat-user text-chat-user-foreground hover:bg-chat-user/90" : ""}`;
  return (
    <div
      ref={actionsRef}
      className={`col-start-3 flex shrink-0 items-center gap-2 justify-self-end ${
        expanded ? "row-start-2" : ""
      }`}
    >
      {talk.recording?.locked ? (
        <HoldToTalkControls talk={talk} />
      ) : running ? (
        <>
          {showTalk ? <HoldToTalkControls talk={talk} disabled={talkDisabled} /> : null}
          <Button
            size="icon"
            aria-label={t`Send`}
            disabled={sendDisabled}
            onClick={onSend}
            style={sendStyle}
            className={sendClassName}
          >
            <ArrowUp size={16} strokeWidth={2.2} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label={t`Stop`}
            disabled={stopDisabled}
            onClick={onStop}
            className="size-8 rounded-full border border-border bg-muted text-foreground/80 shadow-sm transition-colors hover:bg-accent hover:text-foreground"
          >
            <Square size={11} strokeWidth={0} fill="currentColor" />
          </Button>
        </>
      ) : (
        <>
          {showTalk ? <HoldToTalkControls talk={talk} disabled={talkDisabled} /> : null}
          <Button
            size="icon"
            aria-label={t`Send`}
            disabled={sendDisabled}
            onClick={onSend}
            style={sendStyle}
            className={sendClassName}
          >
            <ArrowUp size={16} strokeWidth={2.2} />
          </Button>
        </>
      )}
    </div>
  );
}
