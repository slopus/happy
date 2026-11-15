import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type {
  ComposerMention,
  ComposerMentionBinding,
  ComposerMentionRange,
  SlashActionId,
} from "@rakazo/core";
import {
  bindComposerMention,
  clampMentionHighlightIndex,
  composerMentionQuery,
  mentionChipKey,
  SLASH_ACTIONS,
} from "@rakazo/core";
import type { RefObject } from "react";
import { useEffect, useId, useMemo, useState } from "react";

type Composition = { text: string; bindings: ComposerMentionBinding[] };

/**
 * What typing `@` or a leading `/` opens in the composer: the mention list, the slash list of
 * skills and actions, and the skill a slash pick attaches to the message.
 */
export function useComposerTriggers({
  draft,
  mentionBindings,
  selectedMentions,
  mentionTargets,
  agentSkills,
  getField,
  pendingCaret,
  markEdited,
  commitComposition,
  onSlashOpen,
  onSlashAction,
}: {
  draft: string;
  mentionBindings: ComposerMentionBinding[];
  selectedMentions: ComposerMention[];
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  /** Read when a mention is picked, for the caret it completes at. */
  getField: () => HTMLTextAreaElement | null;
  pendingCaret: RefObject<ComposerMentionRange | null>;
  markEdited: () => void;
  commitComposition: (next: Composition) => void;
  onSlashOpen?: () => void;
  onSlashAction?: (action: SlashActionId) => void;
}) {
  const [mentionQuery, setMentionQuery] = useState<string | null>(
    () =>
      composerMentionQuery(draft, draft.length, draft.length, mentionTargets, mentionBindings)
        ?.query ?? null,
  );
  const [mentionHighlightKey, setMentionHighlightKey] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(() => {
    const slashMatch = /^\/([^\n]*)$/.exec(draft);
    return slashMatch ? (slashMatch[1] ?? "") : null;
  });
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const mentionListboxId = useId();

  const knownMentions = [...(mentionTargets ?? []), ...selectedMentions];

  function updatePickers(
    value: string,
    caret: number,
    end: number,
    bindings: ComposerMentionBinding[],
  ) {
    setMentionQuery(
      composerMentionQuery(value, caret, end, knownMentions, bindings)?.query ?? null,
    );
    // `/` only at the start of the draft so forced skills expand (`Use skill:` / `/Name` prefix).
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    const nextSlash = slashMatch ? (slashMatch[1] ?? "") : null;
    if (nextSlash !== null && slashQuery === null) onSlashOpen?.();
    setSlashQuery(nextSlash);
  }

  function insertMention(mention: ComposerMention) {
    const field = getField();
    if (!field) return;
    const query = composerMentionQuery(
      draft,
      field.selectionStart,
      field.selectionEnd,
      knownMentions,
      mentionBindings,
    );
    if (!query || query.query !== mentionQuery) return;
    markEdited();
    const completion = bindComposerMention(draft, query, mention, mentionBindings);
    commitComposition({ text: completion.text, bindings: completion.bindings });
    setMentionQuery(null);
    setMentionHighlightKey(null);
    // Restore after React has committed the new controlled value.
    pendingCaret.current = { start: completion.caret, end: completion.caret };
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    markEdited();
    setSelectedSkill(skill);
    commitComposition({ text: "", bindings: [] });
    setSlashQuery(null);
  }

  function runSlashAction(action: SlashActionId) {
    markEdited();
    commitComposition({ text: "", bindings: [] });
    setSlashQuery(null);
    onSlashAction?.(action);
  }

  function removeSkill() {
    markEdited();
    setSelectedSkill(null);
  }

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !mentionTargets?.length) return [];
    const query = mentionQuery.trim().toLowerCase();
    return mentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [mentionQuery, mentionTargets]);

  useEffect(() => {
    setMentionHighlightKey(null);
  }, [mentionQuery]);

  const activeMentionIndex = clampMentionHighlightIndex(
    mentionOptions.findIndex((mention) => mentionChipKey(mention) === mentionHighlightKey),
    mentionOptions.length,
  );
  const mentionPickerOpen = mentionOptions.length > 0;
  const activeMentionOptionId = mentionPickerOpen
    ? `${mentionListboxId}-option-${activeMentionIndex}`
    : undefined;

  const slashSkillOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    const skills = agentSkills ?? [];
    return skills
      .filter((skill) => {
        if (!query) return true;
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  }, [agentSkills, slashQuery]);

  const slashActionOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    return SLASH_ACTIONS.filter((action) => !query || action.label.toLowerCase().includes(query));
  }, [slashQuery]);

  const showSlashPicker =
    slashQuery !== null &&
    mentionQuery === null &&
    (slashSkillOptions.length > 0 || slashActionOptions.length > 0);

  return {
    knownMentions,
    setMentionQuery,
    setMentionHighlightKey,
    setSlashQuery,
    selectedSkill,
    setSelectedSkill,
    updatePickers,
    insertMention,
    insertSkill,
    runSlashAction,
    removeSkill,
    mentionListboxId,
    mentionOptions,
    activeMentionIndex,
    mentionPickerOpen,
    activeMentionOptionId,
    slashSkillOptions,
    slashActionOptions,
    showSlashPicker,
  };
}
