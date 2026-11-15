import { providerQuotaResetAt } from "@rakazo/contracts";

/** A model call failed for a reason that should clear on its own, such as an overloaded provider. */
export class TransientModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientModelError";
  }
}

/**
 * The user's model provider rejected the key, hit a credit or usage limit, or no longer serves
 * the model. The user fixes it in their provider account or connection settings; not a server fault.
 */
export class ModelAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelAccountError";
  }
}

/**
 * The model returned nothing usable: an empty reply, a malformed tool call, or output cut off
 * by its limit. The provider and the runtime worked; another try or another model fixes it.
 */
export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

function errorFacts(value: unknown) {
  const text: string[] = [];
  const statuses = new Set<number>();
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number) => {
    if (depth > 4 || item == null) return;
    if (typeof item === "string") {
      text.push(item);
      return;
    }
    if (typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    const record = item as Record<string, unknown>;
    for (const key of ["message", "errorMessage", "name", "code", "type"]) {
      if (typeof record[key] === "string") text.push(record[key] as string);
    }
    for (const key of ["status", "statusCode", "httpStatus"]) {
      if (typeof record[key] === "number") statuses.add(record[key] as number);
    }
    for (const key of ["response", "cause", "details", "diagnostics", "data", "error"]) {
      visit(record[key], depth + 1);
    }
    if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
  };
  visit(value, 0);
  for (const detail of text) {
    for (const match of detail.matchAll(
      /(?:\b(?:http(?:\s+status(?:\s+code)?)?|status(?:\s+code)?|error\s+code)\s*[:=]?\s*|\bapi error\s*\(\s*|^\s*)([45]\d{2})\b/gi,
    )) {
      statuses.add(Number(match[1]));
    }
  }
  return { text: text.join(" ").toLowerCase(), statuses };
}

/** Transport timeouts may expire before the model request's overall budget. */
export function isProviderTimeout(error: unknown): boolean {
  return /timed? out|timeout/.test(errorFacts(error).text);
}

/** An explicit statement that the account is out of credits, balance, quota or a usage window. */
const EXHAUSTION_SIGNAL =
  /insufficient[ _](?:credits?|funds|balance|quota)|(?:out of|no (?:more|remaining)) (?:credits?|balance|quota)|credits? (?:have been |are |is )?(?:exhausted|depleted|used up)|(?:credit )?balance (?:is )?(?:too )?(?:low|empty|insufficient|exhausted|depleted)|(?:low|empty|insufficient|exhausted|depleted) (?:credit )?balance|(?:purchase|buy|add) more credits|(?:exceeded|exhausted|used up) your (?:current )?quota|quota (?:exceeded|exhausted)|(?:reached|hit) your (?:[a-z0-9()-]+ ){0,4}usage limit|usage limit (?:reached|exceeded)|out of budget/;

/**
 * Terminal wording that outranks an exhaustion phrase: the request itself is invalid or
 * unauthorised, was cancelled, or the limit is a short rate window rather than the account.
 */
const NOT_EXHAUSTION =
  /not (?:yet )?(?:reached|hit)|unsupported parameter|invalid[ _](?:api[ _]key|parameter|param|input|argument|tool|schema|credential)|validation|must be|context[ _-](?:length|window)|too many tokens|model not found|bad request|unauthori[sz]ed|forbidden|access denied|permission (?:is )?(?:denied|refused|declined)|(?:expired|revoked|missing) (?:api )?(?:key|credential|token)|(?:api )?(?:key|credential|token) (?:expired|revoked|missing)|authentication (?:failed|failure|denied|expired|invalid)|abort|cancel|\bper[- ](?:second|minute)\b|\b(?:rpm|tpm)\b|concurrent/;

/**
 * Providers report an exhausted account as 400, 402 or 403 depending on the vendor. A 4xx
 * counts only when the response says so explicitly and nothing marks it as an auth, permission
 * or input failure. A 401 never counts, even when it wraps an exhaustion message.
 */
function isAccountExhaustion(text: string, statuses: ReadonlySet<number>): boolean {
  if (statuses.has(401)) return false;
  if (![400, 402, 403].some((status) => statuses.has(status))) return false;
  return EXHAUSTION_SIGNAL.test(text) && !NOT_EXHAUSTION.test(text);
}

/**
 * The provider refused the connection's own credential: a bad key, or a sign-in that was
 * revoked or expired. Retrying that connection cannot help; another connection can.
 */
export function isModelCredentialRejected(error: unknown): boolean {
  const { text, statuses } = errorFacts(error);
  if (statuses.has(401)) return true;
  return /authentication_error|invalid_api_key|invalid_grant|invalid (?:api[ -]key|credential|x-api-key)|incorrect api key|(?:expired|revoked) (?:api )?(?:key|credential|token)|(?:api )?(?:key|credential|token) (?:expired|revoked)|token (?:has been |was |is )?(?:revoked|expired|invalidated)|authentication (?:failed|failure|expired|invalid)|api key is not scoped to a workspace/.test(
    text,
  );
}

/** A provider's sign-in service answers 400 `request_failed` when it asks the client to retry. */
export function isSignInRetryRequest(error: unknown): boolean {
  return /"error"\s*:\s*"request_failed"/.test(
    error instanceof Error ? error.message : String(error),
  );
}

/** Only provider availability failures may advance the user's explicit chain. */
export function isRetryableProviderUnavailable(error: unknown): boolean {
  const { text, statuses } = errorFacts(error);
  if (statuses.has(401)) return false;
  if (isAccountExhaustion(text, statuses)) return true;
  // The provider timed out fetching a file the request links to; another attempt fetches it again.
  if (
    /\b(?:download\w*\b[^.]{0,40}\b(?:file|image|media|url)|(?:file|image|media|url)\w*\s+download\w*)\b[^.]{0,20}\btimed? ?out\b/.test(
      text,
    )
  )
    return true;
  if (statuses.has(400)) return false;
  // The ChatGPT subscription (Codex) runtime reports an exhausted usage window without a status.
  if (/you have hit your chatgpt usage limit/.test(text)) return true;
  if (
    [400, 401, 403].some((status) => statuses.has(status)) ||
    /\b(?:http(?:\s+status(?:\s+code)?)?|status(?:\s+code)?|error\s+code)\s*[:=]?\s*(?:400|401|403)\b/.test(
      text,
    )
  ) {
    return false;
  }
  if (
    /\b(abort(?:ed)?|cancel(?:lation|led|ed)?|unauthori[sz]ed|forbidden|permission(?: is)? (?:denied|refused|declined)|access denied|consent(?: is)? (?:required|denied|refused|declined|not granted)|user (?:refused|declined)|invalid api key|invalid credential|(?:expired|revoked|missing) (?:api )?(?:key|credential|token)|(?:api )?(?:key|credential|token) (?:expired|revoked|missing)|authentication (?:failed|failure|denied|expired|invalid)|authorization (?:failed|failure|denied|expired|invalid)|bad request|invalid request|invalid input|invalid argument|context length|model not found|unsupported parameter)\b/.test(
      text,
    )
  ) {
    return false;
  }
  // Fetch refused a key that is not a valid header value; the quoted key can read like anything.
  if (
    /\bheaders\.append: "[\s\S]*" is an invalid header value\.|\bcannot convert argument to a bytestring because\b/.test(
      text,
    )
  )
    return false;
  // Some providers label payment failures with a generic invalid_request_error code.
  // Their explicit balance error still means a configured backup can serve the call.
  const insufficientBalance = statuses.has(402) && /\binsufficient_balance_error\b/.test(text);
  if (
    /context[ _-](?:length|window)|too many tokens|maximum context|token limit|request too large|invalid_api_key|authentication_error|permission_error|bad_request/.test(
      text,
    ) ||
    (!insufficientBalance && /invalid_request/.test(text))
  )
    return false;
  if (statuses.has(402)) {
    return /quota|billing|credit|payment limit|insufficient (?:funds|balance)|insufficient_balance_error/.test(
      text,
    );
  }
  if (
    [408, 429].some((status) => statuses.has(status)) ||
    [...statuses].some((status) => status >= 500 && status < 600)
  )
    return true;
  if ([...statuses].some((status) => status >= 400 && status < 600)) return false;
  return /rate.?limit|too many requests|resource.?exhausted|request limit reached|quota|overload|capacity|temporarily unavailable|service unavailable|retry[- ](?:after|delay)|server[ _]error|upstream error|an error occurred while processing your request|could not complete this request\. please retry|gateway timeout|timed? out|timeout|connection (?:error|reset|refused)|network[ _]error|max retries exceeded|stream ended (?:without (?:a )?finish[_ ]reason|before \w+)|json error injected into sse stream|stream interrupted|incomplete json segment at the end|\bterminated\b|fetch failed|socket hang up|econnreset|econnrefused|etimedout|websocket closed/.test(
    text,
  );
}

/**
 * Overload, rate limit, 5xx, timeout or dropped connection. Quota, billing, auth and input
 * errors are permanent. Runtimes often expose only a message, so this reads text as well as
 * structured status fields.
 */
export function isTransientModelError(error: unknown): boolean {
  const { text, statuses } = errorFacts(error);
  // Payment required never clears during a retry.
  if (statuses.has(402)) return false;
  // An exhausted account stays exhausted; retrying the same model cannot help.
  if (isAccountExhaustion(text, statuses)) return false;
  // A limit the provider says resets hours from now will not clear during a retry.
  if (providerQuotaResetAt(text) !== undefined) return false;
  // Short rate windows can reset during a retry; subscription and billing limits cannot.
  const shortWindow =
    /\bper[- ](?:second|minute)\b|\b(?:rpm|tpm)\b|retry[- ]after[: ]+\d+(?:\.\d+)?\s*(?:seconds?|secs?|s)\b/.test(
      text,
    );
  return (
    isRetryableProviderUnavailable(error) &&
    !/insufficient_quota|exceeded your current quota|quota exhausted|(?:chatgpt|5-hour|weekly(?: \(7-day\))?|monthly) usage limit|credit balance|insufficient (?:funds|balance|credits)|out of budget/.test(
      text,
    ) &&
    // OpenAI's per-minute limits link to billing as a way to raise them.
    (shortWindow || !/billing|payment|usage limit/.test(text))
  );
}
