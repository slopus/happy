import type {
  AdapterContext,
  PaidService,
  PaidServiceCallOptions,
  PaidServiceCallResult,
  PaidServiceInput,
  PaidServiceParam,
  PaidServiceProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { asRecord, readBoundedText } from "./connector-http.js";

const SEARCH_LIMIT = 25;
const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,299}$/;
const CATALOG_MAX_BYTES = 1_000_000;
const ANSWER_MAX_BYTES = 2_000_000;
const ROUTING_MAX_DEPTH = 20;
/** Catalog text reaches the bot's context, so one parameter cannot take much of it. */
const PARAM_TEXT_MAX_CHARS = 300;
/** Treg names its routed jobs `treg.<job>`; the agent sees `auto.<job>`. */
const ROUTED_PREFIX = "treg.";
const PUBLIC_ROUTED_PREFIX = "auto.";
const ACCOUNT_ERROR_CODES = new Set(["insufficient_balance", "platform_daily_cap_reached"]);
/** Generation runs as a billed background task; the deployment media tools cover it. */
const GENERATION_PLATFORMS = new Set(["image-gen", "video-gen", "voice-gen", "music-gen"]);

const paramSpec = z
  .object({
    type: z.string().optional(),
    required: z.boolean().optional(),
    note: z.string().optional(),
    example: z.unknown().optional(),
  })
  .passthrough();
const paramMap = z.record(z.string(), paramSpec).nullish();
const endpoint = z
  .object({
    id: z.string().regex(SERVICE_ID),
    name: z.string().default(""),
    summary: z.string().nullish(),
    kind: z.string().nullish(),
    scope: z.string().nullish(),
    method: z.string().default("GET"),
    platform: z.string().nullish(),
    platform_eligible: z.boolean().nullish(),
    platform_blocked: z.unknown().nullish(),
    async: z.unknown().nullish(),
    capability_description: z.string().nullish(),
    cost: z
      .object({
        usd: z.number().nullish(),
        type: z.string().nullish(),
        varies: z.boolean().nullish(),
      })
      .passthrough()
      .nullish(),
    input: z
      .object({
        queryParams: paramMap,
        pathParams: paramMap,
        body: paramMap,
        bodyType: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
type Endpoint = z.infer<typeof endpoint>;

/** Treg's own name stays inside this adapter; text the agent reads names the job instead. */
function neutral(text: string): string {
  return text.replace(/\btreg\b/gi, "the service");
}

function neutralJson(value: unknown): unknown {
  return JSON.parse(neutral(JSON.stringify(value)));
}

function callable(item: Endpoint): boolean {
  const method = item.method.toUpperCase();
  return (
    (item.kind === "routed" ||
      (item.kind === "data" && !item.id.startsWith(PUBLIC_ROUTED_PREFIX))) &&
    (item.scope === "" || item.scope === "any_account") &&
    item.platform_eligible !== false &&
    !item.platform_blocked &&
    !item.async &&
    !GENERATION_PLATFORMS.has(item.platform ?? "") &&
    (method === "GET" || method === "POST")
  );
}

function publicId(id: string): string {
  return id.startsWith(ROUTED_PREFIX) ? PUBLIC_ROUTED_PREFIX + id.slice(ROUTED_PREFIX.length) : id;
}

function providerId(id: string): string {
  return id.startsWith(PUBLIC_ROUTED_PREFIX)
    ? ROUTED_PREFIX + id.slice(PUBLIC_ROUTED_PREFIX.length)
    : id;
}

function params(
  map: Record<string, z.infer<typeof paramSpec>> | null | undefined,
): Record<string, PaidServiceParam> | undefined {
  if (!map) return undefined;
  const entries = Object.entries(map).map(([name, spec]): [string, PaidServiceParam] => [
    name,
    {
      ...(spec.type ? { type: spec.type.slice(0, 40) } : {}),
      ...(spec.required ? { required: true } : {}),
      ...(spec.note ? { note: neutral(spec.note).slice(0, PARAM_TEXT_MAX_CHARS) } : {}),
      ...(spec.example !== undefined &&
      (JSON.stringify(spec.example)?.length ?? 0) <= PARAM_TEXT_MAX_CHARS
        ? { example: spec.example }
        : {}),
    },
  ]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function toService(item: Endpoint): PaidService {
  const routed = item.kind === "routed";
  const name = routed ? (item.capability_description ?? item.name) : item.name;
  const query = { ...params(item.input?.pathParams), ...params(item.input?.queryParams) };
  const body = params(item.input?.body);
  const price = item.cost?.usd;
  return {
    id: publicId(item.id),
    name: neutral(name).slice(0, 200),
    description: neutral(
      routed
        ? `${item.summary ?? ""} Tries several providers until one answers.`.trim()
        : (item.summary ?? ""),
    ).slice(0, 500),
    priceUsd: typeof price === "number" && Number.isFinite(price) && price >= 0 ? price : null,
    priceVaries: routed || item.cost?.varies === true || item.cost?.type === "per_result",
    method: item.method.toUpperCase() === "POST" ? "POST" : "GET",
    params: {
      ...(Object.keys(query).length ? { query } : {}),
      ...(body ? { body } : {}),
    },
  };
}

function micros(value: unknown): number | undefined {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Routed answers carry the provider's raw reply twice; keep the normalized one. Their routing
 * notes keep advice and match checks but drop the provider's charge: the caller reports the price.
 */
function answerData(data: unknown): unknown {
  const record = asRecord(data);
  if (!record || !("output" in record) || !("_treg" in record)) return data;
  const { _treg: routing, raw: _raw, ...rest } = record;
  return { ...rest, routing: neutralJson(withoutCharges(routing ?? {})) };
}

function withoutCharges(value: unknown, depth = 0): unknown {
  if (depth > ROUTING_MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((item) => withoutCharges(item, depth + 1));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !/micro|cost|price|usd|charge/i.test(key))
      .map(([key, item]) => [key, withoutCharges(item, depth + 1)]),
  );
}

function customerTag(customer: string): string {
  return customer.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128) || "unknown";
}

/** Treg's HTTP catalog and call relay, paid from one deployment account. */
export class TregPaidServiceProvider implements PaidServiceProvider {
  readonly id = "treg";
  private readonly baseUrl: string;
  constructor(
    private readonly options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch },
  ) {
    const url = new URL(options.baseUrl ?? "https://treg.to");
    if (
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      ) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid paid services base URL");
    this.baseUrl = url.href.replace(/\/$/, "");
  }

  private async catalog(path: string, context: AdapterContext): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]),
      redirect: "error",
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Paid service catalog answered ${response.status}`);
    }
    const { text, truncated } = await readBoundedText(response, CATALOG_MAX_BYTES);
    if (truncated) throw new Error("Paid service catalog answer is too large");
    return JSON.parse(text);
  }

  async search(query: string, context: AdapterContext): Promise<PaidService[]> {
    const params = new URLSearchParams({ q: query, limit: String(SEARCH_LIMIT) });
    const found = z
      .object({ results: z.array(z.unknown()).default([]) })
      .passthrough()
      .parse(await this.catalog(`/catalog/search?${params}`, context));
    return found.results.flatMap((raw) => {
      const parsed = endpoint.safeParse(raw);
      return parsed.success && callable(parsed.data) ? [toService(parsed.data)] : [];
    });
  }

  async describe(serviceId: string, context: AdapterContext): Promise<PaidService | null> {
    const id = providerId(serviceId);
    if (!SERVICE_ID.test(id)) return null;
    const found = await this.catalog(`/catalog/endpoints/${encodeURIComponent(id)}`, context);
    const parsed = endpoint.safeParse(asRecord(found)?.endpoint);
    if (!parsed.success || parsed.data.id !== id || !callable(parsed.data)) return null;
    return toService(parsed.data);
  }

  async call(
    service: PaidService,
    input: PaidServiceInput,
    options: PaidServiceCallOptions,
    context: AdapterContext,
  ): Promise<PaidServiceCallResult> {
    const url = new URL(`${this.baseUrl}/call/${encodeURIComponent(providerId(service.id))}`);
    for (const [key, value] of Object.entries(input.query ?? {}))
      url.searchParams.set(key, String(value));
    const post = service.method === "POST";
    const response = await (this.options.fetch ?? fetch)(url.href, {
      method: service.method,
      headers: {
        "X-Treg-Token": this.options.apiKey,
        "X-Treg-Meta": `customer=${customerTag(options.customer)}`,
        "X-Treg-Route-Max-Cost": options.maxCostUsd.toFixed(6),
        "Idempotency-Key": options.idempotencyKey,
        Accept: "application/json",
        ...(post ? { "Content-Type": "application/json" } : {}),
      },
      body: post ? JSON.stringify(input.body ?? {}) : undefined,
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]),
      redirect: "error",
    });
    const { text, truncated } = await readBoundedText(response, ANSWER_MAX_BYTES);
    const body = truncated ? undefined : parseBody(text);
    const error = asRecord(body);
    const code = typeof error?.error === "string" ? error.error : undefined;
    const headerCost =
      micros(response.headers.get("X-Treg-Original-Cost-Micro")) ??
      micros(response.headers.get("X-Treg-Cost-Micro"));
    const providerCallId = response.headers.get("X-Treg-Call-Id") ?? undefined;
    // A routed job still running may finish and charge; the caller keeps its hold.
    if (response.status === 202) throw new Error("Paid service call is still running");
    if (code?.startsWith("idempotency"))
      throw new Error(`Paid service replay answered ${response.status}`);
    // Account-level codes are refused even without Treg's error header, so they never reach a bot.
    if (
      response.headers.get("X-Treg-Error") === "1" ||
      (code !== undefined && ACCOUNT_ERROR_CODES.has(code))
    ) {
      if (response.status === 402 && code === "route_max_cost")
        return { outcome: "refused", reason: "over_max_cost" };
      if (response.status === 502 && code === "route_failed") {
        const charged = micros(error?.charged_micro) ?? 0;
        return {
          outcome: "answered",
          ok: false,
          status: 502,
          data: { error: "No provider found an answer." },
          costUsd: (headerCost ?? charged) / 1_000_000,
          providerCallId,
        };
      }
      // An idempotent replay that is running or lost may already have been charged.
      if (response.status === 409 || response.status === 410)
        throw new Error(`Paid service replay answered ${response.status}`);
      if (headerCost)
        return {
          outcome: "answered",
          ok: false,
          status: response.status,
          data: { error: "The service could not answer." },
          costUsd: headerCost / 1_000_000,
          providerCallId,
        };
      if (
        (response.status === 400 || response.status === 422) &&
        !(code !== undefined && ACCOUNT_ERROR_CODES.has(code))
      ) {
        const message = typeof error?.message === "string" ? error.message : undefined;
        return {
          outcome: "refused",
          reason: "invalid_input",
          ...(message ? { message: neutral(message).slice(0, 500) } : {}),
        };
      }
      // Account-level refusals carry the deployment's balance and billing links.
      getLogger().warn("paid_services.refused", {
        "http.status": response.status,
        "error.code": code,
      });
      return { outcome: "refused", reason: "unavailable" };
    }
    return {
      outcome: "answered",
      ok: response.ok && !truncated,
      status: response.status,
      data: truncated ? { error: "The answer was too large to read." } : answerData(body),
      costUsd: (headerCost ?? 0) / 1_000_000,
      providerCallId,
    };
  }
}
