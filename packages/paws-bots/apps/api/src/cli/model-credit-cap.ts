// Operator control: model-credit-cap.js set <email> <total-usd> | clear|status <email>
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { createDb, modelCreditCapStatus, runAsSystem, setModelCreditCap } from "@rakazo/db";
import { loadEnv } from "../env.js";

const [action, address, dollars, ...extra] = process.argv.slice(2);
const validAmount = dollars !== undefined && /^(?:0|[1-9]\d{0,4})(?:\.\d{1,6})?$/.test(dollars);
const [whole = "0", fraction = ""] = (dollars ?? "").split(".");
const capMicros = validAmount ? BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")) : null;
if (
  !address ||
  extra.length ||
  (action !== "set" && action !== "clear" && action !== "status") ||
  (action === "set" ? capMicros === null || capMicros > 10_000_000_000n : dollars !== undefined)
) {
  process.stderr.write(
    "Usage: model-credit-cap.js set <email> <total-usd> | clear|status <email>\n",
  );
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const env = loadEnv();
const { prisma, pool } = createDb(env.databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
try {
  await runAsSystem("manage an account's model credit cap", async () => {
    const email = address.trim().toLowerCase();
    const exact = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    const matches = exact
      ? [exact]
      : await prisma.user.findMany({
          where: { email: { equals: email, mode: "insensitive" } },
          select: { id: true },
          take: 2,
        });
    const user = matches.length === 1 ? matches[0] : null;
    if (!user) throw new Error("No single account has that email");
    const status =
      action === "status"
        ? await modelCreditCapStatus(prisma, user.id)
        : await setModelCreditCap(prisma, user.id, action === "clear" ? null : capMicros);
    const usd = (micros: bigint) => `$${(Number(micros) / 1_000_000).toFixed(6)}`;
    process.stdout.write(
      `Cap: ${status.capMicros === null ? "none" : usd(status.capMicros)}\nRecorded committed (including holds): ${usd(status.committedMicros)}\nRemaining: ${status.remainingMicros === null ? "unlimited by cap" : usd(status.remainingMicros)}\nUsage before per-user credit journaling is excluded.\n`,
    );
  });
} finally {
  await prisma.$disconnect();
  await pool.end();
}
