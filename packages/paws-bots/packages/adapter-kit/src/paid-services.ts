import type { AdapterContext } from "./types.js";

export type PaidServiceParam = {
  type?: string;
  required?: boolean;
  note?: string;
  example?: unknown;
};

/** Where each argument goes: the URL query (path parameters included) or the JSON body. */
export type PaidServiceParams = {
  query?: Record<string, PaidServiceParam>;
  body?: Record<string, PaidServiceParam>;
};

export type PaidService = {
  id: string;
  name: string;
  description: string;
  /** Estimated provider price of one call in USD, before any markup. Null when unknown. */
  priceUsd: number | null;
  /** Whether the price scales with the request, such as per returned row. */
  priceVaries: boolean;
  method: "GET" | "POST";
  params: PaidServiceParams;
};

export type PaidServiceInput = {
  query?: Record<string, string | number | boolean>;
  body?: unknown;
};

export type PaidServiceCallOptions = {
  /** The same key replays the stored answer without paying again. */
  idempotencyKey: string;
  /** Who the spend belongs to, for the provider's own per-customer records. */
  customer: string;
  /** The provider refuses, unbilled, a call whose reservation would cost more. */
  maxCostUsd: number;
};

/**
 * `answered` is the service's own reply, success or error, with what it cost. `refused` was
 * stopped before any charge. Anything else (a timeout, a dropped connection) throws: the call may
 * have run and been billed.
 */
export type PaidServiceCallResult =
  | {
      outcome: "answered";
      ok: boolean;
      status: number;
      data: unknown;
      costUsd: number;
      providerCallId?: string;
    }
  | {
      outcome: "refused";
      reason: "over_max_cost" | "invalid_input" | "unavailable";
      /** Safe to show the agent: never account balances or billing links. */
      message?: string;
    };

/** Deployment-paid lookups (search results, places, contacts, profiles) behind one account. */
export interface PaidServiceProvider {
  readonly id: string;
  search(query: string, context: AdapterContext): Promise<PaidService[]>;
  /** Null when the service does not exist or cannot be called through this deployment. */
  describe(serviceId: string, context: AdapterContext): Promise<PaidService | null>;
  call(
    service: PaidService,
    input: PaidServiceInput,
    options: PaidServiceCallOptions,
    context: AdapterContext,
  ): Promise<PaidServiceCallResult>;
}
