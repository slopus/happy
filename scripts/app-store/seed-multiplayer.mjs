import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// An App Store scenario producer, not an app patch or a team-auth implementation. The
// normal encrypted API stores fictional participant envelopes; the current
// native client renders its real SessionAuthor contract unchanged.
const [repositoryArgument, runArgument] = process.argv.slice(2);
if (!repositoryArgument || !runArgument)
    throw new Error("Use <mobile repository> <mobile gym run root>.");
const repository = resolve(repositoryArgument);
const moduleAt = (path) => import(pathToFileURL(join(repository, path)).href);
const { runOpen } = await moduleAt("packages/happy-mobile-gym/dist/index.js");
const manifest = await runOpen(resolve(runArgument));
if (manifest.repositoryRoot !== repository)
    throw new Error("The selected run belongs to another repository.");
const details = await lstat(manifest.paths.credentials);
if (!details.isFile() || (details.mode & 0o077) !== 0 || details.uid !== process.getuid())
    throw new Error("Expected private run credentials.");
const auth = JSON.parse(await readFile(manifest.paths.credentials, "utf8"));
if (typeof auth.token !== "string" || typeof auth.secret !== "string")
    throw new Error("Invalid run credentials.");
const { encryptWithDataKey, libsodiumEncryptForPublicKey } = await moduleAt(
    "packages/happy-cli/src/api/encryption.ts",
);
const { deriveKey } = await moduleAt("packages/happy-cli/src/utils/deriveKey.ts");
const { MetadataSchema } = await moduleAt("packages/happy-app/sources/sync/storageTypes.ts");
const { RawRecordSchema } = await moduleAt("packages/happy-app/sources/sync/typesRaw.ts");
const appRequire = createRequire(join(repository, "packages/happy-app/package.json"));
const sodium = appRequire("libsodium-wrappers");
await sodium.ready;
const contentSeed = await deriveKey(Buffer.from(auth.secret, "base64url"), "Happy EnCoder", [
    "content",
]);
const publicKey = sodium.crypto_box_seed_keypair(contentSeed).publicKey;
const key = randomBytes(32);
const wrappedKey = Buffer.concat([
    Buffer.from([0]),
    libsodiumEncryptForPublicKey(key, publicKey),
]).toString("base64");
const encrypt = (value) => Buffer.from(encryptWithDataKey(value, key)).toString("base64");
const post = async (path, body) => {
    const response = await fetch(`${manifest.server.url}${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Local fixture API failed: HTTP ${response.status}`);
    return await response.json();
};
const now = Date.now();
const metadata = MetadataSchema.parse({
    path: "/workspace/happy",
    host: "Team workspace",
    name: "Make the release ready",
    summary: { text: "Make the release ready", updatedAt: now },
    flavor: "codex",
    // This producer is not a running CLI. Do not impersonate a CLI version.
    os: "darwin",
});
const { session } = await post("/v1/sessions", {
    tag: `app-store-collaboration-${randomUUID()}`,
    metadata: encrypt(metadata),
    dataEncryptionKey: wrappedKey,
});
const turn = randomUUID();
const events = [
    {
        role: "user",
        author: { id: "sample-alex", name: "Alex", owner: true },
        ev: { t: "text", text: "Let's get the release ready." },
    },
    {
        role: "user",
        author: { id: "sample-maya", name: "Maya", owner: false },
        ev: { t: "text", text: "I'll review the onboarding. Happy, check the empty states too." },
    },
    { role: "agent", ev: { t: "turn-start" } },
    {
        role: "agent",
        ev: {
            t: "text",
            text: "I found two empty states that need clearer next steps. I'll update the copy and share the changes here.",
        },
    },
    { role: "agent", ev: { t: "turn-end", status: "completed" } },
    {
        role: "user",
        author: { id: "sample-jamie", name: "Jamie", owner: false },
        ev: { t: "text", text: "Keep the existing shortcuts. I'll check the desktop flow." },
    },
    { role: "agent", ev: { t: "turn-start" } },
    {
        role: "agent",
        ev: {
            t: "text",
            text: "Shortcuts stay as they are. The updated copy is ready for your review.",
        },
    },
    { role: "agent", ev: { t: "turn-end", status: "completed" } },
];
const messages = events.map((event, index) => {
    const id = randomUUID();
    const payload = RawRecordSchema.parse({
        role: "session",
        content: {
            type: "session",
            data: {
                id,
                time: now + index * 1000,
                turn: index < 6 ? turn : `${turn}-reply`,
                ...event,
            },
        },
        meta: { sentFrom: "rig" },
    });
    return { localId: id, content: encrypt(payload) };
});
await post(`/v3/sessions/${session.id}/messages`, { messages });
console.log(
    JSON.stringify({
        sessionId: session.id,
        title: metadata.name,
        fixture:
            "Fictional participant identities and conversation sent through the real encrypted API; no team-login or live-inference claim.",
    }),
);
