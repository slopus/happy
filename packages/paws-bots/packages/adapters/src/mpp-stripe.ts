import type { HttpPaymentChallenge } from "@rakazo/adapter-kit";
import { PaymentWalletRequestRejected } from "@rakazo/adapter-kit";
import type * as Mppx from "mppx";

type Challenge = Mppx.Challenge.Challenge;

let loaded: Promise<typeof Mppx> | undefined;
const mppx = () => (loaded ??= import("mppx"));

export type StripeChargeChallenge = HttpPaymentChallenge & { networkId: string };

/**
 * The Stripe charge in a Machine Payments Protocol `WWW-Authenticate` value, or null. Other
 * methods are never paid, and neither is a challenge that wants its credential in another header.
 */
export async function readStripeChargeChallenge(
  wwwAuthenticate: string,
): Promise<StripeChargeChallenge | null> {
  const { Challenge } = await mppx();
  const challenge = await findStripeCharge(wwwAuthenticate);
  if (!challenge) return null;
  const terms = chargeTerms(challenge.request);
  return terms ? { challenge: Challenge.serialize(challenge), ...terms } : null;
}

export async function stripeChargeTerms(serialized: string): Promise<StripeChargeChallenge> {
  const challenge = await readStripeChargeChallenge(serialized);
  if (!challenge) throw new PaymentWalletRequestRejected("This payment request can't be paid.");
  return challenge;
}

/**
 * The `Authorization` value that pays the challenge a retried request was answered with, as
 * `link-cli mpp pay` builds it. A challenge whose terms changed since approval is refused.
 */
export async function stripeChargeAuthorization(
  approved: string,
  wwwAuthenticate: string,
  sharedPaymentToken: string,
): Promise<string> {
  const { Challenge, Credential } = await mppx();
  const fresh = await findStripeCharge(wwwAuthenticate);
  const pinned = await findStripeCharge(approved);
  const comparable = (challenge: Challenge) =>
    Challenge.serialize({ ...challenge, id: "approval-comparison", expires: undefined });
  if (!fresh || !pinned || comparable(fresh) !== comparable(pinned)) {
    throw new PaymentWalletRequestRejected(
      "The payment request changed after approval, so it was not paid. Request it again.",
    );
  }
  const externalId = fresh.request.externalId;
  return Credential.serialize({
    challenge: fresh,
    payload: {
      spt: sharedPaymentToken,
      ...(typeof externalId === "string" ? { externalId } : {}),
    },
  });
}

async function findStripeCharge(wwwAuthenticate: string): Promise<Challenge | undefined> {
  const { Challenge } = await mppx();
  let challenges: Challenge[];
  try {
    challenges = Challenge.deserializeList(wwwAuthenticate);
  } catch {
    return undefined;
  }
  return challenges.find(
    (challenge) =>
      challenge.method === "stripe" &&
      challenge.intent === "charge" &&
      (challenge.header === undefined || challenge.header.toLowerCase() === "authorization") &&
      chargeTerms(challenge.request) !== null,
  );
}

function chargeTerms(
  request: Record<string, unknown>,
): Omit<StripeChargeChallenge, "challenge"> | null {
  const details = request.methodDetails;
  const networkId =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>).networkId
      : request.networkId;
  const { amount, currency } = request;
  if (
    typeof amount !== "string" ||
    !/^[1-9]\d{0,11}$/.test(amount) ||
    typeof currency !== "string" ||
    !/^[A-Za-z]{3}$/.test(currency) ||
    typeof networkId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(networkId)
  ) {
    return null;
  }
  return { amount: Number(amount), currency: currency.toLowerCase(), networkId };
}
