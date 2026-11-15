import { listenWindow } from "../../paws/runtime";
import { useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry, ThreadMessage } from "@rakazo/contracts";
import type { ComposerMention, ComposerMentionRange, SlashActionId } from "@rakazo/core";
import {
  composerMentionQuery,
  composerMentionsForPrompt,
  composerSelectedMentions,
  mentionChipKey,
  newClientId,
  replyAttachment,
  resolveComposerMentionEdit,
  resolveMentionPickerKey,
  serializeComposerPrompt,
  updateComposerMentionBindings,
} from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Box, Plus } from "lucide-react";
import type { ClipboardEvent, ComponentProps, RefObject } from "react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { HoldToTalkStrip, useHoldToTalk } from "../../components/composer/HoldToTalk";
import { recordMessageSent } from "../../components/GitHubStarPrompt";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { attachmentPickerAccept } from "../../lib/attachment-picker-accept";
import { useCallSession } from "../../lib/call-session";
import {
  appendComposerDraftText,
  beginComposerDraftSubmission,
  keepComposerRetryNonce,
  readComposerDraft,
  readComposerDraftBindings,
  readComposerRetryNonce,
  replaceComposerDraft,
  settleComposerDraftSubmission,
  subscribeComposerDraftAccepted,
  subscribeComposerDraftReplaced,
  subscribeComposerOffer,
  writeComposerDraft,
  writeComposerRetryNonce,
} from "../../lib/composer-draft";
import { hasOpenDialog } from "../../lib/has-open-dialog";
import { usePageSession } from "../../lib/pages";
import { isFilePaste } from "../../lib/pending-attachments";
import { ComposerReplyPreview } from "./chat-context";
import type { PendingAttachment } from "./chat-shared";
import { previewMessageText } from "./chat-shared";
import { ComposerError } from "./composer-error";
import { ComposerChip, ComposerMentionHighlights } from "./composer-mentions";
import {
  ComposerActions,
  MentionPicker,
  PendingAttachmentChips,
  SlashPicker,
} from "./composer-parts";
import { isApplePlatform, isEditableTarget, primaryModifier } from "./shell-shortcuts";
import { useComposerFileDrop } from "./use-composer-file-drop";
import { useComposerLayout } from "./use-composer-layout";
import { useComposerTriggers } from "./use-composer-triggers";

export const LARGE_PASTE_THRESHOLD = 4_000;

const ATTACHMENT_ACCEPT = attachmentPickerAccept(navigator.userAgent);
const COMPOSER_TEXT = "rk-scroll whitespace-pre-wrap break-words px-0.5 py-0.5 text-body-lg";
const ComposerBody = memo(function Composer({
  artifactTarget,
  activeName,
  running,
  disabled,
  pendingAttachments,
  attachmentNotice,
  sendError,
  imageConfirmation,
  onDraftEdited,
  onOpenModels,
  onOpenConnections,
  onOpenBilling,
  runError,
  runErrorId,
  onRunErrorPresented,
  onDismissError,
  sending,
  fileInputRef,
  onAttachmentPick,
  onRemoveAttachment,
  onSend,
  onStop,
  phoneCallsEnabled,
  dictationTranscribe,
  replyTarget,
  replyQuote,
  replyTargetName,
  onClearReply,
  mentionTargets,
  agentSkills,
  onSlashOpen,
  onSlashAction,
  draftKey,
  enterToSend,
  sendColors,
  docked = false,
}: {
  activeName?: string;
  running: boolean;
  disabled?: boolean;
  pendingAttachments: PendingAttachment[];
  attachmentNotice: string | null;
  sendError: string | null;
  imageConfirmation?: boolean;
  onDraftEdited?: () => void;
  onOpenModels: () => void;
  onOpenConnections: () => void;
  onOpenBilling: () => void;
  runError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onDismissError: () => void;
  sending: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachmentPick: (files: FileList | readonly File[] | null) => boolean;
  onRemoveAttachment: (attachment: PendingAttachment) => void;
  onSend: (
    text: string,
    mentions: ComposerMention[],
    clientNonce: string,
    imageHandling?: "file",
  ) => Promise<boolean>;
  onStop: () => Promise<void>;
  phoneCallsEnabled?: boolean;
  /** Hold-to-talk falls back to the voice provider's transcription; undefined while unknown. */
  dictationTranscribe?: boolean;
  artifactTarget: ArtifactTarget;
  replyTarget?: ThreadMessage | null;
  replyQuote?: string | null;
  replyTargetName?: string;
  onClearReply?: () => void;
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  onSlashOpen?: () => void;
  onSlashAction?: (action: SlashActionId) => void;
  draftKey: string;
  enterToSend: boolean;
  /** The bot's color, as your messages to it wear it; the send button matches them. */
  sendColors?: { background: string; foreground: string };
  /** Floating over an open page instead of sitting under the chat. */
  docked?: boolean;
}) {
  const { t } = useLingui();
  const [composition, setComposition] = useState(() => ({
    text: readComposerDraft(draftKey),
    bindings: readComposerDraftBindings(draftKey),
  }));
  const [largePaste, setLargePaste] = useState<{
    text: string;
    before: typeof composition;
    start: number;
    end: number;
  } | null>(null);
  const draft = composition.text;
  const mentionBindings = composition.bindings;
  const compositionRef = useRef(composition);
  compositionRef.current = composition;
  const selectedMentions = useMemo(
    () => composerSelectedMentions(mentionBindings),
    [mentionBindings],
  );
  const editSelections = useRef<ComposerMentionRange[]>([]);
  function rememberSelection(field: HTMLTextAreaElement) {
    editSelections.current = [
      { start: field.selectionStart, end: field.selectionEnd },
      ...editSelections.current,
    ].slice(0, 3);
  }
  function commitComposition(next: typeof composition, persist = true) {
    setLargePaste(null);
    compositionRef.current = next;
    setComposition(next);
    editSelections.current = [];
    if (persist) writeComposerDraft(draftKey, next.text, undefined, next.bindings);
  }
  /** False when the words went to this chat's saved draft because it is no longer shown. */
  function appendDictation(text: string): boolean {
    if (!mountedRef.current || draftKeyRef.current !== draftKey) {
      // The chat changed while the words were transcribed; they wait in its draft for review.
      appendComposerDraftText(draftKey, text);
      return false;
    }
    const current = compositionRef.current.text;
    editSelections.current = [{ start: current.length, end: current.length }];
    updateDraft(current ? `${current} ${text}` : text);
    return true;
  }
  const pendingCaret = useRef<ComposerMentionRange | null>(null);
  const completedSelection = useRef<number | null>(null);
  const {
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
  } = useComposerTriggers({
    draft,
    mentionBindings,
    selectedMentions,
    mentionTargets,
    agentSkills,
    getField: () => textareaRef.current,
    pendingCaret,
    markEdited,
    commitComposition,
    onSlashOpen,
    onSlashAction,
  });
  const onCall = useCallSession() !== null;
  const talk = useHoldToTalk({
    transcribe: dictationTranscribe,
    disabled: disabled || onCall || !phoneCallsEnabled,
    onText: (text) => {
      // Dictation rides the typed-message path: the words land in the draft and
      // the normal send carries them, with its nonce, edit guards and recovery.
      // Words added to a draft, a skill or attachments wait for the user to review
      // and send; an armed reply or an open page is context and still sends.
      const reviewFirst =
        compositionRef.current.text.trim().length > 0 ||
        selectedSkill !== null ||
        pendingAttachments.length > 0;
      if (!appendDictation(text) || reviewFirst) return;
      const clientNonce = newClientId();
      retryNonce.current = clientNonce;
      queuedDictation.current = editRevision.current;
      setDictationSendDue(editRevision.current);
    },
  });

  const editRevision = useRef(0);
  useEffect(
    () =>
      subscribeComposerDraftAccepted(draftKey, (text) => {
        if (compositionRef.current.text === text)
          commitComposition({ text: "", bindings: [] }, false);
        setMentionQuery(null);
        setSlashQuery(null);
      }),
    [draftKey],
  );
  // A draft rewritten from elsewhere (late dictation or a left chat's recovered send) shows
  // here, so the next edit keeps it.
  useEffect(
    () => subscribeComposerDraftReplaced(draftKey, (text) => showReplacedDraft.current(text)),
    [draftKey],
  );
  // Read through a ref: the subscription outlives the render whose pickers state it would see.
  const showReplacedDraft = useRef((_text: string) => {});
  showReplacedDraft.current = (text) => {
    // An edit like typing: a send still in flight must not restore its older text over it.
    markEdited();
    const bindings = readComposerDraftBindings(draftKey);
    commitComposition({ text, bindings }, false);
    // The pickers follow the new text, as after an edit, with the caret at its end.
    updatePickers(text, text.length, text.length, bindings);
  };
  // An open page rewrites what this chat sends (pageReply), so it is part of the payload.
  const pageSession = usePageSession();
  const dock = pageSession?.dock ?? noDock;
  const openPageId = useSyncExternalStore(dock.subscribe, () => dock.get().page?.id ?? null);
  // A draft reloaded without edits may still belong to a send whose answer never
  // came; its nonce is stored beside it. Anything that would change the next
  // payload (attachments, an armed reply, an open page) disqualifies the stored nonce.
  const [storedRetryNonce] = useState(() =>
    pendingAttachments.length === 0 && !replyTarget && openPageId === null
      ? readComposerRetryNonce(draftKey)
      : null,
  );
  const retryNonce = useRef(storedRetryNonce);
  // Opening or closing a page counts as an edit, like a reply change.
  const previousPageId = useRef(openPageId);
  useEffect(() => {
    if (previousPageId.current === openPageId) return;
    previousPageId.current = openPageId;
    markEdited();
  }, [openPageId]);
  const replyId = replyTarget?.id ?? null;
  const quote = replyTarget ? (replyQuote ?? null) : null;
  const previousReply = useRef({ id: replyId, quote });
  useEffect(() => {
    if (previousReply.current.id !== replyId || previousReply.current.quote !== quote) {
      markEdited();
      previousReply.current = { id: replyId, quote };
    }
  }, [replyId, quote, onDraftEdited]);
  // The words must reach the committed draft before send() reads it, so the
  // send waits one render for the state appendDictation just queued.
  // The due send holds the edit revision the dictation left.
  const [dictationSendDue, setDictationSendDue] = useState<number | null>(null);
  // The same due revision for send(), which reads it after its own await.
  const queuedDictation = useRef<number | null>(null);
  // A dictation that finishes while an earlier send is in flight waits for it;
  // any edit in the meantime cancels the automatic send. It runs after the
  // reply effect above, so a reply armed in the same commit counts as an edit.
  useEffect(() => {
    if (dictationSendDue === null || sending) return;
    setDictationSendDue(null);
    queuedDictation.current = null;
    if (editRevision.current === dictationSendDue) void send();
  }, [dictationSendDue, sending]);
  const {
    textareaRef,
    mirrorRef,
    attachButtonRef,
    composerActionsRef,
    composerBarRef,
    composerFieldRef,
    expanded,
  } = useComposerLayout(draft, selectedSkill !== null);
  // Cmd/Ctrl+D in the message field dictates hands-free, like a keyboard press on the mic button,
  // and sends once pressed again. The field hides while recording, so the key is heard window-wide.
  const dictateKey = useRef({ talk, available: false });
  dictateKey.current = {
    talk,
    available: Boolean(phoneCallsEnabled) && !disabled && !onCall && draft.trim().length === 0,
  };
  useEffect(() => {
    const apple = isApplePlatform();
    function onKey(event: KeyboardEvent) {
      if (event.repeat || event.altKey || event.shiftKey || event.key?.toLowerCase() !== "d")
        return;
      if (!primaryModifier(event, apple)) return;
      const { talk, available } = dictateKey.current;
      if (talk.recording) {
        // Pressed while typing elsewhere, it belongs to that field rather than this recording.
        if (!talk.recording.locked || talk.transcribing) return;
        if (isEditableTarget(event.target) || hasOpenDialog(document)) return;
        event.preventDefault();
        talk.submit();
      } else if (available && document.activeElement === textareaRef.current) {
        event.preventDefault();
        talk.startHandsFree();
      }
    }
    listenWindow("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [textareaRef]);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const selection = pendingCaret.current;
    pendingCaret.current = null;
    completedSelection.current = selection.start === selection.end ? selection.start : null;
    textareaRef.current?.setSelectionRange(selection.start, selection.end);
    textareaRef.current?.focus();
  });
  // A reply button on the open page adds its text here for the user to send, about that page
  // rather than a message picked before it.
  const clearReply = useRef(onClearReply);
  clearReply.current = onClearReply;
  const appendOffered = useRef((_text: string) => {});
  appendOffered.current = (text: string) => {
    clearReply.current?.();
    const current = compositionRef.current.text;
    editSelections.current = [{ start: current.length, end: current.length }];
    const next = current.trim() ? `${current.trimEnd()} ${text}` : text;
    updateDraft(next);
    pendingCaret.current = { start: next.length, end: next.length };
  };
  useEffect(
    () => pageSession?.subscribeReply((text) => appendOffered.current(text)),
    [pageSession],
  );
  // An app card in this chat offers its text the same way.
  useEffect(
    () => subscribeComposerOffer(draftKey, (text) => appendOffered.current(text)),
    [draftKey],
  );
  const [replyAnnouncement, setReplyAnnouncement] = useState("");
  // What the live region currently holds — a send disarming the reply clears
  // "reply" text, while an explicit cancel must keep "Reply cancelled".
  const replyAnnouncementKind = useRef<"reply" | "cancelled" | null>(null);
  const prevReplyTarget = useRef<ThreadMessage | null>(null);
  const { draggingFiles, fileDragActive, dropHandlers } = useComposerFileDrop({
    disabled,
    onDropFiles: pickAttachments,
  });
  const canSend =
    draft.trim().length > 0 || selectedSkill !== null || pendingAttachments.length > 0;

  function markEdited() {
    setLargePaste(null);
    onDraftEdited?.();
    editRevision.current += 1;
    retryNonce.current = null;
    writeComposerRetryNonce(draftKey, null);
  }

  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function pickAttachments(files: FileList | readonly File[] | null) {
    if (!files?.length) return;
    if (onAttachmentPick(files)) markEdited();
  }

  function updateDraft(
    nativeValue: string,
    nativeCaret = nativeValue.length,
    nativeEnd = nativeCaret,
    composing = false,
  ) {
    markEdited();
    const current = compositionRef.current;
    const hints = {
      before: editSelections.current,
      after: { start: nativeCaret, end: nativeEnd },
    };
    const edit = composing
      ? {
          text: nativeValue,
          bindings: updateComposerMentionBindings(
            current.text,
            nativeValue,
            current.bindings,
            hints,
          ),
          caret: null,
        }
      : resolveComposerMentionEdit(current.text, nativeValue, current.bindings, hints);
    const value = edit.text;
    const caret = edit.caret ?? nativeCaret;
    const end = edit.caret ?? nativeEnd;
    if (edit.caret !== null) pendingCaret.current = { start: caret, end };
    commitComposition({ text: value, bindings: edit.bindings });
    updatePickers(value, caret, end, edit.bindings);
  }

  async function send(imageHandling?: "file") {
    if (!canSend || sending || disabled) return;
    setLargePaste(null);
    const revision = editRevision.current;
    // Recovery rebuilds the draft from text alone, so only a plain-text send —
    // no reply target, no attachments, no skill, no open page — can share its
    // nonce with a retry. Anything else keeps the words without a nonce.
    const nonceRecoverable =
      !replyTarget &&
      pendingAttachments.length === 0 &&
      selectedSkill === null &&
      openPageId === null;
    const clientNonce =
      retryNonce.current ??
      // A chat reopened before its unsettled send failed has not edited since
      // mount, so the nonce stored beside the saved draft is still this draft's.
      (revision === 0 && nonceRecoverable ? readComposerRetryNonce(draftKey) : null) ??
      newClientId();
    retryNonce.current = null;
    const submitted = compositionRef.current;
    const text = serializeComposerPrompt(submitted.text, selectedSkill);
    const mentions = composerMentionsForPrompt(submitted.text, selectedSkill, submitted.bindings);
    const submission = beginComposerDraftSubmission(draftKey, draft);
    commitComposition({ text: "", bindings: [] }, false);
    setMentionQuery(null);
    setMentionHighlightKey(null);
    setSlashQuery(null);
    setSelectedSkill(null);
    try {
      const accepted =
        (await (imageHandling
          ? onSend(text, mentions, clientNonce, imageHandling)
          : onSend(text, mentions, clientNonce))) !== false;
      settleComposerDraftSubmission(draftKey, submission, accepted);
      if (accepted) {
        recordMessageSent();
        return;
      }
    } catch {
      settleComposerDraftSubmission(draftKey, submission, false);
      // A rejected callback leaves acceptance unknown; do not restore a possible
      // send. The saved draft still holds the words; only a recoverable plain
      // text send keeps its nonce with them, so the retry is not mistaken for
      // a reply-linked or otherwise different message.
      if (nonceRecoverable) keepComposerRetryNonce(draftKey, submission, clientNonce);
      return;
    }
    // A dictation queued behind this send, and no other edit since, joins the failed
    // words instead of going out alone; the send's error stays.
    if (queuedDictation.current === revision + 1 && editRevision.current === revision + 1) {
      queuedDictation.current = null;
      setDictationSendDue(null);
      retryNonce.current = null;
      const queued = compositionRef.current;
      const words = queued.text;
      const restored = { text: `${submitted.text} ${words}`, bindings: submitted.bindings };
      if (mountedRef.current && draftKeyRef.current === draftKey) {
        commitComposition(restored);
        setSelectedSkill(selectedSkill);
        return;
      }
      // Once the chat was left, a composer reopened for it owns the saved draft; only a draft
      // still holding just these words, mentions included, is this send's to restore, and the
      // reopened field follows it. The same spelling bound to a mention there is a newer edit.
      if (
        readComposerDraft(draftKey) === words &&
        JSON.stringify(readComposerDraftBindings(draftKey)) === JSON.stringify(queued.bindings)
      )
        replaceComposerDraft(draftKey, restored.text, restored.bindings);
      return;
    }
    // Restore only an untouched draft, retaining its nonce for an unchanged retry.
    // This composer still carries the reply and attachments the send carried, so
    // the in-memory nonce is safe here; the stored one is only for plain text.
    if (editRevision.current !== revision) return;
    retryNonce.current = clientNonce;
    if (nonceRecoverable) keepComposerRetryNonce(draftKey, submission, clientNonce);
    commitComposition(submitted, false);
    setSelectedSkill(selectedSkill);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardData = event.clipboardData;
    if (disabled || !clipboardData) return;
    const text = clipboardData.getData("text/plain");
    const files = isFilePaste(clipboardData);
    if (!files && text.length <= LARGE_PASTE_THRESHOLD) return;
    event.preventDefault();
    if (files) pickAttachments(clipboardData.files);
    if (!text) return;
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = compositionRef.current;
    rememberSelection(textarea);
    const caret = start + text.length;
    updateDraft(`${before.text.slice(0, start)}${text}${before.text.slice(end)}`, caret);
    pendingCaret.current = { start: caret, end: caret };
    if (!files) setLargePaste({ text, before, start, end });
  }

  function attachLargePaste() {
    if (!largePaste || disabled) return;
    const file = new File([largePaste.text], "pasted-text.txt", { type: "text/plain" });
    // Rejection leaves the pasted text available and the normal attachment notice visible.
    if (!onAttachmentPick([file])) return;
    markEdited();
    commitComposition(largePaste.before);
    updatePickers(
      largePaste.before.text,
      largePaste.start,
      largePaste.end,
      largePaste.before.bindings,
    );
    pendingCaret.current = { start: largePaste.start, end: largePaste.end };
  }

  const showComposerPlaceholder = draft.length === 0 && selectedSkill === null;

  const replyName = replyTarget ? (replyTargetName ?? previewMessageText(replyTarget)) : "";
  const replyNameRef = useRef(replyName);
  replyNameRef.current = replyName;
  const announceTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(announceTimer.current), []);

  // Arming or retargeting a reply unmounts the control that started it, so
  // focus would drop to <body>; announce on start and when the target changes.
  // The timer lives in a ref: a same-id rerender (e.g. the display name
  // resolving after arming) must not cancel the pending announcement.
  useEffect(() => {
    const prev = prevReplyTarget.current;
    prevReplyTarget.current = replyTarget ?? null;
    if (!replyTarget) {
      // Cancel (or send) within the delay must not let a stale "Replying to"
      // overwrite the cancel announcement — kill the pending timer.
      window.clearTimeout(announceTimer.current);
      // A send disarms the reply without touching the region — drop the stale
      // "Replying to" so it cannot linger or re-announce. An explicit cancel
      // sets "Reply cancelled" in the same event, so only clear "reply" text.
      if (replyAnnouncementKind.current === "reply") {
        replyAnnouncementKind.current = null;
        setReplyAnnouncement("");
      }
      return;
    }
    if (!prev || prev.id !== replyTarget.id) {
      textareaRef.current?.focus();
      // Clear-then-set so a switch between same-author targets re-announces —
      // identical live-region text would otherwise be a no-op.
      setReplyAnnouncement("");
      replyAnnouncementKind.current = null;
      window.clearTimeout(announceTimer.current);
      announceTimer.current = window.setTimeout(() => {
        replyAnnouncementKind.current = "reply";
        setReplyAnnouncement(t`Replying to ${replyNameRef.current}`);
      }, 50);
    }
  }, [replyTarget, replyName, t]);

  return (
    <fieldset
      aria-label={t`Message composer`}
      data-dragging={draggingFiles ? "files" : undefined}
      {...dropHandlers}
      className={`relative z-30 m-0 min-w-0 border-0 ${docked ? "p-0" : "px-3 pb-4 pt-0 md:px-[max(1.5rem,calc((100%_-_60rem)/2))] md:pb-6"} [&>*]:pointer-events-auto ${fileDragActive ? "pointer-events-auto" : "pointer-events-none"} ${
        draggingFiles ? "rounded-[14px] ring-2 ring-inset ring-ring" : ""
      }`}
    >
      <div role="status" data-testid="composer-announcement" className="sr-only">
        {replyAnnouncement}
      </div>
      <ComposerError
        sendError={sendError}
        imageConfirmation={imageConfirmation}
        onSendAsFile={imageConfirmation && !sending ? () => void send("file") : undefined}
        runError={runError}
        runErrorId={runErrorId}
        onRunErrorPresented={onRunErrorPresented}
        onOpenModels={onOpenModels}
        onOpenConnections={onOpenConnections}
        onOpenBilling={onOpenBilling}
        onDismissError={onDismissError}
        textareaRef={textareaRef}
      />
      {replyTarget ? (
        <ComposerReplyPreview
          author={replyName}
          text={previewMessageText(replyTarget)}
          quote={replyQuote}
          attachment={replyAttachment(replyTarget.blocks)}
          target={artifactTarget}
          onDismiss={() => {
            replyAnnouncementKind.current = "cancelled";
            window.clearTimeout(announceTimer.current);
            onClearReply?.();
            setReplyAnnouncement(t`Reply cancelled`);
            textareaRef.current?.focus();
          }}
        />
      ) : null}
      {attachmentNotice ? (
        <div className="mb-3 rounded-[14px] border border-warning/40 bg-warning/10 px-4 py-2 text-body-sm text-warning">
          {attachmentNotice}
        </div>
      ) : null}
      <span className="sr-only" role="status">
        {largePaste ? t`Large text pasted inline` : ""}
      </span>
      {largePaste ? (
        <fieldset className="mb-2 flex items-center gap-1" aria-label={t`Large paste`}>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={attachLargePaste}>
            {t`Attach as file`}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setLargePaste(null);
              textareaRef.current?.focus();
            }}
          >
            {t`Keep inline`}
          </Button>
        </fieldset>
      ) : null}
      <PendingAttachmentChips
        attachments={pendingAttachments}
        onRemove={(attachment) => {
          markEdited();
          onRemoveAttachment(attachment);
        }}
      />
      {mentionPickerOpen ? (
        <MentionPicker
          listboxId={mentionListboxId}
          options={mentionOptions}
          activeIndex={activeMentionIndex}
          onPick={insertMention}
          onHighlight={(mention) => setMentionHighlightKey(mentionChipKey(mention))}
        />
      ) : null}
      {showSlashPicker ? (
        <SlashPicker
          skills={slashSkillOptions}
          actions={slashActionOptions}
          onSkill={insertSkill}
          onAction={runSlashAction}
        />
      ) : null}
      <div
        ref={composerBarRef}
        data-testid="composer-bar"
        data-expanded={expanded}
        className={`grid grid-cols-[auto_minmax(0,1fr)_auto] content-end items-center rounded-[26px] border border-border pe-2.5 ps-3 transition-colors focus-within:border-input ${
          docked ? "bg-card" : "bg-background dark:bg-card"
        } ${
          expanded
            ? "gap-x-2 gap-y-2 pb-[9px] pt-3"
            : docked
              ? "gap-x-3 py-[5px] ps-2 pe-2"
              : "gap-x-3.5 py-[9px]"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="hidden"
          onChange={(event) => pickAttachments(event.target.files)}
        />
        <Button
          ref={attachButtonRef}
          variant="ghost"
          size="icon"
          aria-label={t`Attach file`}
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className={`col-start-1 size-8 shrink-0 rounded-full border border-border bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${
            expanded ? "row-start-2" : ""
          }`}
        >
          <Plus size={16} strokeWidth={2} />
        </Button>
        <div
          ref={composerFieldRef}
          data-testid="composer-field"
          className={`flex min-w-0 flex-wrap items-end gap-1.5 ${
            expanded ? "col-span-3 row-start-1 px-1.5" : "col-start-2"
          }`}
        >
          {selectedSkill ? (
            <ComposerChip
              data-testid="skill-chip"
              icon={
                <Box size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />
              }
              label={selectedSkill.name}
              removeLabel={t`Remove skill ${selectedSkill.name}`}
              onRemove={removeSkill}
            />
          ) : null}
          <HoldToTalkStrip talk={talk} />
          <div className="relative min-w-[8rem] flex-1" hidden={talk.recording !== null}>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => {
                completedSelection.current = null;
                updateDraft(
                  event.target.value,
                  event.target.selectionStart,
                  event.target.selectionEnd,
                  (event.nativeEvent as InputEvent).isComposing,
                );
              }}
              onBeforeInput={(event) => rememberSelection(event.currentTarget)}
              onSelect={(event) => {
                const field = event.currentTarget;
                if (pendingCaret.current !== null) return;
                rememberSelection(field);
                if (
                  completedSelection.current === field.selectionStart &&
                  field.selectionStart === field.selectionEnd
                )
                  return;
                completedSelection.current = null;
                setMentionQuery(
                  composerMentionQuery(
                    field.value,
                    field.selectionStart,
                    field.selectionEnd,
                    knownMentions,
                    mentionBindings,
                  )?.query ?? null,
                );
              }}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                rememberSelection(event.currentTarget);
                if (event.key === "Backspace" && draft.length === 0 && selectedSkill !== null) {
                  event.preventDefault();
                  removeSkill();
                  return;
                }
                const action = resolveMentionPickerKey({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  enterToSend,
                  isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
                  optionCount: mentionOptions.length,
                  highlightedIndex: activeMentionIndex,
                });
                if (action.type === "complete") {
                  const mention = mentionOptions[action.index];
                  if (!mention) return;
                  event.preventDefault();
                  insertMention(mention);
                  return;
                }
                if (action.type === "move") {
                  event.preventDefault();
                  setMentionHighlightKey(mentionChipKey(mentionOptions[action.index]!));
                  return;
                }
                if (action.type === "dismiss") {
                  event.preventDefault();
                  completedSelection.current = event.currentTarget.selectionStart;
                  setMentionQuery(null);
                  setMentionHighlightKey(null);
                  return;
                }
                if (action.type === "send") {
                  event.preventDefault();
                  void send();
                  return;
                }
                if (
                  event.key !== "Escape" ||
                  event.repeat ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229 ||
                  event.shiftKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.altKey
                )
                  return;
                // An open picker closes first; a held Escape never goes on to stop the reply.
                if (showSlashPicker) {
                  event.preventDefault();
                  setSlashQuery(null);
                  return;
                }
                if (running && !sending && !talk.recording?.locked) {
                  event.preventDefault();
                  void onStop();
                }
              }}
              disabled={disabled}
              placeholder={
                showComposerPlaceholder
                  ? activeName
                    ? t`Message ${activeName}`
                    : t`Message…`
                  : undefined
              }
              aria-label={activeName ? t`Message ${activeName}` : t`Message`}
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={mentionPickerOpen}
              aria-controls={mentionPickerOpen ? mentionListboxId : undefined}
              aria-activedescendant={activeMentionOptionId}
              name="chat-message"
              autoComplete="off"
              dir="auto"
              rows={1}
              className={`${COMPOSER_TEXT} block max-h-25 min-h-[24px] w-full resize-none overflow-y-auto bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground selection:bg-ring/30 selection:text-transparent disabled:opacity-40 forced-colors:text-[CanvasText]`}
            />
            <ComposerMentionHighlights
              ref={mirrorRef}
              text={draft}
              bindings={mentionBindings}
              targets={mentionTargets ?? []}
              className={`${COMPOSER_TEXT} pointer-events-none absolute inset-0 overflow-y-hidden text-foreground [unicode-bidi:plaintext] forced-colors:hidden ${disabled ? "opacity-40" : ""}`}
            />
          </div>
        </div>
        <ComposerActions
          actionsRef={composerActionsRef}
          expanded={expanded}
          talk={talk}
          running={running}
          showTalk={Boolean(phoneCallsEnabled) && draft.trim().length === 0}
          talkDisabled={disabled || onCall}
          sendDisabled={sending || !canSend || disabled}
          stopDisabled={sending}
          sendColors={sendColors}
          onSend={() => void send()}
          onStop={() => void onStop()}
        />
      </div>
    </fieldset>
  );
});

const noDockState = { node: null, page: null };
const noDock = { subscribe: () => () => {}, get: () => noDockState };

/**
 * The chat's composer, floated over the open page while one is open. It stays one mount: its
 * element moves between the chat and the page, so a draft's chips, focus and dictation carry over.
 */
export function Composer(props: Omit<ComponentProps<typeof ComposerBody>, "docked">) {
  const dock = usePageSession()?.dock ?? noDock;
  const { node: dockNode } = useSyncExternalStore(dock.subscribe, dock.get);
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = dockNode ?? slot.current;
    if (!target || host.parentNode === target) return;
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    target.append(host);
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }, [dockNode, host]);
  useEffect(() => () => host.remove(), [host]);
  return (
    <>
      <div ref={slot} className="contents" />
      {createPortal(<ComposerBody {...props} docked={dockNode !== null} />, host)}
    </>
  );
}
