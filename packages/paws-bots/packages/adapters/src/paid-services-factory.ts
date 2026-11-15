import type {
  PaidService,
  PaidServiceCallResult,
  PaidServiceInput,
  PaidServiceProvider,
} from "@rakazo/adapter-kit";
import { TregPaidServiceProvider } from "./treg-paid-services.js";

const FAKE_SERVICES: PaidService[] = [
  {
    id: "maps.places",
    name: "Map places for a search",
    description: "Places a map search lists for a keyword, with address and rating.",
    priceUsd: 0.002,
    priceVaries: false,
    method: "POST",
    params: { body: { q: { type: "string", required: true } } },
  },
  {
    id: "people.email",
    name: "Find a work email",
    description: "The work email of a person at a company domain.",
    priceUsd: 0.005,
    priceVaries: false,
    method: "GET",
    params: {
      query: {
        full_name: { type: "string", required: true },
        domain: { type: "string", required: true },
      },
    },
  },
];

/** Offline catalog for tests and local demos; every call answers at its listed price. */
export class FakePaidServiceProvider implements PaidServiceProvider {
  readonly id = "fake";
  readonly calls: Array<{ service: string; input: PaidServiceInput; idempotencyKey: string }> = [];
  async search(query: string): Promise<PaidService[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return FAKE_SERVICES.filter((service) =>
      words.some((word) => `${service.name} ${service.description}`.toLowerCase().includes(word)),
    );
  }
  async describe(serviceId: string): Promise<PaidService | null> {
    return FAKE_SERVICES.find((service) => service.id === serviceId) ?? null;
  }
  async call(
    service: PaidService,
    input: PaidServiceInput,
    options: { idempotencyKey: string },
  ): Promise<PaidServiceCallResult> {
    this.calls.push({ service: service.id, input, idempotencyKey: options.idempotencyKey });
    return {
      outcome: "answered",
      ok: true,
      status: 200,
      data: { output: { service: service.id, input } },
      costUsd: service.priceUsd ?? 0,
      providerCallId: `fake-${this.calls.length}`,
    };
  }
}

export function createPaidServiceProvider(
  env: NodeJS.ProcessEnv = process.env,
): PaidServiceProvider | undefined {
  const kind = env.PAID_SERVICES_PROVIDER?.trim().toLowerCase();
  if (!kind || kind === "disabled") return undefined;
  if (kind === "fake") return new FakePaidServiceProvider();
  if (kind !== "treg") throw new Error("Unknown paid services provider");
  const apiKey = env.PAID_SERVICES_API_KEY?.trim();
  if (!apiKey) throw new Error("Paid services require an API key");
  return new TregPaidServiceProvider({
    apiKey,
    baseUrl: env.PAID_SERVICES_BASE_URL?.trim() || undefined,
  });
}
