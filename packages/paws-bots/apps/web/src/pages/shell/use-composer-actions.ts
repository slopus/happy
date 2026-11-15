import { useLingui } from "@lingui/react/macro";
import type {
  Bot,
  ComputerStatus,
  LoginFieldInput,
  Me,
  MessageReaction,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { attachmentMaxBytes, attachmentMaxCount, attachmentSizeLabel } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import {
  applyThreadSendReceipt,
  attachmentsForThread,
  inferAttachmentMimeType,
  isImageInputConfirmation,
  newClientId,
  resolveComposerSendPlan,
} from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestBrowserNotificationPermission } from "../../lib/browser-notifications";
import { setComposerUnsavedWork } from "../../lib/composer-draft";
import { scheduleFocusPrompt } from "../../lib/focus-prompt";
import type { PageSession } from "../../lib/pages";
import {
  readFileAsBase64,
  revokePendingAttachmentPreviews,
  usePendingAttachmentPreviewCleanup,
} from "../../lib/pending-attachments";
import { canPrepareImage, prepareImage } from "../../lib/prepare-image";
import type { createSpaceRpc } from "../../lib/rpc";
import { readSeenRunErrorIds, rememberSeenRunErrorId } from "../../lib/run-error-storage";
import { clearActiveThreadRuns, threadRunError } from "../../lib/thread-events";
import { errorText } from "../../lib/user-error";
import type { PendingAttachment } from "./chat-shared";
import type { useShellNavigation } from "./use-shell-navigation";

type ThreadRefresh = RefObject<(id: string) => Promise<ThreadSnapshot>>;

/**
 * What the composer sends and the chat actions beside it: attachments, replies, send, stop,
 * answers, reactions, and the errors they leave.
 */
export function useComposerActions({
  rpc,
  pageSession,
  activeId,
  inGroup,
  groupId,
  activeBotId,
  activeGroupId,
  botsRef,
  bootstrapMe,
  activeSnapshot,
  navigate,
  refreshBots,
  refreshThreadRef,
  refreshGroupThreadRef,
  updateSnapshot,
  terminalRunReceipts,
  computerRef,
  commitComputer,
  clearReadBoundary,
  flushPendingBrowserNotifications,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  /** The chat's open page, whose card a message sent from it replies to. */
  pageSession: PageSession;
  activeId: string | undefined;
  inGroup: boolean;
  groupId: string | undefined;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  botsRef: RefObject<Bot[]>;
  bootstrapMe: Me | null | undefined;
  activeSnapshot: ThreadSnapshot | null;
  navigate: ReturnType<typeof useShellNavigation>["navigate"];
  refreshBots: () => Promise<void>;
  refreshThreadRef: ThreadRefresh;
  refreshGroupThreadRef: ThreadRefresh;
  updateSnapshot: (update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) => void;
  terminalRunReceipts: RefObject<Set<string>>;
  computerRef: RefObject<ComputerStatus | null>;
  commitComputer: (next: ComputerStatus | null) => void;
  clearReadBoundary: () => void;
  flushPendingBrowserNotifications: () => void;
}) {
  const { t } = useLingui();
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  usePendingAttachmentPreviewCleanup(pendingAttachments);
  const [replyTarget, setReplyTarget] = useState<ThreadMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  useEffect(() => {
    setComposerUnsavedWork({ sending, attachments: pendingAttachments.length > 0 });
    return () => setComposerUnsavedWork({ sending: false, attachments: false });
  }, [sending, pendingAttachments.length]);
  const sendingRef = useRef(false);
  const [sendFailure, setSendFailure] = useState<{
    message: string;
    imageConfirmation: boolean;
  } | null>(null);
  // Counts real composer edits so a late rejection cannot confirm a newer draft.
  const draftEdits = useRef(0);
  const clearImageConfirmation = useCallback(() => {
    draftEdits.current += 1;
    setSendFailure((current) => (current?.imageConfirmation ? null : current));
  }, []);
  const imageConfirmation = sendFailure?.imageConfirmation === true;
  const sendError = sendFailure?.message ?? null;
  const setSendError = useCallback((message: string | null) => {
    setSendFailure(message === null ? null : { message, imageConfirmation: false });
  }, []);
  const uploadedSendArtifacts = useRef(new Map<string, WeakMap<File, string>>());
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dismissedRunErrorIds, setDismissedRunErrorIds] =
    useState<ReadonlySet<string>>(readSeenRunErrorIds);
  const focusPromptAbortRef = useRef<AbortController | null>(null);
  const focusPromptBotIdRef = useRef<string | null>(null);

  const activePendingAttachments = useMemo(
    () => attachmentsForThread(pendingAttachments, inGroup ? groupId : activeId),
    [activeId, groupId, inGroup, pendingAttachments],
  );
  // Keep the armed reply even when its parent leaves the loaded page: the
  // server resolves a paged-out target and degrades a deleted one to a plain
  // reply instead of failing the send.
  const activeReplyTarget = replyTarget;
  const activeReplyQuote = replyTarget ? replyQuote : null;
  // The armed reply as one value: a newer pick of the same message with a
  // different excerpt is still a newer pick.
  const armedReply = useRef({ target: activeReplyTarget, quote: activeReplyQuote });
  armedReply.current = { target: activeReplyTarget, quote: activeReplyQuote };
  const clearReply = useCallback(() => {
    setReplyTarget(null);
    setReplyQuote(null);
  }, []);
  /** Clears the reply a send carried; one picked while it was in flight stays armed. */
  const clearSentReply = useCallback((sent: ThreadMessage | null, sentQuote: string | null) => {
    if (armedReply.current.target === sent && armedReply.current.quote === sentQuote) {
      setReplyTarget(null);
      setReplyQuote(null);
    }
  }, []);
  const runError = threadRunError(activeSnapshot, dismissedRunErrorIds);
  const displayedRunError = !sendError ? runError : null;
  const displayedRunErrorId = displayedRunError ? (activeSnapshot?.run?.id ?? null) : null;
  const handleRunErrorPresented = useCallback((runId: string) => {
    rememberSeenRunErrorId(runId);
  }, []);

  function cancelFocusPrompt() {
    focusPromptAbortRef.current?.abort();
    focusPromptAbortRef.current = null;
    focusPromptBotIdRef.current = null;
  }

  /** Starts a new bot's onboarding, then offers its focus card unless the user engages first. */
  async function startFocusPrompt(botId: string, immediate: boolean) {
    // Register cancellation before awaiting start so leaving the bot during
    // startup cannot miss the abort and still schedule a late focus card.
    cancelFocusPrompt();
    const controller = new AbortController();
    focusPromptAbortRef.current = controller;
    focusPromptBotIdRef.current = botId;
    const started = await rpc.onboarding
      .start({ botId })
      .then(() => true)
      .catch(() => false);
    if (!started || controller.signal.aborted || focusPromptBotIdRef.current !== botId) {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
      return;
    }
    void scheduleFocusPrompt({
      immediate,
      signal: controller.signal,
      shouldSkip: () => sendingRef.current,
      prompt: async () => {
        if (focusPromptBotIdRef.current !== botId || activeBotId.current !== botId) return;
        await rpc.onboarding.promptFocus({ botId }).catch(() => undefined);
      },
    }).finally(() => {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
    });
  }

  useEffect(() => {
    if (focusPromptBotIdRef.current && focusPromptBotIdRef.current !== activeId) {
      cancelFocusPrompt();
    }
  }, [activeId]);

  useEffect(() => () => cancelFocusPrompt(), []);

  // Switching chats keeps other chats' pending attachments with their previews;
  // only the open chat's files are shown and sent (activePendingAttachments).
  useEffect(() => {
    clearReply();
    setAttachmentNotice(null);
    setSendError(null);
  }, [activeId, clearReply, groupId, inGroup]);

  const answerMessage = useCallback(
    async (
      message: ThreadMessage,
      text: string,
      fields?: LoginFieldInput[],
      dismiss?: boolean,
      remember?: false,
    ) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      clearReadBoundary();
      await rpc.threads.answer({
        ...(groupId ? { groupId } : { botId: botId! }),
        runId: message.runId ?? "",
        messageId: message.id,
        answer: text,
        ...(fields ? { fields } : {}),
        ...(remember === false ? { remember } : {}),
        ...(dismiss ? { dismiss: true as const } : {}),
      });
      // The answer is saved; live events can reconcile a failed refresh.
      try {
        if (groupId && activeGroupId.current === groupId) {
          await refreshGroupThreadRef.current(groupId);
        } else if (botId && activeBotId.current === botId) {
          await refreshThreadRef.current(botId);
        }
      } catch {}
    },
    [],
  );
  const reactToMessage = useCallback(
    async (message: ThreadMessage, reaction: MessageReaction) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      try {
        const result = await rpc.threads.react({
          ...(groupId ? { groupId } : { botId: botId! }),
          messageId: message.id,
          reaction,
          clientNonce: newClientId(),
        });
        if (result.runIds?.length) {
          // The reaction is saved; a failed refresh is caught up by live events.
          try {
            if (groupId && activeGroupId.current === groupId) {
              await refreshGroupThreadRef.current(groupId);
            } else if (botId && activeBotId.current === botId) {
              await refreshThreadRef.current(botId);
            }
          } catch {}
        }
      } catch (error) {
        const stillHere = groupId
          ? activeGroupId.current === groupId
          : activeBotId.current === botId;
        if (!stillHere) return;
        setSendError(errorText(error, t`Could not update reaction`));
      }
    },
    [t],
  );
  const onAttachmentPick = useCallback(
    (files: FileList | readonly File[] | null) => {
      const threadKey = activeGroupId.current ?? activeBotId.current;
      if (!threadKey || !files?.length) return false;
      const ATTACHMENT_MAX_COUNT = attachmentMaxCount(bootstrapMe);
      const existing = attachmentsForThread(pendingAttachments, threadKey);
      const next: PendingAttachment[] = [];
      const skipped: string[] = [];
      for (const file of Array.from(files)) {
        if (existing.length + next.length >= ATTACHMENT_MAX_COUNT) {
          skipped.push(t`${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
          continue;
        }
        // Raster photos get a chance to shrink before server-side size validation.
        if (file.size > attachmentMaxBytes(bootstrapMe) && !canPrepareImage(file)) {
          skipped.push(
            t`${file.name} (over ${attachmentSizeLabel(attachmentMaxBytes(bootstrapMe))})`,
          );
          continue;
        }
        const mimeType = inferAttachmentMimeType(file.name, file.type);
        if (!mimeType) {
          skipped.push(file.name);
          continue;
        }
        next.push({
          // A client id, not file metadata: two picks of equal metadata are separate attachments.
          id: newClientId(),
          threadKey,
          file,
          previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        });
      }
      if (next.length) setPendingAttachments((current) => [...current, ...next]);
      setAttachmentNotice(skipped.length ? t`Skipped ${skipped.join(", ")}` : null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return next.length > 0;
    },
    [pendingAttachments, bootstrapMe, t],
  );
  useEffect(() => {
    if (!pendingAttachments.length) uploadedSendArtifacts.current.clear();
  }, [pendingAttachments]);
  const removeAttachment = useCallback((attachment: PendingAttachment) => {
    revokePendingAttachmentPreviews([attachment]);
    setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
  }, []);
  /** A deleted chat's files can never be sent: drop them and release their previews. */
  const discardThreadAttachments = useCallback((threadKey: string) => {
    setPendingAttachments((current) => {
      const discarded = attachmentsForThread(current, threadKey);
      if (!discarded.length) return current;
      revokePendingAttachmentPreviews(discarded);
      return current.filter((attachment) => !discarded.includes(attachment));
    });
  }, []);
  const sendMessage = useCallback(
    async (
      draft: string,
      mentions: ComposerMention[],
      clientNonce: string,
      imageHandling?: "file",
    ) => {
      const initialBotTarget = activeBotId.current;
      const initialGroupTarget = activeGroupId.current;
      if ((!initialBotTarget && !initialGroupTarget) || sending) return false;
      const editsAtSend = draftEdits.current;
      // The reply this send carries, read from the ref so a callback that outlived
      // a re-pick of the same message still carries the armed one; a reply picked
      // after this point is for the next message.
      const { target: replyAtSend, quote: replyQuoteAtSend } = armedReply.current;
      const originThreadKey = initialGroupTarget ?? initialBotTarget;
      const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
      const plan = resolveComposerSendPlan({
        text: draft,
        mentions,
        hasAttachments: attachments.length > 0,
      });
      if (plan.isNoOp) return false;
      const reroutedToGroup = Boolean(
        plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
      );
      const groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
      const botTarget = reroutedToGroup ? undefined : initialBotTarget;
      if (
        plan.shouldSend &&
        (groupTarget || botsRef.current.find((bot) => bot.id === botTarget)?.notifyOnFinish)
      ) {
        const permissionRequest = requestBrowserNotificationPermission();
        if (permissionRequest) void permissionRequest.then(flushPendingBrowserNotifications);
      }
      // The open page rides only on text this chat sends, never on a group or routine-only send.
      const fromPage =
        plan.shouldSend && !reroutedToGroup
          ? pageSession.send(plan.trimmed, activeSnapshot?.messages ?? [], replyAtSend?.id)
          : { text: plan.trimmed, replyToMessageId: undefined };
      const trimmed = fromPage.text.trim();
      const replyToMessageId = fromPage.replyToMessageId;
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      clearReadBoundary();
      setSentCount((count) => count + 1);
      const dropDelayedSetup = () => {
        // Only after successful engagement so a failed upload/send keeps the setup card.
        if (initialBotTarget && focusPromptBotIdRef.current === initialBotTarget) {
          cancelFocusPrompt();
        }
      };
      // Keep the draft cleared once the submission is confirmed accepted.
      let accepted = false;
      try {
        if (!plan.shouldSend) {
          if (plan.shouldRunRoutines) {
            await rpc.threads.sendWithRoutines({
              ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
              clientNonce,
              routineIds: plan.routineIds,
            });
            accepted = true;
          }
          dropDelayedSetup();
          clearSentReply(replyAtSend, replyQuoteAtSend);
          revokePendingAttachmentPreviews(attachments);
          setPendingAttachments((current) =>
            current.filter((attachment) => !attachments.includes(attachment)),
          );
          setAttachmentNotice(null);
          if (reroutedToGroup && groupTarget) {
            navigate(`/app/g/${groupTarget}`);
            return true;
          }
          // The routine is saved; live events reconcile a failed refresh.
          if (groupTarget && activeGroupId.current === groupTarget) {
            void refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
          } else if (botTarget && activeBotId.current === botTarget) {
            void refreshThreadRef.current(botTarget).catch(() => undefined);
          }
          return true;
        }
        const artifactIds: string[] = [];
        const uploaded =
          uploadedSendArtifacts.current.get(clientNonce) ?? new WeakMap<File, string>();
        uploadedSendArtifacts.current.set(clientNonce, uploaded);
        for (const pending of attachments) {
          const existing = uploaded.get(pending.file);
          if (existing) {
            artifactIds.push(existing);
            continue;
          }
          const mimeType = inferAttachmentMimeType(pending.file.name, pending.file.type);
          if (!mimeType) {
            throw new Error(t`Unsupported file type: ${pending.file.name}`);
          }
          const file = await prepareImage(pending.file);
          const contentBase64 = await readFileAsBase64(file);
          // Stable per pending attachment, so a retry under a new send nonce
          // (an edited draft) gets back the artifact this upload already made.
          // Scoped to the target: a retry rerouted to a group uploads afresh
          // rather than replaying another chat's artifact.
          const uploadNonce = `attachment:${groupTarget ?? botTarget}:${pending.id}`;
          const artifact = await rpc.artifacts.create(
            groupTarget
              ? {
                  groupId: groupTarget,
                  name: pending.file.name,
                  mimeType,
                  contentBase64,
                  clientNonce: uploadNonce,
                }
              : {
                  botId: botTarget!,
                  name: pending.file.name,
                  mimeType,
                  contentBase64,
                  clientNonce: uploadNonce,
                },
          );
          uploaded.set(pending.file, artifact.id);
          artifactIds.push(artifact.id);
        }
        const payload = {
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
          clientNonce,
          imageHandling: imageHandling ?? "confirm",
          text: trimmed || undefined,
          mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
          artifactIds: artifactIds.length ? artifactIds : undefined,
          replyToMessageId: reroutedToGroup ? undefined : (replyToMessageId ?? replyAtSend?.id),
          replyQuote:
            reroutedToGroup || replyToMessageId ? undefined : (replyQuoteAtSend ?? undefined),
          fromPage: !reroutedToGroup && replyToMessageId ? true : undefined,
        } as const;
        // The routines run in the same server operation as the message: both or neither.
        const sent = plan.shouldRunRoutines
          ? (await rpc.threads.sendWithRoutines({ ...payload, routineIds: plan.routineIds })).send
          : await rpc.threads.send(payload);
        accepted = true;
        if (sent && botTarget && activeBotId.current === botTarget) {
          updateSnapshot((current) =>
            applyThreadSendReceipt(
              current,
              {
                botId: botTarget,
                runId: sent.runId,
                taskId: sent.taskId,
              },
              terminalRunReceipts.current,
            ),
          );
        }
        uploadedSendArtifacts.current.delete(clientNonce);
        dropDelayedSetup();
        clearSentReply(replyAtSend, replyQuoteAtSend);
        revokePendingAttachmentPreviews(attachments);
        // Keep files picked while this send was in flight.
        setPendingAttachments((current) =>
          current.filter((attachment) => !attachments.includes(attachment)),
        );
        // Refresh sidebar status even when a bot→group reroute navigates away below.
        void refreshBots().catch(() => undefined);
        if (reroutedToGroup && groupTarget) {
          navigate(`/app/g/${groupTarget}`);
          return true;
        }
        if (groupTarget && activeGroupId.current === groupTarget) setAttachmentNotice(null);
        if (botTarget && activeBotId.current === botTarget) setAttachmentNotice(null);
        if (groupTarget) void refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        else if (botTarget) void refreshThreadRef.current(botTarget).catch(() => undefined);
        return true;
      } catch (error) {
        const isConfirmation = isImageInputConfirmation(error);
        // Offer the file resend only for the unchanged draft this send carried.
        const confirmation = isConfirmation && draftEdits.current === editsAtSend;
        const failure = {
          message: errorText(error, t`Failed to send message`),
          imageConfirmation: confirmation,
        };
        if (
          reroutedToGroup &&
          groupTarget &&
          activeBotId.current === initialBotTarget &&
          activeGroupId.current === initialGroupTarget
        ) {
          setSendFailure(failure);
        } else if (groupTarget && activeGroupId.current === groupTarget) {
          setSendFailure(failure);
        } else if (botTarget && activeBotId.current === botTarget) {
          setSendFailure(failure);
        }
        return isConfirmation ? false : accepted;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [
      activeSnapshot?.messages,
      pageSession,
      clearSentReply,
      flushPendingBrowserNotifications,
      navigate,
      pendingAttachments,
      sending,
      t,
    ],
  );
  const stopRun = useCallback(async () => {
    if (sending) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if (groupTarget) {
        setSendError(null);
        try {
          await rpc.threads.stop({ groupId: groupTarget });
        } catch (error) {
          if (activeGroupId.current === groupTarget) {
            setSendError(errorText(error, t`Failed to stop`));
          }
          return;
        }
        // Clear run UI ahead of the run.cancelled event so refresh races with in-flight gets.
        if (activeGroupId.current === groupTarget) {
          updateSnapshot((prev) =>
            prev && prev.groupId === groupTarget ? clearActiveThreadRuns(prev) : prev,
          );
        }
        await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        return;
      }
      if (!botTarget) return;
      setSendError(null);
      try {
        await rpc.threads.stop({ botId: botTarget });
      } catch (error) {
        if (activeBotId.current === botTarget) {
          setSendError(errorText(error, t`Failed to stop`));
        }
        return;
      }
      // Clear local run/busy immediately rather than waiting for run.cancelled so a
      // superseded in-flight refresh (older cursor) cannot leave Stop enabled / Take control
      // blocked while the API is already idle.
      if (activeBotId.current === botTarget) {
        updateSnapshot((prev) =>
          !prev || (prev.botId !== botTarget && prev.botId) ? prev : clearActiveThreadRuns(prev),
        );
        const currentComputer = computerRef.current;
        if (currentComputer?.busyBotName) {
          commitComputer({ ...currentComputer, busyBotName: null });
        }
      }
      await refreshThreadRef.current(botTarget).catch(() => undefined);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [sending, t]);

  function dismissComposerError() {
    // The strip shows one message at a time, so only dismiss the run failure when it is the
    // one on screen; otherwise a live run would be silenced before it has even failed.
    const failedRunId = displayedRunErrorId;
    setSendError(null);
    if (failedRunId) {
      rememberSeenRunErrorId(failedRunId);
      setDismissedRunErrorIds((current) => new Set(current).add(failedRunId));
    }
  }

  return {
    activePendingAttachments,
    attachmentNotice,
    fileInputRef,
    onAttachmentPick,
    removeAttachment,
    discardThreadAttachments,
    replyTarget: activeReplyTarget,
    replyQuote: activeReplyQuote,
    setReplyTarget,
    setReplyQuote,
    clearReply,
    sending,
    sentCount,
    sendMessage,
    stopRun,
    answerMessage,
    reactToMessage,
    sendError,
    setSendError,
    imageConfirmation,
    clearImageConfirmation,
    dismissedRunErrorIds,
    displayedRunError,
    displayedRunErrorId,
    handleRunErrorPresented,
    dismissComposerError,
    startFocusPrompt,
  };
}
