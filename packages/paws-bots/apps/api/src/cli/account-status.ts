// `docker compose exec api node dist/cli/account-status.js deactivate|reactivate <email>`:
// turns an account off or back on, as the identity provider would over SCIM.
import {
  contentKeyProviderFromEnv,
  PostgresRealtimeFanout,
  PrismaPushTokenStore,
  UserDevices,
  unwrapEnvFromKeyManager,
  userDeviceForwardSecret,
} from "@rakazo/adapters";
import {
  createDb,
  createThreadEvents,
  installAuditEventStore,
  installSecurityEventStore,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { setAccountActive } from "../account-status.js";
import { loadEnv } from "../env.js";

const [action, address] = process.argv.slice(2);
if ((action !== "deactivate" && action !== "reactivate") || !address) {
  process.stderr.write("Usage: account-status.js deactivate|reactivate <email>\n");
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const env = loadEnv();
const { prisma, pool } = createDb(env.databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
installSecurityEventStore(prisma);
installAuditEventStore(prisma);
// Publishing only: open chats of other people hear that the account's runs stopped.
const realtime = new PostgresRealtimeFanout({
  connectionString: env.realtimeDatabaseUrl,
  publisher: pool,
});
try {
  const email = address.trim().toLowerCase();
  // As the directory looks accounts up: the exact address, else the only one differing by case.
  const user = await runAsSystem("find an account by email", async () => {
    const exact = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (exact) return exact;
    const matches = await prisma.user.findMany({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
      take: 2,
    });
    return matches.length === 1 ? matches[0] : null;
  });
  if (!user) {
    process.stderr.write("No single account has that email\n");
    process.exitCode = 1;
  } else {
    const active = action === "reactivate";
    const events = createThreadEvents(prisma, realtime);
    const outcome = await setAccountActive(
      {
        prisma,
        pushTokens: new PrismaPushTokenStore(prisma, env.encryptionKey),
        devices: {
          prisma,
          devices: new UserDevices({
            prisma,
            forwardSecret: userDeviceForwardSecret(env.encryptionKey),
          }),
        },
        events,
        // Without the API's computers and jobs: open chats hear of it now, and screens and
        // waiting follow-ups are picked up by lease expiry and the job reconciler.
        afterDeparture: async (_actor, departure) => {
          for (const { threadId, seq } of departure.events)
            await events.notify(threadId, seq).catch((error) => {
              getLogger().error("space departure realtime notification", error);
            });
        },
      },
      user.id,
      active,
      Boolean(env.scimBearerToken),
    );
    if (outcome === "directory") {
      process.stderr.write("The identity provider manages this account; turn it off or on there\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `${outcome === "changed" ? (active ? "Reactivated" : "Deactivated") : active ? "Already active" : "Already deactivated"}\n`,
      );
    }
  }
} finally {
  await realtime.close();
  await prisma.$disconnect();
  await pool.end();
}
