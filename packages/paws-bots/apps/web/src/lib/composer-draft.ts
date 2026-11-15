import { localStore } from "../paws/runtime";
import type { ComposerMentionBinding } from "@rakazo/core";
import { createKeyedListeners, validateComposerMentionBindings } from "@rakazo/core";

export const COMPOSER_DRAFT_STORAGE_PREFIX = "rakazo.composerDraft.";
const COMPOSER_BINDINGS_STORAGE_PREFIX = "rakazo.composerBindings.";
const COMPOSER_NONCE_STORAGE_PREFIX = "rakazo.composerNonce.";

/** `appended`: words added from outside the composer while this send was in flight. */
type ComposerDraftSubmission = { text: string; bindingRecord: string | null; appended?: string };
const pendingSubmissions = new Map<string, ComposerDraftSubmission>();
const acceptedListeners = new Map<string, Set<(text: string) => void>>();
const replacedDrafts = createKeyedListeners<string>();

/** The composer showing a chat follows its saved draft when something else rewrites it. */
export const subscribeComposerDraftReplaced = replacedDrafts.subscribe;

function savedDraftOf(submission: ComposerDraftSubmission): string {
  return submission.appended ? `${submission.text} ${submission.appended}` : submission.text;
}

/**
 * Adds words to a chat's saved draft from outside its composer, such as a dictation that
 * finished after the chat was left. A composer showing that chat shows them. A send still in
 * flight from that draft keeps its settlement: once accepted, only the added words remain.
 */
export function appendComposerDraftText(threadKey: string, text: string): void {
  const saved = readComposerDraft(threadKey);
  const next = saved ? `${saved} ${text}` : text;
  const pending = pendingSubmissions.get(threadKey);
  // Only a draft still holding the in-flight text and its mention bindings belongs to that
  // send; another tab can rebind the same text to another mention.
  const inFlight =
    pending &&
    savedDraftOf(pending) === saved &&
    readBindingRecord(threadKey) === pending.bindingRecord
      ? pending
      : null;
  writeComposerDraft(threadKey, next, undefined, readComposerDraftBindings(threadKey));
  if (inFlight) {
    inFlight.appended = inFlight.appended ? `${inFlight.appended} ${text}` : text;
    inFlight.bindingRecord = readBindingRecord(threadKey);
    pendingSubmissions.set(threadKey, inFlight);
  }
  replacedDrafts.emit(threadKey, next);
}

/** Rewrites a chat's saved draft from outside its composer; a composer showing it follows. */
export function replaceComposerDraft(
  threadKey: string,
  text: string,
  bindings: readonly ComposerMentionBinding[],
): void {
  writeComposerDraft(threadKey, text, undefined, bindings);
  replacedDrafts.emit(threadKey, text);
}

export function beginComposerDraftSubmission(
  threadKey: string,
  text: string,
): ComposerDraftSubmission {
  writeComposerDraft(threadKey, text);
  // The send that begins now carries its own nonce; a stored one is consumed.
  writeComposerRetryNonce(threadKey, null);
  const submission = { text, bindingRecord: readBindingRecord(threadKey) };
  pendingSubmissions.set(threadKey, submission);
  return submission;
}

export function settleComposerDraftSubmission(
  threadKey: string,
  submission: ComposerDraftSubmission,
  accepted: boolean,
): void {
  if (pendingSubmissions.get(threadKey) !== submission) return;
  pendingSubmissions.delete(threadKey);
  if (
    !accepted ||
    readComposerDraft(threadKey) !== savedDraftOf(submission) ||
    readBindingRecord(threadKey) !== submission.bindingRecord
  )
    return;
  if (submission.appended) {
    writeComposerDraft(threadKey, submission.appended);
    replacedDrafts.emit(threadKey, submission.appended);
    return;
  }
  writeComposerDraft(threadKey, "");
  for (const listener of acceptedListeners.get(threadKey) ?? []) listener(submission.text);
}

/**
 * Keeps a failed send's nonce beside the saved draft only while that draft is
 * still the one it sent, mentions included, so a retry cannot reuse it for a
 * different payload.
 */
export function keepComposerRetryNonce(
  threadKey: string,
  submission: ComposerDraftSubmission,
  nonce: string,
): void {
  if (
    readComposerDraft(threadKey) === submission.text &&
    readBindingRecord(threadKey) === submission.bindingRecord
  )
    writeComposerRetryNonce(threadKey, nonce);
}

let sendingWork = false;
let attachmentWork = false;

/**
 * The shell reports work a reload would lose: a send (typed or spoken) until the server answers,
 * or picked attachments, which live only in memory.
 */
export function setComposerUnsavedWork(work: { sending: boolean; attachments: boolean }): void {
  sendingWork = work.sending;
  attachmentWork = work.attachments;
}

/** A send waiting for its answer, or attachments that only exist in memory. */
export function composerHoldsUnsavedWork(): boolean {
  return composerHoldsWorkInFlight() || attachmentWork;
}

/** A send waiting for its answer. Unlike picked attachments, it finishes on its own. */
export function composerHoldsWorkInFlight(): boolean {
  return pendingSubmissions.size > 0 || sendingWork;
}

/** Unsaved composer work, or saved text in any composer that has not been sent. */
export function hasUnsentComposerDraft(storage: Storage | null = null): boolean {
  if (composerHoldsUnsavedWork()) return true;
  try {
    const drafts = storage ?? localStore;
    for (let index = 0; index < drafts.length; index++) {
      const key = drafts.key(index);
      if (key?.startsWith(COMPOSER_DRAFT_STORAGE_PREFIX) && drafts.getItem(key)) return true;
    }
  } catch {
    // Without storage the draft lives only in memory, so treat it as unsent.
    return true;
  }
  return false;
}

/** Signing out leaves no saved draft, its mentions or its retry nonce for whoever uses this browser next. */
export function clearComposerDrafts(): void {
  try {
    const keys = Array.from({ length: localStore.length }, (_, index) => localStore.key(index));
    for (const key of keys) {
      if (
        key?.startsWith(COMPOSER_DRAFT_STORAGE_PREFIX) ||
        key?.startsWith(COMPOSER_BINDINGS_STORAGE_PREFIX) ||
        key?.startsWith(COMPOSER_NONCE_STORAGE_PREFIX)
      )
        localStore.removeItem(key);
    }
  } catch {
    // Without storage no draft was saved.
  }
}

export function subscribeComposerDraftAccepted(
  threadKey: string,
  listener: (text: string) => void,
): () => void {
  let listeners = acceptedListeners.get(threadKey);
  if (!listeners) {
    listeners = new Set();
    acceptedListeners.set(threadKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) acceptedListeners.delete(threadKey);
  };
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function getLocalStorage(): DraftStorage | null {
  try {
    return typeof localStore === "undefined" ? null : localStore;
  } catch {
    return null;
  }
}

export function composerDraftStorageKey(threadKey: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${threadKey}`;
}

export function composerDraftBindingsKey(threadKey: string): string {
  return `${COMPOSER_BINDINGS_STORAGE_PREFIX}${threadKey}`;
}

function composerNonceStorageKey(threadKey: string): string {
  return `${COMPOSER_NONCE_STORAGE_PREFIX}${threadKey}`;
}

/**
 * The nonce of a send that ended without its answer, kept beside a draft the
 * user has not touched, so an unchanged retry is recognized as the same
 * message instead of creating a duplicate.
 */
export function readComposerRetryNonce(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): string | null {
  if (!storage || !threadKey) return null;
  try {
    return storage.getItem(composerNonceStorageKey(threadKey));
  } catch {
    return null;
  }
}

/** A null nonce clears it; writes are best-effort, like the draft itself. */
export function writeComposerRetryNonce(
  threadKey: string,
  nonce: string | null,
  storage: DraftStorage | null = getLocalStorage(),
): void {
  if (!storage || !threadKey) return;
  try {
    if (nonce === null) storage.removeItem(composerNonceStorageKey(threadKey));
    else storage.setItem(composerNonceStorageKey(threadKey), nonce);
  } catch {
    // The in-memory nonce still covers the retry while this chat stays open.
  }
}

function readBindingRecord(threadKey: string, storage = getLocalStorage()): string | null {
  try {
    return storage?.getItem(composerDraftBindingsKey(threadKey)) ?? null;
  } catch {
    return null;
  }
}

/** Bindings are optional metadata; a stale record must never replace the raw text. */
export function readComposerDraftBindings(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): ComposerMentionBinding[] {
  if (!storage || !threadKey) return [];
  const key = composerDraftBindingsKey(threadKey);
  try {
    const raw = readBindingRecord(threadKey, storage);
    if (!raw) return [];
    const record = JSON.parse(raw);
    const text = readComposerDraft(threadKey, storage);
    if (record?.version !== 1 || record.text !== text) {
      storage.removeItem(key);
      return [];
    }
    return validateComposerMentionBindings(text, record.bindings);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* The in-memory draft remains usable. */
    }
    return [];
  }
}

export function readComposerDraft(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): string {
  if (!storage || !threadKey) return "";
  try {
    return storage.getItem(composerDraftStorageKey(threadKey)) ?? "";
  } catch {
    return "";
  }
}

export function writeComposerDraft(
  threadKey: string,
  draft: string,
  storage: DraftStorage | null = getLocalStorage(),
  bindings?: readonly ComposerMentionBinding[],
): void {
  pendingSubmissions.delete(threadKey);
  if (!storage || !threadKey) return;
  try {
    // Plain-text callers preserve bindings only when they are resubmitting the
    // unchanged draft. New text without bindings cannot inherit old identities,
    // and a changed draft no longer matches the nonce its predecessor left.
    if (bindings !== undefined || draft !== readComposerDraft(threadKey, storage) || !draft) {
      storage.removeItem(composerDraftBindingsKey(threadKey));
      storage.removeItem(composerNonceStorageKey(threadKey));
    }
    if (draft.length === 0) storage.removeItem(composerDraftStorageKey(threadKey));
    else storage.setItem(composerDraftStorageKey(threadKey), draft);
    if (bindings?.length && draft) {
      storage.setItem(
        composerDraftBindingsKey(threadKey),
        JSON.stringify({ version: 1, text: draft, bindings }),
      );
    }
  } catch {
    // Quota or private-mode failures: the draft still lives in memory.
  }
}

/** The composer key for a chat: one bot's chat or a group's. */
export function composerDraftKey(target: { botId: string } | { groupId: string }): string {
  return "botId" in target ? `bot:${target.botId}` : `group:${target.groupId}`;
}

const composerOffers = createKeyedListeners<string>();

/** Text a card in the chat hands to that chat's composer; the person still sends it. */
export const offerComposerText = composerOffers.emit;
export const subscribeComposerOffer = composerOffers.subscribe;
