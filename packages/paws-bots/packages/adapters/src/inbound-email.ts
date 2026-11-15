import { createHash } from "node:crypto";
import type { Address } from "postal-mime";
import { htmlToPlainText } from "./keyless-http-web.js";
import { sliceWellFormed } from "./utf8.js";

/** Largest raw message accepted, the size common mail relays deliver. */
export const INBOUND_EMAIL_MAX_BYTES = 25 * 1024 * 1024;

/** DKIM signatures checked per message; mail carrying more is never verified. */
export const INBOUND_EMAIL_MAX_SIGNATURES = 5;

/** Body text handed to the bot; longer mail is cut here. */
export const INBOUND_EMAIL_TEXT_MAX_CHARS = 20_000;

/** DNS TXT lookups for DKIM keys; tests pass a fixed one. */
export type InboundEmailResolver = (
  domain: string,
  rrtype: string,
) => Promise<string[][] | string[]>;

export type InboundEmail = {
  /**
   * The same message always gets the same key: its verified DKIM signature, which a resent copy
   * cannot change, else a hash of what it says.
   */
  key: string;
  /** The single From mailbox, lowercased; null when the From field is missing or malformed. */
  from: { address: string; name: string } | null;
  /** The sender's Message-ID and the thread it answers, for a reply that stays in its thread. */
  messageId: string | null;
  references: string[];
  /**
   * A DKIM signature that passed, was made by the From address's own domain and covers the one
   * From, To, Cc and Subject field, so that domain vouches for the sender, recipients and subject.
   */
  authenticated: boolean;
  /** Why it isn't authenticated, for logs; null when it is. */
  unauthenticatedReason: string | null;
  /** Not authenticated only because a DKIM key lookup failed for now; worth trying again later. */
  temporaryFailure: boolean;
  to: string[];
  cc: string[];
  subject: string;
  date: string | null;
  text: string;
  /** Auto-replies, bulk and mailing-list mail, which nothing should act on (RFC 3834). */
  automated: boolean;
  attachments: Array<{ name: string; mimeType: string; bytes: Uint8Array }>;
};

export type ReadInboundEmailOptions = {
  resolver?: InboundEmailResolver;
};

/** Parse a raw RFC 5322 message and check its DKIM signatures. */
export async function readInboundEmail(
  raw: Uint8Array,
  options: ReadInboundEmailOptions = {},
): Promise<InboundEmail> {
  // Loaded only on servers that receive email.
  const [{ default: PostalMime }, { dkimVerify }] = await Promise.all([
    import("postal-mime"),
    import("mailauth"),
  ]);
  const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  // Far below the parser's own defaults: real mail has a handful of parts, and anything past
  // these limits is rejected as unreadable instead of costing a worker its time.
  const email = await PostalMime.parse(buffer, {
    attachmentEncoding: "arraybuffer",
    maxPartCount: 200,
    maxNestingDepth: 20,
  });
  // Each signature costs a DNS lookup; real mail carries one or two, so more is not verified.
  const signatures = email.headerLines.filter((line) => line.key === "dkim-signature").length;
  const dkim =
    signatures <= INBOUND_EMAIL_MAX_SIGNATURES
      ? await dkimVerify(buffer, options.resolver ? { resolver: options.resolver } : {})
      : null;

  const fieldCount = (name: string) => email.headerLines.filter((line) => line.key === name).length;
  const values = (name: string) =>
    email.headers
      .filter((line) => line.key === name)
      .map((line) => line.value.split(";")[0]?.trim().toLowerCase() ?? "");

  const fromAddress =
    dkim && dkim.fromFields === 1 && dkim.fromSyntax === "valid" && dkim.headerFrom.length === 1
      ? (dkim.headerFrom[0]?.toLowerCase() ?? null)
      : null;
  // Mail with too many signatures is never checked; its sender is still shown, as unverified.
  const parsedFrom =
    fieldCount("from") === 1 && email.from && !email.from.group
      ? email.from.address?.trim().toLowerCase() || null
      : null;
  const sender = fromAddress ?? (dkim ? null : parsedFrom);
  const to = addresses(email.to);
  const cc = addresses(email.cc);
  // An extra To, Cc or Subject added above the signed one would be read but not verified.
  const singleFields = fieldCount("to") <= 1 && fieldCount("cc") <= 1 && fieldCount("subject") <= 1;
  const fromDomain = fromAddress?.slice(fromAddress.lastIndexOf("@") + 1);
  const fromDomainPasses = (dkim?.results ?? []).filter(
    (result) =>
      result.status.result === "pass" &&
      // Exactly the From domain: a subdomain (often run by a sending service) would align too.
      result.signingDomain?.toLowerCase() === fromDomain &&
      // l= leaves trailing body bytes unsigned; anything could be appended there.
      (result.status.underSized ?? 0) === 0 &&
      result.signatureTimeValid !== false,
  );
  const signedFields = (result: (typeof fromDomainPasses)[number]) =>
    new Set((result.signingHeaders?.keys ?? "").split(":").map((key) => key.trim().toLowerCase()));
  const candidates =
    fromAddress === null || !singleFields
      ? []
      : fromDomainPasses.filter((result) => {
          const signed = signedFields(result);
          // The owner's mail is taken as instructions, subject included.
          return signed.has("from") && (fieldCount("subject") === 0 || signed.has("subject"));
        });
  const fullySigned = candidates.find((result) => {
    const signed = signedFields(result);
    return (
      (fieldCount("to") === 0 || signed.has("to")) && (fieldCount("cc") === 0 || signed.has("cc"))
    );
  });
  const signature = fullySigned;
  const unauthenticatedReason = signature
    ? null
    : !dkim
      ? "too many signatures"
      : fromAddress === null
        ? "no single valid From"
        : !singleFields
          ? "repeated To, Cc or Subject"
          : fromDomainPasses.length === 0
            ? "no valid signature from the sender's domain"
            : "signature leaves out required headers";

  // Every copy of a header counts, so an extra "Auto-Submitted: no" cannot hide an auto-reply.
  const automated =
    values("auto-submitted").some((value) => value !== "no") ||
    values("precedence").some((value) => ["bulk", "junk", "list"].includes(value)) ||
    fieldCount("list-id") > 0;

  // A huge HTML part is cut first: the bot only ever sees the first INBOUND_EMAIL_TEXT_MAX_CHARS
  // of its text.
  const body =
    email.text?.trim() ||
    (email.html ? htmlToPlainText(email.html.slice(0, INBOUND_EMAIL_TEXT_MAX_CHARS * 10)) : "");
  const text =
    body.length > INBOUND_EMAIL_TEXT_MAX_CHARS
      ? `${sliceWellFormed(body, INBOUND_EMAIL_TEXT_MAX_CHARS)}\n[…]`
      : body;
  const fromName =
    email.from && !email.from.group && email.from.address?.trim().toLowerCase() === sender
      ? email.from.name
      : "";

  const attachments = email.attachments
    // Inline parts are images an HTML body shows, such as signature logos.
    .filter((attachment) => !attachment.related)
    .map((attachment) => ({
      name: attachment.filename?.trim() || "attachment",
      mimeType: attachment.mimeType,
      bytes:
        typeof attachment.content === "string"
          ? new TextEncoder().encode(attachment.content)
          : new Uint8Array(attachment.content),
    }));

  return {
    // Anyone can reuse an unsigned message's Message-ID, so its key is its content: a different
    // message under the same ID is a different message, and a relay's retry is the same one.
    key: signature?.id
      ? `dkim:${signature.id}`
      : `sha256:${createHash("sha256")
          .update(
            JSON.stringify([
              email.messageId ?? "",
              sender,
              to,
              cc,
              email.subject ?? "",
              email.date ?? "",
              text,
              attachments.map((file) => [
                file.name,
                createHash("sha256").update(file.bytes).digest("base64url"),
              ]),
            ]),
          )
          .digest("base64url")}`,
    from: sender ? { address: sender, name: fromName } : null,
    messageId: messageIds(email.messageId)[0] ?? null,
    references: [
      ...new Set([...messageIds(email.references), ...messageIds(email.inReplyTo)]),
    ].slice(-MAX_REFERENCES),
    authenticated: signature !== undefined,
    unauthenticatedReason,
    // Only the From domain's own signature decides; another domain's slow DNS changes nothing.
    temporaryFailure:
      signature === undefined &&
      fromDomain !== undefined &&
      (dkim?.results ?? []).some(
        (result) =>
          result.status.result === "temperror" &&
          result.signingDomain?.toLowerCase() === fromDomain,
      ),
    to,
    cc,
    subject: email.subject?.trim() ?? "",
    // Date is not always signed, so cut it like any other unverified header.
    date: email.date?.slice(0, 100) ?? null,
    text,
    automated,
    attachments,
  };
}

/** References kept per message; a long thread's oldest ones add nothing to a reply. */
const MAX_REFERENCES = 20;

/** The `<id@host>` tokens in a Message-ID, In-Reply-To or References field. */
function messageIds(value: string | undefined): string[] {
  // The newest come last in References, so a long thread keeps those.
  return (value?.match(/<[^<>\s]{1,250}>/g) ?? []).slice(-100);
}

function addresses(list: Address[] | undefined): string[] {
  return (list ?? [])
    .flatMap((entry) => (entry.group ? entry.group : [entry]))
    .map((mailbox) => mailbox.address.trim().toLowerCase())
    .filter(Boolean);
}
