import type { AttachmentMimeType, HistoryToolStep, MessageBlock } from "@rakazo/contracts";
import {
  ATTACHMENT_COUNT_CEILING,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  attachmentSizeLabel,
  isAllowedAttachmentMimeType,
  isAttachmentImageMimeType,
} from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock } from "./action-approval.js";

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

/**
 * Validates base64 without a grouped-repetition regex over the whole string:
 * `/^(?:[A-Za-z0-9+/]{4})*(...)?$/` overflows V8's regex stack on multi-megabyte
 * inputs, which ordinary attachments reach. A flat `[chars]*` quantifier does not;
 * padding is checked separately since it can only be the trailing 0-2 characters.
 */
function isWellFormedBase64(value: string): boolean {
  const paddingMatch = /={1,2}$/.exec(value);
  const paddingLength = paddingMatch ? paddingMatch[0].length : 0;
  const body = paddingLength > 0 ? value.slice(0, value.length - paddingLength) : value;
  if (body.includes("=")) return false;
  return /^[A-Za-z0-9+/]*$/.test(body);
}

export function attachmentCountFromEnv(source: { MAX_ATTACHMENTS_PER_MESSAGE?: string }): number {
  const value = source.MAX_ATTACHMENTS_PER_MESSAGE?.trim();
  if (!value) return ATTACHMENT_MAX_COUNT;
  const count = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > ATTACHMENT_COUNT_CEILING
  ) {
    throw new Error(
      `MAX_ATTACHMENTS_PER_MESSAGE must be an integer from 1 to ${ATTACHMENT_COUNT_CEILING}`,
    );
  }
  return count;
}

export function uploadSizeFromEnv(source: { MAX_UPLOAD_SIZE_MB?: string }): number {
  const value = source.MAX_UPLOAD_SIZE_MB?.trim();
  if (!value) return ATTACHMENT_MAX_BYTES;
  const mb = Number(value);
  // Leave room for base64 expansion and the JSON envelope in the HTTP body guard.
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(mb) ||
    mb <= 0 ||
    mb > Math.floor(Number.MAX_SAFE_INTEGER / (2 * 1024 * 1024))
  ) {
    throw new Error(
      "MAX_UPLOAD_SIZE_MB must be a positive integer number of MiB within the safe byte range",
    );
  }
  return mb * 1024 * 1024;
}

export function decodeAttachmentBase64(
  contentBase64: string,
  maxBytes = ATTACHMENT_MAX_BYTES,
): Uint8Array {
  const normalized = contentBase64.trim();
  if (!normalized) throw new AttachmentValidationError("Attachment content is empty");
  if (normalized.length > Math.ceil(maxBytes / 3) * 4) {
    throw new AttachmentValidationError(
      `Attachment exceeds the ${attachmentSizeLabel(maxBytes)} limit`,
    );
  }
  if (normalized.length % 4 !== 0 || !isWellFormedBase64(normalized)) {
    throw new AttachmentValidationError("Attachment content is not valid base64");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalized, "base64");
  } catch {
    throw new AttachmentValidationError("Attachment content is not valid base64");
  }
  if (bytes.byteLength === 0) throw new AttachmentValidationError("Attachment content is empty");
  if (bytes.byteLength > maxBytes) {
    throw new AttachmentValidationError(
      `Attachment exceeds the ${attachmentSizeLabel(maxBytes)} limit`,
    );
  }
  return new Uint8Array(bytes);
}

export function validateAttachmentMimeType(mimeType: string): void {
  if (!isAllowedAttachmentMimeType(mimeType)) {
    throw new AttachmentValidationError(`Unsupported attachment type: ${mimeType}`);
  }
}

export function attachmentKindForMimeType(mimeType: string): "image" | "file" {
  return isAttachmentImageMimeType(mimeType) ? "image" : "file";
}

export function messageBlockForArtifact(artifact: {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}): Extract<MessageBlock, { kind: "image" | "file" }> {
  if (attachmentKindForMimeType(artifact.mimeType) === "image") {
    return {
      kind: "image",
      artifactId: artifact.id,
      mimeType: artifact.mimeType,
      name: artifact.name,
    };
  }
  return {
    kind: "file",
    artifactId: artifact.id,
    mimeType: artifact.mimeType,
    name: artifact.name,
    size: artifact.size,
  };
}

/** Untrusted transcript text is bounded before it reaches a prompt. */
const VOICE_TRANSCRIPT_MAX_CHARS = 4000;

/** Keeps tabs and newlines, drops C0, DEL and C1 control characters, trims and bounds the text. */
export function normalizeVoiceTranscript(value: string | null | undefined): string {
  if (!value) return "";
  const printable = Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code === 9 || code === 10) return true;
      return code >= 32 && !(code >= 0x7f && code <= 0x9f);
    })
    .join("");
  return printable.trim().slice(0, VOICE_TRANSCRIPT_MAX_CHARS);
}

export function promptTextForAttachments(
  text: string | undefined,
  artifacts: Array<{
    name: string;
    mimeType: string;
    size: number;
    /** Normalized words transcribed from an inbound audio attachment. */
    transcript?: string;
  }>,
): string {
  const caption = text?.trim() ?? "";
  const notes = artifacts
    .filter((artifact) => !isAttachmentImageMimeType(artifact.mimeType))
    .map((artifact) => {
      const note = `User attached file ${JSON.stringify(artifact.name)} (${artifact.mimeType}, ${artifact.size} bytes).`;
      return artifact.transcript
        ? `${note}\n[voice note transcript: ${artifact.transcript}]`
        : note;
    });
  return [caption, ...notes].filter(Boolean).join("\n\n") || "See attached files.";
}

const TOOL_STEP_NOTE_MAX_CHARS = 300;
const TOOL_STEP_MAX_LINES = 40;
/** Tool names are at most 64 characters; only imported data could carry a longer label. */
const TOOL_STEP_LABEL_MAX_CHARS = 80;

/**
 * An earlier reply's tool steps as the bot sees them again: label, count and note. Replay caps
 * notes and steps; history reads pass `full`, since they page through long text themselves.
 */
export function toolStepsHistoryText(
  steps: Extract<MessageBlock, { kind: "steps" }>["steps"],
  { full = false }: { full?: boolean } = {},
): string {
  // Stored blocks can come from an account import, so skip malformed entries instead of throwing.
  const valid = Array.isArray(steps) ? steps.filter((step) => typeof step?.label === "string") : [];
  if (valid.length === 0) return "";
  const shown = full ? valid : valid.slice(0, TOOL_STEP_MAX_LINES);
  const lines = shown.map((step) => {
    const name =
      !full && step.label.length > TOOL_STEP_LABEL_MAX_CHARS
        ? `${step.label.slice(0, TOOL_STEP_LABEL_MAX_CHARS)}…`
        : step.label;
    const counted = Number(step.count) > 1 ? `${name} ×${step.count}` : name;
    const outcome = toolStepOutcomeText(step);
    const label = outcome ? `${counted} (${outcome})` : counted;
    const whole = typeof step.note === "string" ? step.note.replace(/\s+/g, " ").trim() : "";
    const note =
      !full && whole.length > TOOL_STEP_NOTE_MAX_CHARS
        ? `${whole.slice(0, TOOL_STEP_NOTE_MAX_CHARS)}…`
        : whole;
    return note ? `- ${label}: ${note}` : `- ${label}`;
  });
  const hidden = valid.length - shown.length;
  if (hidden > 0) lines.push(`- …and ${hidden} more`);
  // "Made" rather than "ran": a call the loop guard stopped is still recorded as a step.
  return `[tool calls this reply made]\n${lines.join("\n")}`;
}

const TOOL_STEP_OUTCOMES = ["succeeded", "failed", "stopped"] as const;

/** "succeeded" when every call ended the same way, else "2 succeeded, 1 failed". */
export function toolStepOutcomeText(step: { count: number; outcomes?: unknown }): string {
  const outcomes = (step.outcomes ?? {}) as Partial<Record<string, unknown>>;
  if (typeof outcomes !== "object") return "";
  const counts = TOOL_STEP_OUTCOMES.flatMap((outcome) => {
    const count = Number(outcomes[outcome]);
    return Number.isInteger(count) && count > 0 ? [{ outcome, count }] : [];
  });
  const [only] = counts;
  if (counts.length === 1 && only?.count === Number(step.count)) return only.outcome;
  return counts.map(({ outcome, count }) => `${count} ${outcome}`).join(", ");
}

export function blocksToAgentHistoryText(blocks: MessageBlock[]): string {
  return blocks.map(blockHistoryText).filter(Boolean).join("\n");
}

/** A reply in order, with its tool steps apart from the text around them. */
export type AgentHistorySegment = { text: string } | { steps: HistoryToolStep[] };

/**
 * The same reply as blocksToAgentHistoryText, split at its tool steps so a runtime can replay
 * them as tool calls. Text between steps is joined as blocksToAgentHistoryText joins it.
 */
export function blocksToAgentHistorySegments(blocks: MessageBlock[]): AgentHistorySegment[] {
  const segments: AgentHistorySegment[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) segments.push({ text: text.join("\n") });
    text = [];
  };
  for (const block of blocks) {
    if (block.kind === "steps") {
      // Stored blocks can come from an account import, so skip malformed entries.
      const steps = Array.isArray(block.steps)
        ? (block.steps as HistoryToolStep[]).filter((step) => typeof step?.label === "string")
        : [];
      if (!steps.length) continue;
      flush();
      segments.push({ steps });
      continue;
    }
    const rendered = blockHistoryText(block);
    if (rendered) text.push(rendered);
  }
  flush();
  return segments;
}

function blockHistoryText(block: MessageBlock): string {
  if (block.kind === "text") return block.text;
  // The tools a reply used, and what the bot wrote before each, are kept out of its text;
  // without them a later turn cannot tell what it already did.
  if (block.kind === "steps") return toolStepsHistoryText(block.steps);
  if (block.kind === "chart") return `[chart: ${block.name}]`;
  if (block.kind === "app") return `[app: ${block.server} showed ${block.tool}]`;
  if (block.kind === "image") return `[image: ${block.name}]`;
  // The id lets a later turn, or another chat, update this page instead of making a new one.
  if (block.kind === "page") {
    return `[page: ${block.title} (pageId ${block.pageId}, version ${block.version})]`;
  }
  if (block.kind === "file") {
    return `[file: ${block.name} (${block.mimeType}, ${block.size} bytes)]`;
  }
  // Keep attribution on peer messages: without it a later turn cannot tell
  // which lines came from another bot rather than the user.
  if (block.kind === "bot_message_received") return `[from ${block.fromBotName}] ${block.text}`;
  if (block.kind === "bot_message_sent") return `[to ${block.toBotName}] ${block.text}`;
  if (block.kind === "channel_message") return `[from ${block.fromLabel}] ${block.text}`;
  if (block.kind === "handoff") {
    return `[handoff ${block.fromBotId} -> ${block.toBotId}] ${block.text}`;
  }
  // Without the answer a later turn sees the question as still open and asks it again.
  if (block.kind === "ask") {
    // A question card keeps its draft in the detail, and a later turn still needs
    // it: approval cards repeat tool arguments the call itself records, and secret
    // cards keep their detail hidden. The draft is fenced so a line in it cannot
    // pass for the answer; only something that reads as a closing draft tag (any case or
    // spacing) is escaped, so the bot reads the rest of its draft verbatim (an address
    // like "Ana <ana@example.test>" stays as written).
    const detail =
      block.detail && !isApprovalAskBlock(block) && !isSecretAskBlock(block)
        ? `\n<draft>\n${block.detail.replace(/<\s*\/\s*draft\s*>/gi, "&lt;/draft&gt;")}\n</draft>`
        : "";
    if (block.status !== "answered" || !block.answer) return `${block.text}${detail}`;
    const choice = block.actions?.find((action) => action.id === block.answer);
    return `${block.text}${detail}\nAnswer: ${choice?.label ?? block.answer}`;
  }
  // The bot needs the outcome of its own call: a missed call is its cue to follow up.
  if (block.kind === "call_request") {
    const outcome = {
      ringing: "still ringing",
      answered: "the user answered",
      declined: "the user declined it",
      missed: "the user did not answer",
    }[block.status];
    return `[you called the user about: ${block.reason}; ${outcome}]${block.status === "answered" ? `\n${block.opening}` : ""}`;
  }
  if ("text" in block && typeof block.text === "string") return block.text;
  return "";
}

const EXTENSION_MIME_TYPES: Record<string, AttachmentMimeType> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".zip": "application/zip",
};

const MIME_TYPE_EXTENSIONS: Record<AttachmentMimeType, string> = {
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/html": ".html",
  "application/json": ".json",
  "application/zip": ".zip",
};

/** Short file-type badge, as a file's extension reads ("TXT", "MD", "PDF"). */
export function artifactTypeLabel(mimeType: string): string {
  const extension = attachmentExtensionForMimeType(mimeType);
  if (extension) return extension.slice(1).toUpperCase();
  const slash = mimeType.indexOf("/");
  return (slash === -1 ? mimeType : mimeType.slice(slash + 1)).toUpperCase().slice(0, 6);
}

export function inferAttachmentMimeType(
  name: string,
  reportedType?: string,
): AttachmentMimeType | null {
  if (
    reportedType === "application/x-zip-compressed" ||
    reportedType === "application/x-zip" ||
    reportedType === "multipart/x-zip"
  ) {
    return "application/zip";
  }
  const audioAliases: Record<string, AttachmentMimeType> = {
    "audio/mp3": "audio/mpeg",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/vnd.wave": "audio/wav",
    "audio/x-m4a": "audio/mp4",
  };
  if (reportedType && Object.hasOwn(audioAliases, reportedType)) return audioAliases[reportedType]!;
  // audio/aac may describe an M4A's codec, not its container. Infer from .m4a;
  // do not advertise standalone AAC streams as MP4 containers.
  const dot = name.lastIndexOf(".");
  const extensionType = dot < 0 ? undefined : EXTENSION_MIME_TYPES[name.slice(dot).toLowerCase()];
  // Some browsers and native document pickers report Markdown as text/plain.
  if (extensionType === "text/markdown" && (!reportedType || reportedType === "text/plain")) {
    return extensionType;
  }
  // Windows reports .csv as an Excel file when Excel is installed.
  if (extensionType === "text/csv" && reportedType === "application/vnd.ms-excel") {
    return extensionType;
  }
  if (reportedType && isAllowedAttachmentMimeType(reportedType)) return reportedType;
  return extensionType ?? null;
}

export function attachmentExtensionForMimeType(mimeType: string): string {
  return isAllowedAttachmentMimeType(mimeType) ? MIME_TYPE_EXTENSIONS[mimeType] : "";
}

/** Where a run copies an attached file in the bot's workspace; history tools report the same path. */
export function attachmentComputerPath(artifactId: string, mimeType: string): string {
  return `attachments/${artifactId}${attachmentExtensionForMimeType(mimeType)}`;
}

export function attachmentsForThread<T extends { threadKey: string }>(
  attachments: readonly T[],
  threadKey: string | undefined,
): T[] {
  if (!threadKey) return [];
  return attachments.filter((attachment) => attachment.threadKey === threadKey);
}

export function attachmentsForBot<T extends { botId: string }>(
  attachments: readonly T[],
  botId: string | undefined,
): T[] {
  if (!botId) return [];
  return attachments.filter((attachment) => attachment.botId === botId);
}

/**
 * The message whose attachments this run receives: a person's message, or a message or
 * handoff another bot delivered, whose files arrive the same way.
 */
export function userTurnMessageForRun<
  T extends { id?: string; role: string; runId?: string | null; blocks: MessageBlock[] },
>(trigger: string, runId: string, messages: T[], sourceMessageId?: string | null): T | undefined {
  if (trigger === "bot_message" || trigger === "follow_up") {
    if (!sourceMessageId) return undefined;
    return messages.find(
      (message) =>
        message.id === sourceMessageId &&
        message.blocks.some(
          (block) => block.kind === "bot_message_received" || block.kind === "handoff",
        ),
    );
  }
  if (trigger !== "user" && trigger !== "messaging" && trigger !== "reaction") return undefined;
  return messages.find(
    (message) =>
      message.role === "user" &&
      (sourceMessageId ? message.id === sourceMessageId : message.runId === runId),
  );
}

/** Bound PNG inspection before image decoding on every client. */
export const PNG_ANIMATION_HEADER_BYTES = 64 * 1024;

/** Only re-encode PNGs whose header confirms they are static; unknown stays original. */
export function isStaticPng(bytes: Uint8Array): boolean {
  if (
    bytes.length < 33 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeAt = (offset: number) => String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  if (view.getUint32(8) !== 13 || typeAt(8) !== "IHDR") return false;
  const end = Math.min(bytes.length, PNG_ANIMATION_HEADER_BYTES);
  for (let offset = 33; offset + 8 <= end; ) {
    const type = typeAt(offset);
    // An APNG must declare acTL before its first IDAT, even with one animation frame.
    if (type === "acTL" || type === "IEND") return false;
    if (type === "IDAT") return true;
    const next = offset + 12 + view.getUint32(offset);
    if (next > end) return false;
    offset = next;
  }
  return false;
}
