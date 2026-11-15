import * as z from "zod";
import { IsoDate } from "./ids.js";

export const PaymentWalletStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("disconnected") }),
  z.object({
    status: z.literal("connecting"),
    verificationUrl: z.string().url(),
    userCode: z.string(),
    expiresAt: IsoDate,
  }),
  z.object({ status: z.literal("connected"), connectedAt: IsoDate }),
]);
export type PaymentWalletStatus = z.infer<typeof PaymentWalletStatusSchema>;

function httpsUrl(message: string) {
  return z
    .string()
    .trim()
    .max(2048)
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }, message);
}

const PurchaseReason = z.string().trim().min(100).max(1000);

/** Currency amounts in the minor unit, as wallets take them. */
export const PurchaseRequestInput = z
  .object({
    merchantName: z.string().trim().min(1).max(200),
    merchantUrl: httpsUrl("Use the HTTPS page the purchase is made on"),
    /** Set when the checkout takes a pay token instead of a card. */
    merchantAccountId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]{1,128}$/, "Use the merchantAccountId the page snapshot shows")
      .optional(),
    amount: z.number().int().positive().max(100_000_000),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "Use a three-letter currency code")
      .transform((value) => value.toLowerCase()),
    reason: PurchaseReason,
  })
  .strict();
export type PurchaseRequestInput = z.infer<typeof PurchaseRequestInput>;

export const PurchaseIdInput = z.object({ id: z.string().trim().min(1).max(100) }).strict();

/** Card fields browser_act fill_card types; the bot never sees their values. */
export const PURCHASE_CARD_FIELDS = ["number", "expiry", "cvc", "postal_code"] as const;
export type PurchaseCardField = (typeof PURCHASE_CARD_FIELDS)[number];

export const PAID_REQUEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * The payment is sent as the request's credentials, and the request is stored to be sent again
 * after approval, so it may not carry credentials of its own.
 */
const REFUSED_PAID_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

const PaidRequestHeaders = z
  .record(
    z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Use plain header names"),
    z
      .string()
      .max(2048)
      .regex(/^[^\r\n]*$/, "Header values are one line"),
  )
  .refine((headers) => Object.keys(headers).length <= 20, "At most 20 headers")
  .refine(
    (headers) =>
      Object.keys(headers).every((name) => !REFUSED_PAID_REQUEST_HEADERS.has(name.toLowerCase())),
    "Credentials, cookies and connection headers can't be sent",
  );

/** A paid_request call: a new request, or the approved purchase of an earlier one. */
export const PaidRequestInput = z.union([
  z.object({ purchase: z.string().trim().min(1).max(100) }).strict(),
  z
    .object({
      url: httpsUrl("Use an HTTPS URL"),
      method: z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(z.enum(PAID_REQUEST_METHODS))
        .default("GET"),
      headers: PaidRequestHeaders.optional(),
      body: z
        .string()
        .max(64 * 1024)
        .optional(),
      reason: PurchaseReason,
    })
    .strict()
    .refine((request) => request.body === undefined || request.method !== "GET", {
      message: "A GET request has no body",
      path: ["body"],
    }),
]);
export type PaidRequestInput = z.infer<typeof PaidRequestInput>;

/**
 * Currencies a spending limit can be set in. Checkout pages name these unambiguously; a symbol
 * another currency shares ($, £) is read as these, which only over-counts the cheaper currency.
 */
export const SPENDING_CURRENCIES = ["usd", "eur", "gbp", "ils"] as const;
export type SpendingCurrency = (typeof SPENDING_CURRENCIES)[number];

/** When spending starts again from zero. `none` counts from when the limit was set. */
export const SpendingPeriodSchema = z.enum(["day", "week", "month", "none"]);
export type SpendingPeriod = z.infer<typeof SpendingPeriodSchema>;

/** The most a spending limit can be set to, in minor units. */
export const MAX_SPENDING_LIMIT = 100_000_000;

/** The most the user's bots may spend in a period, across every bot and Space. Minor units. */
export const SpendingLimitSchema = z
  .object({
    amount: z.number().int().positive().max(MAX_SPENDING_LIMIT),
    currency: z.enum(SPENDING_CURRENCIES),
    period: SpendingPeriodSchema,
  })
  .strict();
export type SpendingLimit = z.infer<typeof SpendingLimitSchema>;

export const SpendingStatusSchema = z.object({
  limit: SpendingLimitSchema.nullable(),
  /** Spent in the limit's current period, in its currency; 0 without a limit. */
  spent: z.number().int().nonnegative(),
  /** Whether the setting is relevant yet: the user can pay, or already set a limit. */
  shown: z.boolean(),
});
export type SpendingStatus = z.infer<typeof SpendingStatusSchema>;

/** A payment a bot made with the user's approval. Minor units. */
export const SpendingPaymentSchema = z.object({
  id: z.string(),
  /** The checkout's host. */
  site: z.string(),
  amount: z.number().int().positive(),
  currency: z.string(),
  /** Null once the bot is gone or out of the user's reach. */
  botName: z.string().nullable(),
  createdAt: IsoDate,
});
export type SpendingPayment = z.infer<typeof SpendingPaymentSchema>;
