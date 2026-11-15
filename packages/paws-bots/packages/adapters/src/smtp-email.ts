import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { EmailRecipientRejectedError } from "@rakazo/adapter-kit";
import type { NodemailerError, Transporter } from "nodemailer";
import nodemailer from "nodemailer";

/**
 * Nodemailer waits up to 2 minutes to connect and 10 minutes on an idle socket,
 * and sign-up awaits the verification email. `SMTP_URL` query parameters win.
 */
const SMTP_TIMEOUTS_MS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
};
/** Timeouts that can only fire before the message is handed to the server. */
const SETUP_TIMEOUTS = new Set<NodemailerError["timeoutType"]>([
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
]);
/** Socket errors that only `connect()` raises, so no message was sent yet. */
const CONNECT_ERRNOS = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

export interface SmtpEmailConfig {
  url: string;
  from: string;
  replyTo?: string;
}

interface SmtpEmailDependencies {
  transport?: Transporter;
  createTransport?: (url: string) => Transporter;
  retryDelaysMs?: readonly number[];
  drainTimeoutMs?: number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

/** SMTP delivery works with SES, Resend, and self-hosted mail servers. */
export class SmtpEmailProvider implements TransactionalEmailProvider {
  private readonly transport: Transporter;
  private readonly retryDelaysMs: readonly number[];
  private readonly drainTimeoutMs: number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  private accepting = true;
  private draining?: Promise<void>;

  constructor(
    private readonly config: SmtpEmailConfig,
    dependencies: SmtpEmailDependencies = {},
  ) {
    const secureUrl = secureSmtpUrl(config.url);
    const protocol = safeProtocol(secureUrl);
    if (protocol !== "smtp:" && protocol !== "smtps:") {
      throw new Error("SMTP_URL must use smtp:// or smtps://");
    }
    if (!config.from.trim()) throw new Error("EMAIL_FROM is required when SMTP_URL is configured");
    this.transport =
      dependencies.transport ??
      (dependencies.createTransport ?? nodemailer.createTransport)(secureUrl);
    this.retryDelaysMs = dependencies.retryDelaysMs ?? [250, 1_000];
    this.drainTimeoutMs = dependencies.drainTimeoutMs ?? 10_000;
    this.sleep = dependencies.sleep ?? wait;
  }

  describe() {
    return {
      id: "smtp",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { transactional: true },
    };
  }

  send(message: TransactionalEmail): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error("SMTP provider is shutting down"));
    const delivery = this.deliver(message);
    this.inFlight.add(delivery);
    void delivery.then(
      () => this.inFlight.delete(delivery),
      () => this.inFlight.delete(delivery),
    );
    return delivery;
  }

  drain(): Promise<void> {
    this.accepting = false;
    this.draining ??= this.finishDrain();
    return this.draining;
  }

  private async finishDrain(): Promise<void> {
    try {
      const deadline = Date.now() + this.drainTimeoutMs;
      while (this.inFlight.size > 0) {
        const completed = await settlesWithin(this.inFlight, Math.max(0, deadline - Date.now()));
        if (completed) continue;
        this.shutdown.abort();
        this.inFlight.clear();
        return;
      }
    } finally {
      try {
        this.transport.close();
      } catch {
        // Cleanup must continue even when the transport cannot close cleanly.
      }
    }
  }

  private async deliver(message: TransactionalEmail): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.shutdown.signal.aborted) {
        throw new Error("SMTP delivery stopped during shutdown");
      }
      try {
        await this.transport.sendMail({
          from: message.from ?? this.config.from,
          to: message.to,
          ...(message.cc?.length ? { cc: message.cc } : {}),
          subject: message.subject,
          text: message.text,
          html: message.html,
          replyTo: message.replyTo ?? this.config.replyTo,
          headers: message.headers,
        });
        return;
      } catch (error) {
        if (this.shutdown.signal.aborted) throw error;
        const refused = refusedRecipientCode(error);
        if (refused) {
          throw new EmailRecipientRejectedError(`SMTP server rejected the recipient (${refused})`);
        }
        const retryDelay = this.retryDelaysMs[attempt];
        if (retryDelay === undefined || !retrySafe(error)) throw error;
        await this.sleep(retryDelay, this.shutdown.signal);
      }
    }
  }
}

function secureSmtpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  const parameters = new Map(
    [...parsed.searchParams].map(([key, setting]) => [key.toLowerCase(), setting.toLowerCase()]),
  );
  if (
    parameters.get("ignoretls") === "true" ||
    parameters.get("requiretls") === "false" ||
    parameters.get("tls.rejectunauthorized") === "false" ||
    (parsed.protocol === "smtps:" && parameters.get("secure") === "false")
  ) {
    throw new Error("SMTP_URL cannot disable TLS or certificate verification");
  }
  if (parsed.protocol === "smtp:") parsed.searchParams.set("requireTLS", "true");
  for (const [key, timeoutMs] of Object.entries(SMTP_TIMEOUTS_MS)) {
    if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, String(timeoutMs));
  }
  return parsed.href;
}

/**
 * Retries a temporary 4xx rejection, or a connection that failed before the
 * message could have been sent. A drop after DATA may already have delivered it,
 * so it is not sent twice.
 */
function retrySafe(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, responseCode, timeoutType, originalCode } = error as NodemailerError;
  if (responseCode) return responseCode >= 400 && responseCode < 500;
  if (code === "ETIMEDOUT") return SETUP_TIMEOUTS.has(timeoutType);
  if (code === "ECONNECTION" || code === "ESOCKET") {
    return CONNECT_ERRNOS.has(originalCode ?? "");
  }
  return false;
}

/** The permanent reply code when the server refused a recipient address, before any data. */
function refusedRecipientCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, command, responseCode } = error as NodemailerError;
  if (code !== "EENVELOPE" || command !== "RCPT TO") return undefined;
  return responseCode && responseCode >= 500 ? responseCode : undefined;
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("SMTP delivery stopped during shutdown"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("SMTP delivery stopped during shutdown"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function settlesWithin(
  promises: Iterable<Promise<void>>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled([...promises]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeProtocol(value: string): string | undefined {
  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}
