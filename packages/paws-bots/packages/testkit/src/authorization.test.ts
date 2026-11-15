import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ComposioConnector,
  ExpoPushProvider,
  FakeComposioClient,
  PrismaPushTokenStore,
} from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import type { appContract, Space, SpaceNavigation } from "@rakazo/contracts";
import {
  claimSpaceDeletionForMember,
  deleteClaimedSpaceForMember,
  listClaimedSpaceComputers,
  pushSessionExpiresAt,
  releaseSpaceDeletionClaim,
  renewSpaceDeletionClaim,
  runAsSystem,
  runAsTenant,
  setSpaceSettingOverride,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;
type RpcPath<T, Prefix extends string = ""> = T extends { "~orpc": unknown }
  ? Prefix
  : T extends object
    ? {
        [Key in keyof T & string]: RpcPath<T[Key], Prefix extends "" ? Key : `${Prefix}/${Key}`>;
      }[keyof T & string]
    : never;
type ProtectedRpcPath = Exclude<RpcPath<typeof appContract>, "health">;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;
let botIntroHarness: BotIntroHarness | undefined;

describeWithDatabase("API authorization and resource isolation", () => {
  let handles: AppHandles;
  let db: AppHandles["prisma"];
  let pushTokens: PrismaPushTokenStore;
  const encryptionKey = "offline-authorization-encryption-key";
  const loadPushToken = async (userId: string) => (await pushTokens.load(userId))?.token;
  let app: App;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-authz-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      encryptionKey,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      // Board procedures answer 404 before the session check while the board is off.
      ticketBoardEnabled: true,
      composio: new ComposioConnector({ client: new FakeComposioClient() }),
    });
    pushTokens = new PrismaPushTokenStore(handles.prisma, encryptionKey);
    app = handles.app;
    db = asSystem(handles.prisma);
    botIntroHarness = handles;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps another member's routine test run keys apart from a send's", async () => {
    const owner = await signup(app, `routine-keys-owner-${stamp}@rakazo.test`, "Owner");
    const peer = await signup(app, `routine-keys-peer-${stamp}@rakazo.test`, "Peer");
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const peerActor = await rpc<Actor>(app, peer, "me");
    const space = await db.space.findUniqueOrThrow({ where: { id: ownerActor.spaceId } });
    await db.member.create({
      data: {
        id: `routine-keys-member-${stamp}`,
        organizationId: space.organizationId,
        userId: peerActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const ownBot = await rpc<Bot>(app, owner, "bots/create", botInput("Own"), space.id);
    const peerBot = await rpc<Bot>(app, peer, "bots/create", botInput("Peer"), space.id);
    const own = await rpc<{ id: string }>(
      app,
      owner,
      "routines/create",
      routineInput(ownBot.id),
      space.id,
    );
    const peers = await rpc<{ id: string }>(
      app,
      peer,
      "routines/create",
      routineInput(peerBot.id),
      space.id,
    );
    const clientNonce = `routine-keys-${stamp}`;
    // The peer test-runs their own routine under the key the owner's send will use.
    await rpc(
      app,
      peer,
      "routines/testRun",
      { routineId: peers.id, clientNonce: `routine-mention:${clientNonce}:${own.id}` },
      space.id,
    );

    const sent = await rpc<{ routineRunIds: string[] }>(
      app,
      owner,
      "threads/sendWithRoutines",
      { botId: ownBot.id, clientNonce, routineIds: [own.id] },
      space.id,
    );

    expect(sent.routineRunIds).toHaveLength(1);
    expect(await db.run.findUniqueOrThrow({ where: { id: sent.routineRunIds[0] } })).toMatchObject({
      routineId: own.id,
      userId: ownerActor.userId,
    });

    // The previous release stored `routine-test:<client nonce>` as given, so the peer could write
    // a key shaped like the owner's. That run must not become the owner's receipt.
    const later = `routine-keys-legacy-${stamp}`;
    const peerThread = await db.thread.findUniqueOrThrow({ where: { botId: peerBot.id } });
    const task = await db.task.create({
      data: {
        spaceId: space.id,
        botId: peerBot.id,
        threadId: peerThread.id,
        userId: peerActor.userId,
        prompt: "Peer routine",
        status: "queued",
      },
    });
    await db.run.create({
      data: {
        spaceId: space.id,
        botId: peerBot.id,
        threadId: peerThread.id,
        taskId: task.id,
        userId: peerActor.userId,
        status: "queued",
        trigger: "routine",
        routineId: peers.id,
        clientNonce: `routine-test:${ownerActor.userId}:routine-mention:${later}:${own.id}`,
      },
    });
    const withText = await rpc<{ routineRunIds: string[]; send?: { runId: string } }>(
      app,
      owner,
      "threads/sendWithRoutines",
      { botId: ownBot.id, clientNonce: later, text: "and the notes", routineIds: [own.id] },
      space.id,
    );
    expect(withText.send).toBeDefined();
    expect(await db.message.count({ where: { clientNonce: later } })).toBe(1);
    expect(withText.routineRunIds).toHaveLength(1);
    expect(
      await db.run.findUniqueOrThrow({ where: { id: withText.routineRunIds[0] } }),
    ).toMatchObject({ routineId: own.id, userId: ownerActor.userId });
  });

  it("batches routine mentions with the same space and archive isolation as per-bot reads", async () => {
    const owner = await signup(app, `routine-mentions-owner-${stamp}@rakazo.test`, "Owner");
    const peer = await signup(app, `routine-mentions-peer-${stamp}@rakazo.test`, "Peer");
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const peerActor = await rpc<Actor>(app, peer, "me");
    const space = await db.space.findUniqueOrThrow({ where: { id: ownerActor.spaceId } });
    await db.member.deleteMany({ where: { userId: peerActor.userId } });
    await db.member.create({
      data: {
        id: `mention-member-${stamp}`,
        organizationId: space.organizationId,
        userId: peerActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const own = await rpc<Bot>(app, owner, "bots/create", botInput("Own"), space.id);
    const other = await rpc<Bot>(app, peer, "bots/create", botInput("Peer"), space.id);
    const archived = await rpc<Bot>(app, owner, "bots/create", botInput("Archived"), space.id);
    const second = await rpc<Space>(app, owner, "spaces/create", { name: "Second" });
    const cross = await rpc<Bot>(app, owner, "bots/create", botInput("Cross"), second.id);
    for (const [cookie, bot, targetSpace] of [
      [owner, own, space.id],
      [peer, other, space.id],
      [owner, archived, space.id],
      [owner, cross, second.id],
    ] as const) {
      await rpc(app, cookie, "routines/create", routineInput(bot.id), targetSpace);
    }
    await rpc(app, owner, "bots/archive", { botId: archived.id }, space.id);
    const botIds = [own.id, other.id, archived.id, cross.id, "missing-bot"];
    // Members of one space share its bots and routines; archived and other-space bots stay out.
    const ownRows = await rpc<unknown[]>(app, owner, "routines/list", { botId: own.id }, space.id);
    const peerRows = await rpc<unknown[]>(
      app,
      peer,
      "routines/list",
      { botId: other.id },
      space.id,
    );
    const shared = [
      { botId: own.id, routines: ownRows },
      { botId: other.id, routines: peerRows },
    ];
    expect(await rpc(app, owner, "routines/listForMentions", { botIds }, space.id)).toEqual(shared);
    expect(await rpc(app, peer, "routines/listForMentions", { botIds }, space.id)).toEqual(shared);
    const crossRows = await rpc<unknown[]>(
      app,
      owner,
      "routines/list",
      { botId: cross.id },
      second.id,
    );
    expect(await rpc(app, owner, "routines/listForMentions", { botIds }, second.id)).toEqual([
      { botId: cross.id, routines: crossRows },
    ]);
  });

  it("rejects unauthenticated calls to every protected RPC family", async () => {
    const calls = exhaustiveProtectedCalls([
      ["me"],
      ["deployment/get"],
      ["deployment/update", { signupsEnabled: true }],
      ["updater/status"],
      ["updater/check", {}],
      ["updater/apply", {}],
      ["models/list"],
      ["models/credentials"],
      ["models/connect", { provider: "test", apiKey: "not-a-real-key" }],
      ["models/beginOAuth", { provider: "openai-codex" }],
      ["models/submitOAuthCode", { loginId: "missing-login", code: "fake-code" }],
      ["models/completeOAuth", { loginId: "missing-login" }],
      ["models/finishOAuth", { loginId: "missing-login" }],
      ["models/cancelOAuth", { loginId: "missing-login" }],
      ["models/setDefault", { provider: "test", modelId: "test/model" }],
      ["models/forRole"],
      ["models/role"],
      ["models/setRole"],
      ["models/backups"],
      ["models/setBackups"],
      ["models/probeOpenAiCompatible"],
      ["models/probeCatalog"],
      ["models/rename"],
      ["models/disconnect"],
      ["spaces/list"],
      ["spaces/create", { name: "Nope" }],
      ["spaces/rename", { spaceId: "missing-space", name: "Nope" }],
      ["spaces/remove", { spaceId: "missing-space" }],
      ["spaces/members/list", { spaceId: "missing-space" }],
      ["spaces/members/remove", { spaceId: "missing-space", userId: "missing-user" }],
      ["spaces/members/leave", { spaceId: "missing-space" }],
      ["spaces/invites/create", { spaceId: "missing-space" }],
      ["spaces/invites/preview", { token: "missing-token" }],
      ["spaces/invites/accept", { token: "missing-token" }],
      ["spaces/invites/cancel", { spaceId: "missing-space" }],
      ["organizations/list"],
      ["organizations/create", { name: "Nope" }],
      ["organizations/rename", { organizationId: "missing-organization", name: "Nope" }],
      ["organizations/remove", { organizationId: "missing-organization" }],
      ["bots/list"],
      ["bots/listArchived"],
      ["bots/get", { botId: "missing-bot" }],
      ["bots/create", botInput("Unauthenticated")],
      ["bots/duplicate", { botId: "missing-bot" }],
      ["bots/importPreview", { files: [{ path: "SOUL.md", content: "Calm." }] }],
      [
        "bots/importCreate",
        {
          files: [{ path: "SOUL.md", content: "Calm." }],
          name: "Nope",
          selection: { instructions: [], memory: [], skills: [] },
        },
      ],
      ["bots/update", { botId: "missing-bot", name: "Nope" }],
      ["bots/archive", { botId: "missing-bot" }],
      ["bots/restore", { botId: "missing-bot" }],
      ["bots/remove", { botId: "missing-bot" }],
      ["bots/removePreview", { botId: "missing-bot" }],
      ["bots/importCreate"],
      ["bots/importSetupState"],
      ["bots/templates"],
      ["bots/createFromTemplate", { templateId: "morning-briefing", version: 1 }],
      ["bots/reorder"],
      ["bots/restoreInstructions"],
      ["bots/setComputer"],
      ["bots/rotateWebhookSecret"],
      ["bots/revealWebhookSecret", { botId: "missing-bot" }],
      ["bots/emailAddress", { botId: "missing-bot" }],
      ["bots/emailAddresses"],
      ["bots/claimEmailAddress", { botId: "missing-bot", name: "intruder" }],
      ["groups/create", { name: "Nope", botIds: ["missing-a", "missing-b"] }],
      ["groups/list"],
      ["groups/get", { groupId: "missing-group" }],
      ["groups/update", { groupId: "missing-group", name: "Nope" }],
      ["groups/remove", { groupId: "missing-group" }],
      ["groups/listArchived"],
      ["groups/duplicate"],
      ["groups/archive"],
      ["groups/restore"],
      ["botSections/list"],
      ["botSections/create", { botId: "missing-bot", name: "Planning" }],
      ["botSections/update", { sectionId: "missing-section", name: "Planning" }],
      ["botSections/remove", { sectionId: "missing-section" }],
      ["threads/get", { botId: "missing-bot" }],
      ["threads/get", { groupId: "missing-group" }],
      ["threads/messages", { botId: "missing-bot", before: 1 }],
      ["threads/subscribe", { botId: "missing-bot", cursor: -1 }],
      ["threads/send", { botId: "missing-bot", text: "Nope" }],
      ["threads/send", { groupId: "missing-group", text: "Nope" }],
      [
        "threads/sendWithRoutines",
        { botId: "missing-bot", clientNonce: "nope", routineIds: ["missing-routine"] },
      ],
      ["threads/stop", { botId: "missing-bot" }],
      ["threads/stopHelper", { botId: "missing-bot", messageId: "missing-message" }],
      ["threads/clear", { botId: "missing-bot" }],
      ["threads/followUp", { botId: "missing-bot", text: "Nope" }],
      [
        "threads/answer",
        {
          botId: "missing-bot",
          runId: "missing-run",
          messageId: "missing-message",
          answer: "Nope",
        },
      ],
      ["threads/markRead", { botId: "missing-bot" }],
      ["threads/markUnread", { botId: "missing-bot" }],
      ["threads/snooze", { botId: "missing-bot", until: null }],
      ["threads/head"],
      ["threads/react"],
      ["threads/endCall"],
      ["threads/answerCall"],
      ["threads/declineCall"],
      ["threads/answer"],
      ["computer/status", { botId: "missing-bot" }],
      ["computer/boot", { botId: "missing-bot" }],
      ["computer/stop", { botId: "missing-bot" }],
      ["computer/takeover", { botId: "missing-bot" }],
      ["computer/release", { botId: "missing-bot" }],
      ["computer/input", { botId: "missing-bot", kind: "key", payload: { key: "A" } }],
      ["computer/files", { botId: "missing-bot", path: "/" }],
      ["computer/readFile", { botId: "missing-bot", path: "MEMORY.md" }],
      ["computer/screenUrl", { botId: "missing-bot" }],
      ["computer/preview", { botId: "missing-bot" }],
      ["computer/heartbeat", { botId: "missing-bot" }],
      ["computer/recover"],
      ["computer/reset"],
      ["computer/update"],
      ["computer/updates"],
      ["computer/releaseInterrupted"],
      ["computer/dismissUpdate"],
      ["computer/dismissDiskWarning", { botId: "missing-bot" }],
      ["computer/downloadFile"],
      ["computer/uploadFile"],
      ["computer/terminalUrl"],
      ["computer/commands"],
      ["computerProvider/get"],
      ["computerProvider/update", { provider: "default" }],
      ["computerProvider/account/get"],
      ["computerProvider/account/update", { provider: "default" }],
      ["memory/list", {}],
      ["memory/budget", { botId: "missing-bot" }],
      ["memory/update", { documentId: "missing-memory", content: "Nope" }],
      ["memory/exportMarkdown", {}],
      ["memory/remove"],
      ["memory/providerConfig"],
      ["memory/connectProvider"],
      ["memory/setDefaultScope"],
      ["memory/disconnectProvider"],
      ["routines/list", { botId: "missing-bot" }],
      ["routines/listForMentions", { botIds: ["missing-bot"] }],
      ["routines/create", routineInput("missing-bot")],
      ["routines/update", { routineId: "missing-routine", name: "Nope" }],
      ["routines/remove", { routineId: "missing-routine" }],
      ["routines/testRun", { routineId: "missing-routine" }],
      ["routines/history"],
      ["scratchpad/list", { botId: "missing-bot" }],
      ["scratchpad/create", { botId: "missing-bot", title: "Nope" }],
      ["scratchpad/update", { itemId: "missing-item", title: "Nope" }],
      ["scratchpad/remove", { itemId: "missing-item" }],
      ["skills/list", { botId: "missing-bot" }],
      ["skills/get", { skillId: "missing-skill" }],
      ["skills/start", { botId: "missing-bot", goal: "Demonstrate export" }],
      [
        "skills/appendEvent",
        {
          skillId: "missing-skill",
          event: { at: new Date().toISOString(), kind: "key", key: "a" },
        },
      ],
      ["skills/snapshot", { skillId: "missing-skill" }],
      ["skills/stop", { skillId: "missing-skill" }],
      ["skills/updateDraft", { skillId: "missing-skill", playbook: skillPlaybookInput() }],
      ["skills/save", { skillId: "missing-skill" }],
      ["skills/testRun", { skillId: "missing-skill" }],
      ["skills/remove", { skillId: "missing-skill" }],
      ["skills/appendEvent"],
      ["agentSkills/list"],
      ["agentSkills/get", { skillId: "missing-skill" }],
      ["agentSkills/create", { name: "Unauthenticated", description: "Nope", body: "Steps" }],
      ["agentSkills/update", { skillId: "missing-skill", description: "Nope" }],
      ["agentSkills/remove", { skillId: "missing-skill" }],
      ["capabilities/list"],
      ["capabilities/sourcePresets"],
      ["capabilities/install", capabilityInput("Unauthenticated")],
      ["capabilities/remove", { id: "missing-capability" }],
      ["capabilities/catalogSearch"],
      ["capabilities/pluginParts"],
      ["capabilities/pluginPreview"],
      ["connections/catalog", {}],
      ["connections/list"],
      ["connections/begin", connectionInput("Unauthenticated")],
      ["connections/complete", { connectionId: "missing-connection" }],
      ["connections/revoke", { connectionId: "missing-connection" }],
      ["connections/rename"],
      ["connections/tools"],
      ["approvalRules/list"],
      ["approvalRules/set", { effect: "deny", matchKind: "tool", matchValue: "gmail_send_email" }],
      ["approvalRules/remove", { id: "missing-rule" }],
      ["artifacts/list", { botId: "missing-bot" }],
      ["artifacts/listSpace"],
      ["artifacts/listVersions"],
      ["artifacts/create"],
      ["artifacts/get"],
      ["artifacts/getById"],
      ["artifacts/remove"],
      ["pages/list"],
      ["pages/get"],
      ["pages/rename"],
      ["pages/setVisibility"],
      ["pages/pin"],
      ["pages/remove"],
      ["usage/list"],
      ["usage/summary"],
      ["usage/limits"],
      ["export/bot", { botId: "missing-bot" }],
      ["export/accountToken"],
      ["notifications/subscribe"],
      ["notifications/subscribeCalls"],
      ["notifications/declineIncomingCall", { callId: "00000000-0000-4000-8000-000000000001" }],
      [
        "notifications/registerCallPush",
        {
          deviceId: "00000000-0000-4000-8000-000000000002",
          platform: "android",
          expoToken: "ExponentPushToken[not-real]",
        },
      ],
      ["notifications/registerPush", { token: "ExponentPushToken[not-real]" }],
      ["notifications/unregisterPush"],
      ["notifications/followWorkActivity", { token: "ab".repeat(32) }],
      ["notifications/registerWorkActivityStarts", { token: "ab".repeat(32) }],
      ["search/query", { q: "anything" }],
      ["voice/catalog"],
      ["voice/status"],
      ["voice/credentials"],
      ["voice/connect", { provider: "elevenlabs", apiKey: "not-a-real-key" }],
      ["voice/disconnect", { provider: "elevenlabs" }],
      ["voice/setVoice", { voiceId: "missing-voice" }],
      ["voice/voices", {}],
      ["voice/prepare", { text: "Nope" }],
      ["voice/setSpeechModel"],
      ["analytics/screen"],
      ["aiConsent/status"],
      ["aiConsent/allow"],
      ["aiConsent/revoke"],
      ["billing/status"],
      ["billing/refresh"],
      ["billing/selectFunding"],
      ["billing/purchaseCredits"],
      ["billing/setMonthlyCredits"],
      ["billing/checkout"],
      ["billing/portal"],
      ["billing/endTrial"],
      ["billing/switchToYearly"],
      ["billing/changeTier"],
      ["billing/claimReferral"],
      ["accessGrants/list"],
      ["accessGrants/create"],
      ["accessGrants/revoke"],
      ["preferences/update"],
      ["preferences/adoptTimezone"],
      ["bootstrap"],
      ["security/events"],
      ["audit/events"],
      ["boards/list"],
      ["boards/get"],
      ["boards/rename"],
      ["boards/subscribe"],
      ["tickets/list"],
      ["tickets/get"],
      ["tickets/create"],
      ["tickets/update"],
      ["tickets/move"],
      ["tickets/comment"],
      ["tickets/comments"],
      ["availability/set"],
      ["availability/items"],
      ["availability/chooseForSpace"],
      ["marketplace/catalog"],
      ["marketplace/review"],
      ["marketplace/submissions"],
      ["mcp/servers/list"],
      ["mcp/servers/create"],
      ["mcp/servers/update"],
      ["mcp/servers/remove"],
      ["mcp/servers/test"],
      ["mcp/servers/agents"],
      ["mcp/assignments/list"],
      ["mcp/assignments/all"],
      ["mcp/assignments/approve"],
      ["mcp/assignments/dismiss"],
      ["mcp/assignments/replace"],
      ["mcp/oauth/begin"],
      ["mcp/oauth/complete"],
      ["mcp/oauth/disconnect"],
      ["onboarding/signupSurvey"],
      ["onboarding/start"],
      ["onboarding/promptFocus"],
      ["onboarding/choose"],
      ["onboarding/dismissFocus"],
      ["onboarding/appConnected"],
      ["integrationSetup/get"],
      ["integrationSetup/save"],
      ["messaging/installations/list"],
      ["messaging/installations/start"],
      ["messaging/installations/complete", { state: "state", code: "code" }],
      ["messaging/installations/remove"],
      ["messaging/status"],
      ["messaging/link/start"],
      ["messaging/identities/setBot"],
      ["messaging/identities/unlink"],
      ["messaging/channels/list"],
      ["messaging/channels/respond"],
      ["messaging/channels/leave"],
      ["messaging/connections/list"],
      ["messaging/connections/respond"],
      ["messaging/connections/revoke"],
      ["trustedLinkSites/list"],
      ["trustedLinkSites/trust"],
      ["trustedLinkSites/remove"],
      ["autoReview/get"],
      ["autoReview/set"],
      ["spaceSettings/overrides"],
      ["spaceSettings/setOverride"],
      ["links/favicon"],
      ["runs/list"],
      ["paymentWallet/status"],
      ["paymentWallet/connect"],
      ["paymentWallet/disconnect"],
      ["spendingLimit/get"],
      ["spendingLimit/set", { limit: null }],
      ["spendingLimit/payments"],
      ["externalConversations/updatePolicy"],
      ["agentSecrets/list"],
      ["agentSecrets/put"],
      ["agentSecrets/remove"],
      ["vault/list"],
      ["vault/put"],
      ["vault/reveal"],
      ["vault/activity"],
      ["vault/import"],
      ["vault/remove"],
      ["botSecrets/list"],
      ["botSecrets/put"],
      ["botSecrets/remove"],
    ]);

    const results = await Promise.all(
      calls.map(async ([procedure, input]) => ({
        procedure,
        response: await raw(app, "", procedure, input),
      })),
    );

    for (const { procedure, response } of results) {
      expect(response.status, procedure).toBe(401);
    }
  });

  it("prevents one user from reading or mutating another user's resources", async () => {
    const owner = await signup(app, `owner-authz-${stamp}@rakazo.test`, "Authorization Owner");
    const intruder = await signup(
      app,
      `intruder-authz-${stamp}@rakazo.test`,
      "Authorization Intruder",
    );
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const intruderActor = await rpc<Actor>(app, intruder, "me");
    expect(ownerActor.spaceId).not.toBe(intruderActor.spaceId);

    const ownerBot = await rpc<Bot>(app, owner, "bots/create", botInput("Owner Bot"));
    const intruderBot = await rpc<Bot>(app, intruder, "bots/create", botInput("Intruder Bot"));
    const ownerRoutine = await rpc<{ id: string }>(
      app,
      owner,
      "routines/create",
      routineInput(ownerBot.id),
    );
    const ownerScratchpad = await rpc<{ id: string }>(app, owner, "scratchpad/create", {
      botId: ownerBot.id,
      title: "Owner open work",
      notes: "private",
    });
    const ownerSkill = await db.taughtSkill.create({
      data: {
        spaceId: ownerActor.spaceId,
        botId: ownerBot.id,
        userId: ownerActor.userId,
        name: "Owner Skill",
        goal: "Owner-only skill",
        status: "saved",
        playbook: skillPlaybookInput(),
        recording: { events: [], snapshots: [] },
      },
    });
    const ownerAgentSkill = await rpc<{ id: string }>(app, owner, "agentSkills/create", {
      name: "Owner Recipe",
      description: "Owner-only shared skill",
      body: "1. Do the private thing.",
    });
    const ownerCapability = await rpc<{ id: string }>(
      app,
      owner,
      "capabilities/install",
      capabilityInput("Owner Capability"),
    );
    const ownerConnection = await rpc<{ connectionId: string }>(
      app,
      owner,
      "connections/begin",
      connectionInput("Owner Connection"),
    );
    const ownerMemory = await db.memoryDocument.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        scope: "bot",
        path: "PRIVATE.md",
        content: "owner-only-memory",
      },
    });
    const ownerArtifact = await db.artifact.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        name: "owner-secret.txt",
        mimeType: "text/plain",
        size: 17,
        hash: "sha256:not-a-real-hash",
        storageKey: "test/owner-secret.txt",
      },
    });
    const ownerThread = await db.thread.findUniqueOrThrow({
      where: { botId: ownerBot.id },
    });
    const ownerTask = await asSystem(handles.prisma).task.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        threadId: ownerThread.id,
        prompt: "owner prompt",
        status: "waiting_input",
      },
    });
    const ownerRun = await asSystem(handles.prisma).run.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        threadId: ownerThread.id,
        taskId: ownerTask.id,
        status: "waiting_input",
        trigger: "user",
      },
    });

    const botIdCalls: Array<[string, unknown]> = [
      ["bots/get", { botId: ownerBot.id }],
      ["bots/duplicate", { botId: ownerBot.id }],
      ["bots/update", { botId: ownerBot.id, name: "Stolen Bot" }],
      ["bots/archive", { botId: ownerBot.id }],
      ["bots/restore", { botId: ownerBot.id }],
      ["bots/emailAddress", { botId: ownerBot.id }],
      ["bots/claimEmailAddress", { botId: ownerBot.id, name: "intruder-claim" }],
      ["threads/get", { botId: ownerBot.id }],
      ["threads/messages", { botId: ownerBot.id, before: 1 }],
      ["threads/subscribe", { botId: ownerBot.id, cursor: -1 }],
      ["threads/send", { botId: ownerBot.id, text: "intruder message" }],
      ["threads/send", { botId: ownerBot.id, artifactIds: [ownerArtifact.id] }],
      ["threads/stop", { botId: ownerBot.id }],
      ["threads/stopHelper", { botId: ownerBot.id, messageId: "missing-message" }],
      ["threads/clear", { botId: ownerBot.id }],
      ["threads/followUp", { botId: ownerBot.id, text: "intruder follow-up" }],
      [
        "threads/answer",
        {
          botId: ownerBot.id,
          runId: ownerRun.id,
          messageId: "missing-message",
          answer: "intruder answer",
        },
      ],
      ["threads/markRead", { botId: ownerBot.id }],
      ["threads/markUnread", { botId: ownerBot.id }],
      ["threads/snooze", { botId: ownerBot.id, until: null }],
      ["computer/status", { botId: ownerBot.id }],
      ["computer/boot", { botId: ownerBot.id }],
      ["computer/stop", { botId: ownerBot.id }],
      ["computer/takeover", { botId: ownerBot.id }],
      ["computer/release", { botId: ownerBot.id }],
      ["computer/input", { botId: ownerBot.id, kind: "key", payload: { key: "A" } }],
      ["computer/files", { botId: ownerBot.id, path: "/" }],
      ["computer/readFile", { botId: ownerBot.id, path: "PRIVATE.md" }],
      ["computer/screenUrl", { botId: ownerBot.id }],
      ["computer/preview", { botId: ownerBot.id }],
      ["computer/heartbeat", { botId: ownerBot.id }],
      ["routines/list", { botId: ownerBot.id }],
      ["routines/create", routineInput(ownerBot.id)],
      ["scratchpad/list", { botId: ownerBot.id }],
      ["scratchpad/create", { botId: ownerBot.id, title: "Stolen item" }],
      ["skills/list", { botId: ownerBot.id }],
      ["skills/start", { botId: ownerBot.id, goal: "Intruder demo" }],
      ["artifacts/list", { botId: ownerBot.id }],
      [
        "artifacts/create",
        {
          botId: ownerBot.id,
          name: "intruder.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from("nope").toString("base64"),
        },
      ],
      ["artifacts/get", { botId: ownerBot.id, artifactId: ownerArtifact.id }],
      ["export/bot", { botId: ownerBot.id }],
      ["voice/prepare", { text: "stolen speech", botId: ownerBot.id }],
    ];
    await Promise.all(
      botIdCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    const ownerBot2 = await rpc<Bot>(app, owner, "bots/create", botInput("Owner Bot Two"));
    const ownerGroup = await rpc<{ id: string }>(app, owner, "groups/create", {
      name: "Owner Group",
      botIds: [ownerBot.id, ownerBot2.id],
    });
    const groupCalls: Array<[string, unknown]> = [
      ["groups/get", { groupId: ownerGroup.id }],
      ["groups/update", { groupId: ownerGroup.id, name: "Stolen Group" }],
      ["groups/remove", { groupId: ownerGroup.id }],
      ["threads/get", { groupId: ownerGroup.id }],
      ["threads/messages", { groupId: ownerGroup.id, before: 1 }],
      ["threads/subscribe", { groupId: ownerGroup.id, cursor: -1 }],
      ["threads/send", { groupId: ownerGroup.id, text: "intruder group message" }],
      ["threads/stop", { groupId: ownerGroup.id }],
      ["threads/followUp", { groupId: ownerGroup.id, text: "intruder follow-up" }],
      ["threads/markRead", { groupId: ownerGroup.id }],
      ["threads/markUnread", { groupId: ownerGroup.id }],
      ["threads/snooze", { groupId: ownerGroup.id, until: null }],
    ];
    await Promise.all(
      groupCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    // A caller cannot pair their own bot with another workspace's run ID.
    await expectDenied(app, intruder, "threads/answer", {
      botId: intruderBot.id,
      runId: ownerRun.id,
      messageId: "missing-message",
      answer: "mixed-resource attack",
    });

    const resourceIdCalls = [
      ["routines/update", { routineId: ownerRoutine.id, name: "Stolen Routine" }],
      ["routines/remove", { routineId: ownerRoutine.id }],
      ["routines/testRun", { routineId: ownerRoutine.id }],
      [
        "threads/sendWithRoutines",
        { botId: intruderBot.id, clientNonce: "stolen", routineIds: [ownerRoutine.id] },
      ],
      [
        "threads/sendWithRoutines",
        {
          botId: intruderBot.id,
          clientNonce: "stolen-text",
          text: "intruder message",
          routineIds: [ownerRoutine.id],
        },
      ],
      ["scratchpad/update", { itemId: ownerScratchpad.id, title: "Stolen item" }],
      ["scratchpad/remove", { itemId: ownerScratchpad.id }],
      ["skills/get", { skillId: ownerSkill.id }],
      [
        "skills/appendEvent",
        { skillId: ownerSkill.id, event: { at: new Date().toISOString(), kind: "key", key: "x" } },
      ],
      ["skills/snapshot", { skillId: ownerSkill.id }],
      ["skills/stop", { skillId: ownerSkill.id }],
      ["skills/updateDraft", { skillId: ownerSkill.id, playbook: skillPlaybookInput() }],
      ["skills/save", { skillId: ownerSkill.id }],
      ["skills/testRun", { skillId: ownerSkill.id }],
      ["skills/remove", { skillId: ownerSkill.id }],
      ["agentSkills/get", { skillId: ownerAgentSkill.id }],
      ["agentSkills/update", { skillId: ownerAgentSkill.id, description: "Stolen" }],
      ["agentSkills/remove", { skillId: ownerAgentSkill.id }],
      ["memory/update", { documentId: ownerMemory.id, content: "stolen" }],
      ["connections/complete", { connectionId: ownerConnection.connectionId }],
    ] satisfies Array<[string, unknown]>;
    await Promise.all(
      resourceIdCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    expect(await rpc<unknown[]>(app, intruder, "memory/list", { botId: ownerBot.id })).toEqual([]);
    expect(await rpc<string>(app, intruder, "memory/exportMarkdown", { botId: ownerBot.id })).toBe(
      "",
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "capabilities/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerCapability.id }),
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "agentSkills/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerAgentSkill.id }),
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "connections/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerConnection.connectionId }),
    );
    expect(
      await rpc<{ hits: unknown[] }>(app, intruder, "search/query", { q: ownerBot.name }),
    ).toEqual({ hits: [] });

    // These endpoints are deliberately idempotent for unknown IDs. Success must not mutate
    // a row in a different workspace or disclose whether it exists.
    await rpc(app, intruder, "capabilities/remove", { id: ownerCapability.id });
    await rpc(app, intruder, "connections/revoke", {
      connectionId: ownerConnection.connectionId,
    });
    expect(
      await handles.prisma.capabilityInstall.findUnique({ where: { id: ownerCapability.id } }),
    ).not.toBeNull();
    expect(
      await asSystem(handles.prisma).connection.findUniqueOrThrow({
        where: { id: ownerConnection.connectionId },
      }),
    ).toMatchObject({ status: "connected", userId: ownerActor.userId });

    const ownerBotAfter = await asSystem(handles.prisma).bot.findUniqueOrThrow({
      where: { id: ownerBot.id },
    });
    expect(ownerBotAfter.name).toBe("Owner Bot");
    expect(
      await asSystem(handles.prisma).routine.findUniqueOrThrow({ where: { id: ownerRoutine.id } }),
    ).toMatchObject({ name: "Owner Routine" });
    expect(
      await asSystem(handles.prisma).scratchpadItem.findUniqueOrThrow({
        where: { id: ownerScratchpad.id },
      }),
    ).toMatchObject({ title: "Owner open work", notes: "private" });
    expect(
      await db.memoryDocument.findUniqueOrThrow({ where: { id: ownerMemory.id } }),
    ).toMatchObject({ content: "owner-only-memory" });

    // Destructive bot removal is checked last so an authorization regression is unmistakable.
    await expectDenied(app, intruder, "bots/removePreview", { botId: ownerBot.id });
    await expectDenied(app, intruder, "bots/remove", {
      botId: ownerBot.id,
      deleteMemories: true,
    });
    expect(
      await asSystem(handles.prisma).bot.findUnique({ where: { id: ownerBot.id } }),
    ).not.toBeNull();
  });

  it("hands a device's push token to the account that registers it last", async () => {
    const first = await signup(app, `push-first-${stamp}@rakazo.test`, "Push First");
    const second = await signup(app, `push-second-${stamp}@rakazo.test`, "Push Second");
    const firstUser = (await rpc<Actor>(app, first, "me")).userId;
    const secondUser = (await rpc<Actor>(app, second, "me")).userId;
    const device = "ExponentPushToken[shared-device]";

    await rpc(app, first, "notifications/registerPush", { token: device });
    // Another device, or unregistering, only ever touches the caller's own token.
    await rpc(app, second, "notifications/registerPush", { token: "ExponentPushToken[other]" });
    await rpc(app, second, "notifications/unregisterPush");
    await expect(loadPushToken(firstUser)).resolves.toBe(device);

    await rpc(app, second, "notifications/registerPush", { token: device });
    await expect(loadPushToken(secondUser)).resolves.toBe(device);
    await expect(loadPushToken(firstUser)).resolves.toBeUndefined();
    const multiline = await raw(app, first, "notifications/registerPush", {
      token: `${device}\nsession`,
    });
    expect(multiline.status).toBe(400);
  });

  // On the wire, the POST older phone apps send without a body arrives as an empty one.
  const emptyBody = { method: "POST", body: "" };

  it("ends the session when an older phone app signs out with an empty body", async () => {
    const phone = await phoneSession(app, `phone-sign-out-${stamp}@rakazo.test`);
    const signedOut = await app.request("/api/auth/sign-out", {
      ...emptyBody,
      headers: { ...phone.headers, "content-type": "application/json", "content-length": "0" },
    });
    expect(signedOut.status).toBe(200);
    expect(await phone.me()).toBe(401);
  });

  it("accepts the deletion-code request older apps send with no body", async () => {
    const phone = await phoneSession(app, `phone-deletion-code-${stamp}@rakazo.test`);
    const response = await app.request("/api/auth/request-account-deletion", {
      ...emptyBody,
      headers: { ...phone.headers, "content-length": "0" },
    });
    // A password account reaches the endpoint, which offers deletion by password instead.
    expect(await response.json()).toMatchObject({ code: "EMAIL_DELETION_UNAVAILABLE" });
  });

  it("still rejects a malformed auth body", async () => {
    const phone = await phoneSession(app, `phone-malformed-${stamp}@rakazo.test`);
    const response = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { ...phone.headers, "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await phone.me()).toBe(200);
  });

  it("marks account and RPC replies as not cacheable, including errors", async () => {
    const email = `phone-no-store-${stamp}@rakazo.test`;
    const phone = await phoneSession(app, email);
    const rpc = (path: string, headers: Record<string, string>) =>
      app.request(`/rpc/${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      });
    const signIn = (password: string) =>
      app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "rakazo://" },
        body: JSON.stringify({ email, password }),
      });
    const responses = {
      signIn: await signIn("password12"),
      wrongPassword: await signIn("wrong-pass"),
      blockedAuthPath: await app.request("/api/auth/organization/list"),
      oversizedAuthBody: await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(1024 * 1024) },
        body: "{}",
      }),
      me: await rpc("me", phone.headers),
      signedOutMe: await rpc("me", { origin: "rakazo://" }),
      unknownProcedure: await rpc("not-a-procedure", phone.headers),
    };

    expect(
      Object.fromEntries(
        Object.entries(responses).map(([name, response]) => [
          name,
          [response.status, response.headers.get("cache-control")],
        ]),
      ),
    ).toEqual({
      signIn: [200, "no-store"],
      wrongPassword: [401, "no-store"],
      blockedAuthPath: [404, "no-store"],
      oversizedAuthBody: [413, "no-store"],
      me: [200, "no-store"],
      signedOutMe: [401, "no-store"],
      unknownProcedure: [404, "no-store"],
    });
  });

  it("uses the bearer session over another account's session cookie", async () => {
    const a = await phoneSession(app, `phone-cookie-a-${stamp}@rakazo.test`);
    const b = await phoneSession(app, `phone-cookie-b-${stamp}@rakazo.test`);
    const both = { ...b.headers, cookie: a.cookie, "content-type": "application/json" };
    const me = () =>
      app.request("/rpc/me", { method: "POST", headers: both, body: JSON.stringify({ json: {} }) });

    const signedIn = await me();
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toMatchObject({ json: { userId: b.userId } });

    const signedOut = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: both,
      body: "{}",
    });
    expect(signedOut.status).toBe(200);
    expect((await me()).status).toBe(401);
    expect(await a.me()).toBe(200);
  });

  it("accepts only signed bearer tokens, and every sign-in hands one out", async () => {
    const email = `phone-signed-${stamp}@rakazo.test`;
    const phone = await phoneSession(app, email);
    const me = async (token: string) =>
      (
        await app.request("/rpc/me", {
          method: "POST",
          headers: {
            origin: "rakazo://",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ json: {} }),
        })
      ).status;
    const authJson = async (path: string, token: string, body: unknown) => {
      const response = await app.request(`/api/auth${path}`, {
        method: "POST",
        headers: {
          origin: "rakazo://",
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      const json = (await response.json()) as { token: string };
      expect(json.token).toBe(decodeURIComponent(response.headers.get("set-auth-token") ?? ""));
      return json.token;
    };

    const stored = await handles.prisma.session.findFirstOrThrow({
      where: { userId: phone.userId },
      select: { token: true },
    });
    expect(phone.token.startsWith(`${stored.token}.`)).toBe(true);
    expect(phone.token).toBe(decodeURIComponent(phone.setAuthToken));
    expect(await me(phone.token)).toBe(200);
    expect(await me(encodeURIComponent(phone.token))).toBe(200);

    // A token copied out of the session table, or given a forged signature, is not a session.
    expect(await me(stored.token)).toBe(401);
    expect(await me(`${stored.token}.${"A".repeat(43)}=`)).toBe(401);
    const rawSession = await app.request("/api/auth/get-session", {
      headers: { origin: "rakazo://", authorization: `Bearer ${stored.token}` },
    });
    expect(await rawSession.json()).toBeNull();

    const signedIn = await authJson("/sign-in/email", "", { email, password: "password12" });
    expect(await me(signedIn)).toBe(200);

    // Replacing the session on a password change hands the phone the signed replacement.
    const replaced = await authJson("/change-password", signedIn, {
      currentPassword: "password12",
      newPassword: "password34",
      revokeOtherSessions: true,
    });
    expect(replaced).not.toBe(signedIn);
    expect(await me(replaced)).toBe(200);
    expect(await me(signedIn)).toBe(401);
  });

  it("drops a push token when the session that registered it is revoked", async () => {
    const email = `push-sessions-${stamp}@rakazo.test`;
    const phone = await signup(app, email, "Push Sessions");
    const userId = (await rpc<Actor>(app, phone, "me")).userId;
    const token = "ExponentPushToken[phone]";
    await rpc(app, phone, "notifications/registerPush", { token });

    // Signing out or revoking other sessions elsewhere keeps the phone's token.
    await authPost(app, await signin(app, email), "/sign-out");
    await authPost(app, phone, "/revoke-other-sessions");
    await expect(loadPushToken(userId)).resolves.toBe(token);

    await authPost(app, await signin(app, email), "/revoke-other-sessions");
    await expect(loadPushToken(userId)).resolves.toBeUndefined();

    const relogged = await signin(app, email);
    await rpc(app, relogged, "notifications/registerPush", { token });
    await authPost(app, await signin(app, email), "/change-password", {
      currentPassword: "password12",
      newPassword: "password34",
      revokeOtherSessions: true,
    });
    await expect(loadPushToken(userId)).resolves.toBeUndefined();

    // Changing the password on the phone itself replaces its session; the token follows it.
    const samePhone = await signin(app, email, "password34");
    await rpc(app, samePhone, "notifications/registerPush", { token });
    await authPost(app, samePhone, "/change-password", {
      currentPassword: "password34",
      newPassword: "password56",
      revokeOtherSessions: true,
    });
    await expect(loadPushToken(userId)).resolves.toBe(token);
    await authPost(app, await signin(app, email, "password56"), "/revoke-other-sessions");
    await expect(loadPushToken(userId)).resolves.toBeUndefined();

    const signedIn = await signin(app, email, "password56");
    await rpc(app, signedIn, "notifications/registerPush", { token });
    await authPost(app, signedIn, "/revoke-sessions");
    await expect(loadPushToken(userId)).resolves.toBeUndefined();
  });

  it("does not deliver a push token after its session expires without a request", async () => {
    const email = `push-expired-${stamp}@rakazo.test`;
    const phone = await signup(app, email, "Push Expired");
    const userId = (await rpc<Actor>(app, phone, "me")).userId;
    const token = "ExponentPushToken[expired-session]";
    await rpc(app, phone, "notifications/registerPush", { token });
    await handles.prisma.session.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const push = new ExpoPushProvider(pushTokens, {
        sessionExpiresAt: (sessionId) => pushSessionExpiresAt(handles.prisma, sessionId),
      });
      await expect(
        push.deliver(
          { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
          {
            operationId: "n",
            traceId: "n",
            spaceId: "w",
            userId,
            signal: new AbortController().signal,
          },
        ),
      ).resolves.toBe("undeliverable");
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(loadPushToken(userId)).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps approval rules private to each user in a shared Space", async () => {
    const owner = await signup(app, `approval-owner-${stamp}@rakazo.test`, "Approval Owner");
    const member = await signup(app, `approval-member-${stamp}@rakazo.test`, "Approval Member");
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const memberActor = await rpc<Actor>(app, member, "me");

    await handles.prisma.member.deleteMany({ where: { userId: memberActor.userId } });
    await handles.prisma.member.create({
      data: {
        id: `approval-member-${stamp}`,
        organizationId: ownerActor.spaceId,
        userId: memberActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const ownerRule = await rpc<{ id: string }>(app, owner, "approvalRules/set", {
      effect: "always_allow",
      matchKind: "tool",
      matchValue: "destination.write",
    });
    expect(await rpc<unknown[]>(app, member, "approvalRules/list")).toEqual([]);

    const memberRule = await rpc<{ id: string }>(app, member, "approvalRules/set", {
      effect: "deny",
      matchKind: "tool",
      matchValue: "gmail_send_email",
    });
    expect(await rpc<Array<{ id: string }>>(app, owner, "approvalRules/list")).toEqual([
      expect.objectContaining({ id: ownerRule.id }),
    ]);
    expect(await rpc<Array<{ id: string }>>(app, member, "approvalRules/list")).toEqual([
      expect.objectContaining({ id: memberRule.id }),
    ]);

    await rpc(app, member, "approvalRules/remove", { id: ownerRule.id });
    expect(
      await asSystem(handles.prisma).userActionApprovalRule.findUnique({
        where: { id: ownerRule.id },
      }),
    ).not.toBeNull();
  });

  it("keeps space data and computers behind the selected space boundary", async () => {
    const cookie = await signup(app, `spaces-${stamp}@rakazo.test`, "Space Owner");
    const original = await rpc<Actor>(app, cookie, "me");
    const originalBot = await rpc<Bot>(app, cookie, "bots/create", botInput("Open source"));
    const support = await rpc<Space>(app, cookie, "spaces/create", {
      name: "Customer support",
    });
    const storedSpaces = await handles.prisma.space.findMany({
      where: { id: { in: [original.spaceId, support.id] } },
      select: { id: true, organizationId: true },
    });
    expect(new Set(storedSpaces.map((space) => space.organizationId))).toEqual(
      new Set([original.spaceId]),
    );
    const otherOrganizationId = `spaces-other-org-${stamp}`;
    const otherWorkspaceId = `spaces-other-workspace-${stamp}`;
    await handles.prisma.$transaction([
      handles.prisma.organization.create({
        data: {
          id: otherOrganizationId,
          name: "Other company",
          slug: otherOrganizationId,
          createdAt: new Date(),
        },
      }),
      handles.prisma.member.create({
        data: {
          id: `spaces-other-member-${stamp}`,
          organizationId: otherOrganizationId,
          userId: original.userId,
          role: "owner",
          createdAt: new Date(),
        },
      }),
      handles.prisma.space.create({
        data: {
          id: otherWorkspaceId,
          organizationId: otherOrganizationId,
          name: "Other company space",
        },
      }),
      handles.prisma.spaceMember.create({
        data: {
          id: `spaces-other-space-member-${stamp}`,
          spaceId: otherWorkspaceId,
          organizationId: otherOrganizationId,
          userId: original.userId,
          role: "owner",
          createdAt: new Date(),
        },
      }),
    ]);

    // Owning a target in a different organization does not authorize a rename
    // from the active organization.
    await expect(
      raw(app, cookie, "spaces/rename", { spaceId: otherWorkspaceId, name: "Wrong organization" }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      handles.prisma.space.findUniqueOrThrow({
        where: { id: otherWorkspaceId },
        select: { name: true },
      }),
    ).resolves.toEqual({ name: "Other company space" });

    const supportMe = await rpc<Actor>(app, cookie, "me", {}, support.id);
    expect(supportMe.spaceId).toBe(support.id);
    const supportBot = await rpc<Bot>(app, cookie, "bots/create", botInput("Support"), support.id);

    expect(await rpc<Array<{ id: string }>>(app, cookie, "bots/list")).toEqual([
      expect.objectContaining({ id: originalBot.id }),
    ]);
    expect(await rpc<Array<{ id: string }>>(app, cookie, "bots/list", {}, support.id)).toEqual([
      expect.objectContaining({ id: supportBot.id }),
    ]);
    await expectDenied(app, cookie, "bots/get", { botId: supportBot.id });
    await expectDenied(app, cookie, "bots/get", { botId: originalBot.id }, support.id);

    const navigation = await rpc<SpaceNavigation>(app, cookie, "spaces/list");
    expect(navigation.current).toEqual(
      expect.objectContaining({
        id: original.spaceId,
        bots: [expect.objectContaining({ id: originalBot.id })],
      }),
    );
    expect(navigation.spaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: original.spaceId,
          bots: [expect.objectContaining({ id: originalBot.id, notifyOnFinish: false })],
        }),
        expect.objectContaining({
          id: support.id,
          name: "Customer support",
          bots: [expect.objectContaining({ id: supportBot.id, notifyOnFinish: false })],
        }),
      ]),
    );
    expect(navigation.spaces).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: otherWorkspaceId })]),
    );
    const supportNavigation = await rpc<SpaceNavigation>(
      app,
      cookie,
      "spaces/list",
      {},
      support.id,
    );
    expect(supportNavigation.current).toEqual(
      expect.objectContaining({
        id: support.id,
        bots: [expect.objectContaining({ id: supportBot.id })],
      }),
    );
    const otherOrganizationNavigation = await rpc<SpaceNavigation>(
      app,
      cookie,
      "spaces/list",
      {},
      otherWorkspaceId,
    );
    expect(otherOrganizationNavigation.spaces.map((space) => space.id)).toEqual([otherWorkspaceId]);

    const storedBots = await asSystem(handles.prisma).bot.findMany({
      where: { id: { in: [originalBot.id, supportBot.id] } },
      select: { id: true, spaceId: true, computerId: true },
    });
    const storedOriginal = storedBots.find((bot) => bot.id === originalBot.id);
    const storedSupport = storedBots.find((bot) => bot.id === supportBot.id);
    expect(storedOriginal?.spaceId).toBe(original.spaceId);
    expect(storedSupport?.spaceId).toBe(support.id);
    expect(storedOriginal?.computerId).not.toBe(storedSupport?.computerId);

    const intruder = await signup(app, `spaces-intruder-${stamp}@rakazo.test`, "Intruder");
    await expectDenied(app, intruder, "bots/list", {}, support.id);
  });

  it("enforces the space limit across concurrent creation requests", async () => {
    const cookie = await signup(app, `space-limit-${stamp}@rakazo.test`, "Space Limit");
    const actor = await rpc<Actor>(app, cookie, "me");
    const currentSpace = await handles.prisma.space.findUniqueOrThrow({
      where: { id: actor.spaceId },
      select: { organizationId: true },
    });
    const extraSpaces = Array.from({ length: 30 }, (_, index) => ({
      id: `limit-space-${stamp}-${index}`,
      organizationId: currentSpace.organizationId,
      name: `Limit space ${index}`,
      createdAt: new Date(),
    }));
    await handles.prisma.space.createMany({ data: extraSpaces });
    await handles.prisma.spaceMember.createMany({
      data: extraSpaces.map((space, index) => ({
        id: `limit-member-${stamp}-${index}`,
        spaceId: space.id,
        organizationId: space.organizationId,
        userId: actor.userId,
        createdAt: space.createdAt,
      })),
    });

    const results = await Promise.allSettled([
      rpc<Space>(app, cookie, "spaces/create", { name: "Concurrent A" }),
      rpc<Space>(app, cookie, "spaces/create", { name: "Concurrent B" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      handles.prisma.spaceMember.count({
        where: { userId: actor.userId, organizationId: currentSpace.organizationId },
      }),
    ).resolves.toBe(32);
  });

  it("reuses provider credentials and selections in a new Space", async () => {
    const cookie = await signup(app, `space-provider-copy-${stamp}@rakazo.test`, "Provider Copy");
    const actor = await rpc<Actor>(app, cookie, "me");
    const model = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "copy-provider",
      apiKey: "fake-copy-model-key",
      label: "Copy provider",
      modelId: "copy/model",
    });
    const voice = await rpc<{ id: string; voiceId: string }>(app, cookie, "voice/connect", {
      provider: "scripted",
      apiKey: "fake-copy-voice-key",
    });

    const created = await rpc<Space>(app, cookie, "spaces/create", { name: "Copied defaults" });
    const [modelPreference, voicePreference] = await Promise.all([
      db.userModelPreference.findUnique({
        where: { userId_credentialId: { userId: actor.userId, credentialId: model.id } },
      }),
      db.spaceVoicePreference.findUnique({
        where: {
          spaceId_userId_credentialId: {
            spaceId: created.id,
            userId: actor.userId,
            credentialId: voice.id,
          },
        },
      }),
    ]);

    expect(modelPreference).toMatchObject({ modelId: "copy/model" });
    // The new Space follows the member's main model without a copy of its own.
    await expect(
      rpc<ModelRoleSettings>(app, cookie, "models/role", { role: "main" }, created.id),
    ).resolves.toMatchObject({
      primary: { provider: "copy-provider", modelId: "copy/model", credentialId: model.id },
    });
    await expect(
      db.spaceModelRoleChoice.count({ where: { spaceId: created.id, userId: actor.userId } }),
    ).resolves.toBe(0);
    // The new Space follows the account's voice instead of copying it.
    expect(voicePreference).toBeNull();
    await expect(rpc(app, cookie, "voice/status", undefined, created.id)).resolves.toMatchObject({
      voiceId: voice.voiceId,
    });
    await setSpaceSettingOverride(db, { spaceId: created.id, userId: actor.userId }, "voice", true);
    await rpc(
      app,
      cookie,
      "voice/setVoice",
      { provider: "scripted", voiceId: "space-specific-voice" },
      created.id,
    );
    await expect(
      db.userVoicePreference.findUniqueOrThrow({
        where: { userId_credentialId: { userId: actor.userId, credentialId: voice.id } },
      }),
    ).resolves.toMatchObject({ voiceId: voice.voiceId, isDefault: true });
    await expect(rpc(app, cookie, "voice/status")).resolves.toMatchObject({
      voiceId: voice.voiceId,
    });
    await expect(
      db.spaceVoicePreference.findUniqueOrThrow({
        where: {
          spaceId_userId_credentialId: {
            spaceId: created.id,
            userId: actor.userId,
            credentialId: voice.id,
          },
        },
      }),
    ).resolves.toMatchObject({ voiceId: "space-specific-voice", isDefault: true });
    await expect(db.userModelCredential.count({ where: { userId: actor.userId } })).resolves.toBe(
      1,
    );
    await expect(db.userVoiceCredential.count({ where: { userId: actor.userId } })).resolves.toBe(
      1,
    );
  });

  it("shares model credentials and the main model across spaces until one customizes it", async () => {
    const cookie = await signup(app, `model-defaults-${stamp}@rakazo.test`, "Model Defaults");
    const actor = await rpc<Actor>(app, cookie, "me");
    const support = await rpc<Space>(app, cookie, "spaces/create", { name: "Support models" });
    const expectSpaceModelDefault = async (spaceId: string, provider: string, modelId: string) => {
      const main = await rpc<ModelRoleSettings>(
        app,
        cookie,
        "models/role",
        { role: "main" },
        spaceId,
      );
      expect(main.primary).toMatchObject({ provider, modelId });
    };

    const connectedA = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-a",
      apiKey: "fake-provider-a-key",
      label: "Provider A",
      modelId: "a/one",
    });
    expect(connectedA.isDefault).toBe(true);
    const providerABeforeRotation = await db.userModelCredential.findUniqueOrThrow({
      where: { id: connectedA.id },
    });

    const rotatedA = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-a",
      apiKey: "fake-provider-a-replacement-key",
      label: "Provider A rotated",
      modelId: "a/rotated",
    });
    const providerAAfterRotation = await db.userModelCredential.findUniqueOrThrow({
      where: { id: connectedA.id },
    });
    expect(rotatedA.id).toBe(connectedA.id);
    expect(providerAAfterRotation.secretId).not.toBe(providerABeforeRotation.secretId);
    expect(
      await db.secret.findUnique({ where: { id: providerABeforeRotation.secretId } }),
    ).toBeNull();
    await expect(
      db.secret.findUniqueOrThrow({ where: { id: providerAAfterRotation.secretId } }),
    ).resolves.toMatchObject({ userId: actor.userId, spaceId: null, kind: "model" });
    expect(
      await db.userModelCredential.count({
        where: { userId: actor.userId, provider: "provider-a" },
      }),
    ).toBe(1);

    const supportCredentials = await rpc<ModelCredential[]>(
      app,
      cookie,
      "models/credentials",
      {},
      support.id,
    );
    // The other Space follows the account's main model.
    expect(supportCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: connectedA.id, provider: "provider-a", isDefault: true }),
      ]),
    );
    await expectSpaceModelDefault(support.id, "provider-a", "a/rotated");
    await rpc(
      app,
      cookie,
      "models/setDefault",
      { provider: "provider-a", modelId: "a/shared" },
      support.id,
    );
    await expectSpaceModelDefault(support.id, "provider-a", "a/shared");
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/shared");

    // A customized Space starts from the account's models and then keeps its own.
    await expect(
      rpc(
        app,
        cookie,
        "spaceSettings/setOverride",
        { setting: "models", enabled: true },
        support.id,
      ),
    ).resolves.toEqual(["models"]);
    await rpc(
      app,
      cookie,
      "models/setDefault",
      { provider: "provider-a", modelId: "a/support" },
      support.id,
    );
    await expectSpaceModelDefault(support.id, "provider-a", "a/support");
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/shared");
    const accountFromSupport = await rpc<ModelRoleSettings>(
      app,
      cookie,
      "models/role",
      { role: "main", scope: "account" },
      support.id,
    );
    expect(accountFromSupport.primary).toMatchObject({ modelId: "a/shared" });

    const connectedB = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-b",
      apiKey: "fake-provider-b-key",
      label: "Provider B",
      modelId: "b/one",
    });
    expect(connectedB.isDefault).toBe(true);
    await expectSpaceModelDefault(actor.spaceId, "provider-b", "b/one");

    await rpc(app, cookie, "models/setDefault", { provider: "provider-a", modelId: "a/two" });
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/two");

    await rpc(app, cookie, "models/setDefault", { provider: "provider-b", modelId: "b/two" });
    await expectSpaceModelDefault(actor.spaceId, "provider-b", "b/two");

    await rpc(app, cookie, "models/setDefault", { provider: "provider-a", modelId: "a/three" });
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/three");
    await expectSpaceModelDefault(support.id, "provider-a", "a/support");

    // Using the defaults again drops the Space's copy.
    await expect(
      rpc(
        app,
        cookie,
        "spaceSettings/setOverride",
        { setting: "models", enabled: false },
        support.id,
      ),
    ).resolves.toEqual([]);
    await expectSpaceModelDefault(support.id, "provider-a", "a/three");
    const listed = await rpc<ModelCredential[]>(app, cookie, "models/credentials");
    expect(JSON.stringify(listed)).not.toContain("fake-provider-a-key");
    expect(JSON.stringify(listed)).not.toContain("fake-provider-b-key");

    const missing = await raw(app, cookie, "models/setDefault", {
      provider: "missing-provider",
      modelId: "missing/model",
    });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(await missing.text()).toMatch(/credential/i);
  });

  it("deletes an owned non-default space with all of its content", async () => {
    const cookie = await signup(app, `space-delete-${stamp}@rakazo.test`, "Space Delete");
    const actor = await rpc<Actor>(app, cookie, "me");
    const keepBot = await rpc<Bot>(app, cookie, "bots/create", botInput("Keep bot"));
    const keepRoutine = await rpc<{ id: string }>(
      app,
      cookie,
      "routines/create",
      routineInput(keepBot.id),
    );
    const busy = await rpc<Space>(app, cookie, "spaces/create", { name: "Busy" });
    const botA = await rpc<Bot>(app, cookie, "bots/create", botInput("Busy A"), busy.id);
    const botB = await rpc<Bot>(app, cookie, "bots/create", botInput("Busy B"), busy.id);
    const archived = await rpc<Bot>(app, cookie, "bots/create", botInput("Busy old"), busy.id);
    await rpc(app, cookie, "bots/archive", { botId: archived.id }, busy.id);
    const busyGroup = await rpc<{ id: string }>(
      app,
      cookie,
      "groups/create",
      { name: "Busy group", botIds: [botA.id, botB.id] },
      busy.id,
    );
    await rpc(app, cookie, "routines/create", routineInput(botA.id), busy.id);
    await db.memoryDocument.create({
      data: {
        spaceId: busy.id,
        userId: actor.userId,
        botId: botA.id,
        scope: "bot",
        path: "BUSY.md",
        content: "busy-space-memory",
      },
    });
    await db.artifact.create({
      data: {
        spaceId: busy.id,
        userId: actor.userId,
        botId: botA.id,
        name: "busy.txt",
        mimeType: "text/plain",
        size: 4,
        hash: "sha256:not-a-real-hash",
        storageKey: `test/space-delete-${stamp}.txt`,
      },
    });

    const listed = await rpc<SpaceNavigation>(app, cookie, "spaces/list", {}, busy.id);
    expect(listed.spaces.find((space) => space.id === busy.id)).toMatchObject({
      hasContent: true,
      canDelete: true,
      canRename: true,
      // The archived bot goes too, so the confirmation counts it.
      botCount: 3,
    });
    expect(listed.spaces.find((space) => space.id === actor.spaceId)?.canDelete).toBe(false);
    await expect(
      raw(app, cookie, "spaces/remove", { spaceId: actor.spaceId }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      raw(app, cookie, "spaces/remove", { spaceId: "missing-space" }),
    ).resolves.toMatchObject({ status: 404 });

    const intruder = await signup(app, `space-delete-intruder-${stamp}@rakazo.test`, "Intruder");
    await expect(raw(app, intruder, "spaces/remove", { spaceId: busy.id })).resolves.toMatchObject({
      status: 404,
    });
    await expect(
      raw(app, intruder, "spaces/rename", { spaceId: busy.id, name: "Stolen" }),
    ).resolves.toMatchObject({ status: 404 });
    expect(await db.bot.count({ where: { spaceId: busy.id } })).toBe(3);

    const removed = await rpc<{ ok: true; activeSpaceId: string }>(app, cookie, "spaces/remove", {
      spaceId: busy.id,
    });
    expect(removed).toEqual({ ok: true, activeSpaceId: actor.spaceId });
    await expect(db.space.findUnique({ where: { id: busy.id } })).resolves.toBeNull();
    for (const count of [
      db.bot.count({ where: { spaceId: busy.id } }),
      db.chatGroup.count({ where: { id: busyGroup.id } }),
      db.thread.count({ where: { spaceId: busy.id } }),
      db.routine.count({ where: { spaceId: busy.id } }),
      db.memoryDocument.count({ where: { spaceId: busy.id } }),
      db.artifact.count({ where: { spaceId: busy.id } }),
      db.spaceMember.count({ where: { spaceId: busy.id } }),
      db.botDeletion.count({ where: { spaceId: busy.id } }),
    ]) {
      await expect(count).resolves.toBe(0);
    }
    // Nothing outside the deleted space goes with it.
    await expect(db.bot.findUnique({ where: { id: keepBot.id } })).resolves.not.toBeNull();
    await expect(db.thread.count({ where: { botId: keepBot.id } })).resolves.toBe(1);
    await expect(db.routine.findUnique({ where: { id: keepRoutine.id } })).resolves.not.toBeNull();
    await expect(
      db.memoryDocument.count({ where: { spaceId: actor.spaceId } }),
    ).resolves.toBeGreaterThan(0);
    // Already gone: a retry cannot reach another space.
    await expect(raw(app, cookie, "spaces/remove", { spaceId: busy.id })).resolves.toMatchObject({
      status: 404,
    });
    const navigation = await rpc<SpaceNavigation>(app, cookie, "spaces/list");
    expect(navigation.spaces.map((space) => space.id)).not.toContain(busy.id);
  });

  it("lets only the owner rename or delete a shared space, removing its members", async () => {
    const cookie = await signup(app, `space-shared-${stamp}@rakazo.test`, "Space Owner");
    const shared = await rpc<Space>(app, cookie, "spaces/create", { name: "Shared" });
    const ownerBot = await rpc<Bot>(app, cookie, "bots/create", botInput("Shared bot"), shared.id);
    const sharedRow = await handles.prisma.space.findUniqueOrThrow({
      where: { id: shared.id },
      select: { organizationId: true },
    });
    const memberCookie = await signup(
      app,
      `space-shared-member-${stamp}@rakazo.test`,
      "Space Member",
    );
    const memberActor = await rpc<Actor>(app, memberCookie, "me");
    await handles.prisma.member.deleteMany({ where: { userId: memberActor.userId } });
    await handles.prisma.member.create({
      data: {
        id: `space-shared-org-member-${stamp}`,
        organizationId: sharedRow.organizationId,
        userId: memberActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await handles.prisma.spaceMember.create({
      data: {
        id: `space-shared-space-member-${stamp}`,
        spaceId: shared.id,
        organizationId: sharedRow.organizationId,
        userId: memberActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const memberNavigation = await rpc<SpaceNavigation>(
      app,
      memberCookie,
      "spaces/list",
      {},
      shared.id,
    );
    expect(memberNavigation.spaces.find((space) => space.id === shared.id)).toMatchObject({
      hasContent: true,
      canDelete: false,
      canRename: false,
    });
    await expect(
      raw(app, memberCookie, "spaces/remove", { spaceId: shared.id }, shared.id),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      raw(app, memberCookie, "spaces/rename", { spaceId: shared.id, name: "Stolen" }, shared.id),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      handles.prisma.space.findUnique({ where: { id: shared.id }, select: { name: true } }),
    ).resolves.toEqual({ name: "Shared" });
    await expect(db.bot.findUnique({ where: { id: ownerBot.id } })).resolves.not.toBeNull();

    // A member's only space stays even when they own it.
    await handles.prisma.spaceMember.deleteMany({
      where: { userId: memberActor.userId, spaceId: { not: shared.id } },
    });
    await handles.prisma.spaceMember.update({
      where: { id: `space-shared-space-member-${stamp}` },
      data: { role: "owner" },
    });
    expect(
      (await rpc<SpaceNavigation>(app, memberCookie, "spaces/list", {}, shared.id)).spaces.find(
        (space) => space.id === shared.id,
      )?.canDelete,
    ).toBe(false);
    await expect(
      raw(app, memberCookie, "spaces/remove", { spaceId: shared.id }, shared.id),
    ).resolves.toMatchObject({ status: 400 });
    await expect(db.bot.findUnique({ where: { id: ownerBot.id } })).resolves.not.toBeNull();

    const renamed = await rpc<{ id: string; name: string }>(app, cookie, "spaces/rename", {
      spaceId: shared.id,
      name: "  Shared renamed  ",
    });
    expect(renamed).toEqual({ id: shared.id, name: "Shared renamed" });
    const ownerRemoved = await rpc<{ ok: true; activeSpaceId: string }>(
      app,
      cookie,
      "spaces/remove",
      { spaceId: shared.id },
    );
    expect(ownerRemoved.ok).toBe(true);
    await expect(handles.prisma.space.findUnique({ where: { id: shared.id } })).resolves.toBeNull();
    await expect(db.bot.findUnique({ where: { id: ownerBot.id } })).resolves.toBeNull();
    await expect(
      db.spaceMember.count({ where: { userId: memberActor.userId, spaceId: shared.id } }),
    ).resolves.toBe(0);
  });

  it("keeps a bot's sandbox handle when its teardown fails, and finishes on retry", async () => {
    const cookie = await signup(app, `space-strict-${stamp}@rakazo.test`, "Strict Teardown");
    const actor = await rpc<Actor>(app, cookie, "me");
    const space = await rpc<Space>(app, cookie, "spaces/create", { name: "Strict" });
    const bot = await rpc<Bot>(app, cookie, "bots/create", botInput("Sandboxed"), space.id);
    const providerRef = `space-strict-provider-${stamp}`;
    await db.computer.upsert({
      where: { scopeKey: `bot:${bot.id}` },
      create: {
        spaceId: space.id,
        userId: actor.userId,
        scopeKey: `bot:${bot.id}`,
        homeKey: bot.id,
        kind: "fake",
        providerRef,
      },
      update: { providerRef },
    });
    const destroy = vi
      .spyOn(handles.sandbox, "destroy")
      .mockRejectedValueOnce(new Error("provider unavailable"));
    try {
      const failed = await raw(app, cookie, "spaces/remove", { spaceId: space.id });
      expect(failed.status).toBe(500);
      expect(destroy).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef }),
        expect.anything(),
      );
      await expect(db.bot.findUnique({ where: { id: bot.id } })).resolves.not.toBeNull();
      await expect(
        db.computer.findUnique({
          where: { scopeKey: `bot:${bot.id}` },
          select: { providerRef: true },
        }),
      ).resolves.toEqual({ providerRef });
      const lifecycle = await db.space.findUniqueOrThrow({
        where: { id: space.id },
        select: { deletionClaimId: true },
      });
      // Teardown may have reached the provider, so the space stays claimed.
      expect(lifecycle.deletionClaimId).toBeTruthy();
    } finally {
      destroy.mockRestore();
    }

    await db.space.update({
      where: { id: space.id },
      data: { deletingAt: new Date(Date.now() - 6 * 60_000) },
    });
    const retried = await rpc<{ ok: true; activeSpaceId: string }>(app, cookie, "spaces/remove", {
      spaceId: space.id,
    });
    expect(retried).toEqual({ ok: true, activeSpaceId: actor.spaceId });
    await expect(db.space.findUnique({ where: { id: space.id } })).resolves.toBeNull();
    await expect(db.computer.count({ where: { scopeKey: `bot:${bot.id}` } })).resolves.toBe(0);
  });

  it("resumes a stale space deletion and rejects one still in progress", async () => {
    const cookie = await signup(app, `space-resume-${stamp}@rakazo.test`, "Space Resume");
    const actor = await rpc<Actor>(app, cookie, "me");
    const space = await rpc<Space>(app, cookie, "spaces/create", { name: "Resume" });
    const bot = await rpc<Bot>(app, cookie, "bots/create", botInput("Resume bot"), space.id);
    // A worker that claimed the space and then died.
    await runAsTenant({ spaceId: space.id, userId: actor.userId }, () =>
      claimSpaceDeletionForMember(handles.prisma, {
        currentSpaceId: space.id,
        userId: actor.userId,
        spaceId: space.id,
      }),
    );
    await expect(raw(app, cookie, "spaces/remove", { spaceId: space.id })).resolves.toMatchObject({
      status: 409,
    });
    await expect(db.bot.findUnique({ where: { id: bot.id } })).resolves.not.toBeNull();

    await handles.prisma.space.update({
      where: { id: space.id },
      data: { deletingAt: new Date(Date.now() - 6 * 60_000) },
    });
    const removed = await rpc<{ ok: true; activeSpaceId: string }>(app, cookie, "spaces/remove", {
      spaceId: space.id,
    });
    expect(removed).toEqual({ ok: true, activeSpaceId: actor.spaceId });
    await expect(handles.prisma.space.findUnique({ where: { id: space.id } })).resolves.toBeNull();
    await expect(db.bot.findUnique({ where: { id: bot.id } })).resolves.toBeNull();
  });

  it("keeps the Better Auth organization routes closed to product sessions", async () => {
    const cookie = await signup(app, `org-routes-${stamp}@rakazo.test`, "Org Routes");
    const actor = await rpc<Actor>(app, cookie, "me");
    const marker = await rpc<Space>(app, cookie, "spaces/create", { name: "Marker" });

    for (const route of ["delete", "leave", "update", "list"]) {
      const res = await app.request(`/api/auth/organization/${route}`, {
        method: route === "list" ? "GET" : "POST",
        headers: {
          ...(route === "list" ? {} : { "content-type": "application/json" }),
          cookie,
          origin: "http://127.0.0.1:5173",
        },
        body:
          route === "list"
            ? undefined
            : JSON.stringify({ organizationId: actor.spaceId, data: { name: "Renamed" } }),
      });
      expect(res.status, route).toBe(404);
    }

    await expect(
      handles.prisma.space.findMany({
        where: { id: { in: [actor.spaceId, marker.id] } },
        select: { id: true },
      }),
    ).resolves.toHaveLength(2);
    await expect(
      handles.prisma.member.count({ where: { userId: actor.userId } }),
    ).resolves.toBeGreaterThan(0);
    expect((await raw(app, cookie, "me")).status).toBe(200);
  });

  it("blocks bot creation after space deletion is claimed", async () => {
    const cookie = await signup(app, `space-race-${stamp}@rakazo.test`, "Space Race");
    const actor = await rpc<Actor>(app, cookie, "me");
    const space = await rpc<Space>(app, cookie, "spaces/create", { name: "Concurrent" });
    await asSystem(handles.prisma).computer.create({
      data: {
        spaceId: space.id,
        userId: actor.userId,
        scopeKey: `space-race-scope-${stamp}`,
        homeKey: `space-race-home-${stamp}`,
        kind: "fake",
        providerRef: `space-race-provider-${stamp}`,
      },
    });
    const deleteInput = {
      currentSpaceId: space.id,
      userId: actor.userId,
      spaceId: space.id,
    };
    // The procedures run these as a member of the Space being deleted.
    const asMember = <T>(fn: () => Promise<T>) =>
      runAsTenant({ spaceId: space.id, userId: actor.userId }, fn);

    const firstClaim = await asMember(() =>
      claimSpaceDeletionForMember(handles.prisma, deleteInput),
    );
    expect(firstClaim.recovered).toBe(false);
    expect(
      await asMember(() =>
        listClaimedSpaceComputers(handles.prisma, { ...deleteInput, claimId: firstClaim.claimId }),
      ),
    ).toEqual([expect.objectContaining({ providerRef: `space-race-provider-${stamp}` })]);
    await expect(
      asMember(() =>
        renewSpaceDeletionClaim(handles.prisma, { ...deleteInput, claimId: firstClaim.claimId }),
      ),
    ).resolves.toBe(true);
    const claimedNavigation = await rpc<SpaceNavigation>(app, cookie, "spaces/list", {}, space.id);
    expect(claimedNavigation.spaces.find((item) => item.id === space.id)).toMatchObject({
      canDelete: false,
      canRename: false,
    });
    await expect(
      raw(app, cookie, "spaces/rename", { spaceId: space.id, name: "Blocked" }, space.id),
    ).resolves.toMatchObject({ status: 409 });
    const blockedCreate = await raw(app, cookie, "bots/create", botInput("Racing bot"), space.id);
    expect(blockedCreate.ok).toBe(false);
    expect(blockedCreate.status).toBe(409);
    expect(await asSystem(handles.prisma).bot.count({ where: { spaceId: space.id } })).toBe(0);
    expect(
      await asSystem(handles.prisma).computer.findFirst({
        where: { spaceId: space.id },
        select: { providerRef: true },
      }),
    ).toEqual({ providerRef: `space-race-provider-${stamp}` });

    await handles.prisma.space.update({
      where: { id: space.id },
      data: { deletingAt: new Date(Date.now() - 6 * 60_000) },
    });
    const staleNavigation = await rpc<SpaceNavigation>(app, cookie, "spaces/list", {}, space.id);
    expect(staleNavigation.spaces.find((item) => item.id === space.id)).toMatchObject({
      canDelete: true,
      canRename: false,
    });
    await expect(
      raw(app, cookie, "spaces/rename", { spaceId: space.id, name: "Still blocked" }, space.id),
    ).resolves.toMatchObject({ status: 409 });
    await expect(
      handles.prisma.space.findUniqueOrThrow({ where: { id: space.id }, select: { name: true } }),
    ).resolves.toEqual({ name: "Concurrent" });
    const replacementClaim = await asMember(() =>
      claimSpaceDeletionForMember(handles.prisma, deleteInput),
    );
    expect(replacementClaim.recovered).toBe(true);
    await expect(
      asMember(() =>
        deleteClaimedSpaceForMember(handles.prisma, {
          ...deleteInput,
          claimId: firstClaim.claimId,
        }),
      ),
    ).rejects.toThrow("Space deletion is already in progress");
    await asMember(() =>
      releaseSpaceDeletionClaim(handles.prisma, { ...deleteInput, claimId: firstClaim.claimId }),
    );
    expect(
      await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletionClaimId: true },
      }),
    ).toEqual({ deletionClaimId: replacementClaim.claimId });
    await asMember(() =>
      releaseSpaceDeletionClaim(handles.prisma, {
        ...deleteInput,
        claimId: replacementClaim.claimId,
      }),
    );
    const created = await raw(app, cookie, "bots/create", botInput("After retry"), space.id);
    expect(created.ok).toBe(true);
  });

  it("keeps a space claimed after ambiguous sandbox teardown failure", async () => {
    const cookie = await signup(app, `space-teardown-${stamp}@rakazo.test`, "Teardown");
    const actor = await rpc<Actor>(app, cookie, "me");
    const space = await rpc<Space>(app, cookie, "spaces/create", { name: "Teardown" });
    await asSystem(handles.prisma).computer.create({
      data: {
        spaceId: space.id,
        userId: actor.userId,
        scopeKey: `space-teardown-scope-${stamp}`,
        homeKey: `space-teardown-home-${stamp}`,
        kind: "fake",
        providerRef: `space-teardown-provider-${stamp}`,
      },
    });
    const destroy = vi
      .spyOn(handles.sandbox, "destroy")
      .mockRejectedValueOnce(new Error("ambiguous provider failure"));

    try {
      const removed = await raw(app, cookie, "spaces/remove", { spaceId: space.id }, space.id);
      expect(removed.status).toBe(500);
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletingAt: true, deletionClaimId: true },
      });
      expect(lifecycle?.deletingAt).toBeInstanceOf(Date);
      expect(lifecycle?.deletionClaimId).toBeTruthy();
      expect(
        await asSystem(handles.prisma).computer.findFirst({
          where: { spaceId: space.id },
          select: { providerRef: true },
        }),
      ).toEqual({ providerRef: `space-teardown-provider-${stamp}` });
      const blockedCreate = await raw(
        app,
        cookie,
        "bots/create",
        botInput("Blocked after teardown"),
        space.id,
      );
      expect(blockedCreate.ok).toBe(false);
    } finally {
      destroy.mockRestore();
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletionClaimId: true },
      });
      if (lifecycle?.deletionClaimId) {
        await releaseSpaceDeletionClaim(handles.prisma, {
          currentSpaceId: space.id,
          spaceId: space.id,
          userId: actor.userId,
          claimId: lifecycle.deletionClaimId,
        });
      }
    }
  });

  it("times out a hung sandbox teardown without unblocking the space", async () => {
    const cookie = await signup(app, `space-deadline-${stamp}@rakazo.test`, "Deadline");
    const actor = await rpc<Actor>(app, cookie, "me");
    const space = await rpc<Space>(app, cookie, "spaces/create", { name: "Deadline" });
    await asSystem(handles.prisma).computer.create({
      data: {
        spaceId: space.id,
        userId: actor.userId,
        scopeKey: `space-deadline-scope-${stamp}`,
        homeKey: `space-deadline-home-${stamp}`,
        kind: "fake",
        providerRef: `space-deadline-provider-${stamp}`,
      },
    });
    process.env.SPACE_TEARDOWN_TIMEOUT_MS = "50";
    const destroy = vi
      .spyOn(handles.sandbox, "destroy")
      .mockImplementation(() => new Promise(() => undefined));

    try {
      const removed = await raw(app, cookie, "spaces/remove", { spaceId: space.id }, space.id);
      expect(removed.status).toBe(500);
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletingAt: true, deletionClaimId: true },
      });
      expect(lifecycle?.deletingAt).toBeInstanceOf(Date);
      expect(lifecycle?.deletionClaimId).toBeTruthy();
      const blockedCreate = await raw(
        app,
        cookie,
        "bots/create",
        botInput("Blocked during teardown"),
        space.id,
      );
      expect(blockedCreate.status).toBe(409);
    } finally {
      destroy.mockRestore();
      delete process.env.SPACE_TEARDOWN_TIMEOUT_MS;
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletionClaimId: true },
      });
      if (lifecycle?.deletionClaimId) {
        await releaseSpaceDeletionClaim(handles.prisma, {
          currentSpaceId: space.id,
          spaceId: space.id,
          userId: actor.userId,
          claimId: lifecycle.deletionClaimId,
        });
      }
    }
  });

  it("keeps compatible headers encrypted and out of DTOs across reconnects", async () => {
    const cookie = await signup(app, `model-headers-${stamp}@rakazo.test`, "Model Headers");
    const actor = await rpc<Actor>(app, cookie, "me");
    const connection = {
      provider: "openai-compatible",
      modelId: "arbitrary-model",
      baseUrl: "http://localhost:8000/v1",
    };
    const connected = await rpc<ModelCredential>(app, cookie, "models/connect", {
      ...connection,
      headers: { "x-session": "fake-session-secret" },
    });
    expect(connected.headerNames).toEqual(["x-session"]);
    expect(JSON.stringify(connected)).not.toContain("fake-session-secret");
    const credential = await db.userModelCredential.findUniqueOrThrow({
      where: { id: connected.id },
    });
    const secret = await db.secret.findUniqueOrThrow({
      where: { id: credential.secretId },
    });
    expect(secret.ciphertext).not.toContain("fake-session-secret");
    await rpc(app, cookie, "models/connect", connection);
    expect(
      await runAsTenant(actor, () =>
        handles.executor.resolveModel({ userId: actor.userId, spaceId: actor.spaceId }),
      ),
    ).toMatchObject({ headers: { "x-session": "fake-session-secret" } });
    const listed = await rpc<Array<ModelCredential>>(app, cookie, "models/credentials");
    expect(listed.find((row) => row.id === connected.id)?.headerNames).toEqual(["x-session"]);
    expect(JSON.stringify(listed)).not.toContain("fake-session-secret");
    await rpc(app, cookie, "models/connect", { ...connection, headers: {} });
    expect(
      await runAsTenant(actor, () =>
        handles.executor.resolveModel({ userId: actor.userId, spaceId: actor.spaceId }),
      ),
    ).toMatchObject({ headers: {} });
    const cleared = await rpc<Array<ModelCredential>>(app, cookie, "models/credentials");
    expect(cleared.find((row) => row.id === connected.id)?.headerNames).toEqual([]);
  });

  it("validates custom thinking against the saved connection capability", async () => {
    const cookie = await signup(app, `custom-thinking-${stamp}@rakazo.test`, "Custom Thinking");
    const bot = await rpc<Bot>(app, cookie, "bots/create", botInput("Thinking Bot"));
    const connection = {
      provider: "openai-compatible",
      modelId: "arbitrary-model",
      baseUrl: "http://localhost:8000/v1",
    };
    await rpc(app, cookie, "models/connect", {
      ...connection,
      apiKey: "fake-saved-key",
      reasoning: false,
    });
    await rpc(app, cookie, "models/connect", { ...connection, reasoning: true });
    const actor = await rpc<Actor>(app, cookie, "me");
    expect(
      await runAsSystem("background job run.continue", () =>
        handles.executor.resolveModel({
          userId: actor.userId,
          spaceId: actor.spaceId,
          botId: bot.id,
        }),
      ),
    ).toMatchObject({ apiKey: "fake-saved-key", reasoning: true });
    const update = {
      botId: bot.id,
      modelProvider: connection.provider,
      modelId: connection.modelId,
    };
    expect(
      await rpc(app, cookie, "bots/update", { ...update, thinkingLevel: "low" }),
    ).toMatchObject({ thinkingLevel: "low" });
    expect(
      await rpc(app, cookie, "bots/update", { ...update, thinkingLevel: "xhigh" }),
    ).toMatchObject({ thinkingLevel: "xhigh" });
    expect(
      await rpc(app, cookie, "bots/update", { ...update, thinkingLevel: "max" }),
    ).toMatchObject({ thinkingLevel: "max" });
    await rpc(app, cookie, "models/connect", { ...connection, reasoning: false });
    expect(
      (await raw(app, cookie, "bots/update", { ...update, thinkingLevel: "low" })).status,
    ).toBe(400);
    expect(
      (await raw(app, cookie, "bots/update", { ...update, thinkingLevel: "xhigh" })).status,
    ).toBe(400);
    expect(
      await rpc(app, cookie, "bots/update", { ...update, thinkingLevel: "off" }),
    ).toMatchObject({ thinkingLevel: "off" });
  });

  it("validates per-bot model overrides against connected providers and catalog", async () => {
    const cookie = await signup(app, `bot-model-${stamp}@rakazo.test`, "Bot Model");
    const bot = await rpc<
      Bot & {
        modelProvider: string | null;
        modelId: string | null;
        thinkingLevel: string | null;
      }
    >(app, cookie, "bots/create", botInput("Model Bot"));
    await rpc(app, cookie, "models/connect", {
      provider: "xai",
      apiKey: "fake-xai-key-not-real",
      label: "xAI",
      modelId: "grok-4.6",
    });

    const updated = await rpc<
      Bot & {
        modelProvider: string | null;
        modelId: string | null;
        thinkingLevel: string | null;
      }
    >(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: "high",
    });
    expect(updated).toMatchObject({
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: "high",
    });

    const unknown = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "xai",
      modelId: "not-a-real-grok",
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(await unknown.text()).toMatch(/unknown model/i);

    const disconnected = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    expect(disconnected.status).toBeGreaterThanOrEqual(400);
    expect(await disconnected.text()).toMatch(/connect/i);

    const partialClear = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelId: null,
    });
    expect(partialClear.status).toBeGreaterThanOrEqual(400);
    expect(await partialClear.text()).toMatch(/both be set or both cleared/i);
  });

  it("binds a new default to the space preference credential, not a newer unused duplicate", async () => {
    const cookie = await signup(app, `model-duplicates-${stamp}@rakazo.test`, "Model Duplicates");
    const actor = await rpc<Actor>(app, cookie, "me");
    const olderSecret = await db.secret.create({
      data: {
        userId: actor.userId,
        spaceId: null,
        kind: "model",
        ciphertext: "encrypted-older-key",
      },
    });
    const newerSecret = await db.secret.create({
      data: {
        userId: actor.userId,
        spaceId: null,
        kind: "model",
        ciphertext: "encrypted-newer-key",
      },
    });
    const older = await db.userModelCredential.create({
      data: {
        userId: actor.userId,
        provider: "duplicate-provider",
        label: "Older",
        secretId: olderSecret.id,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    });
    const newer = await db.userModelCredential.create({
      data: {
        userId: actor.userId,
        provider: "duplicate-provider",
        label: "Newer",
        secretId: newerSecret.id,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-02T00:00:00.000Z"),
      },
    });
    await db.userModelPreference.create({
      data: { userId: actor.userId, credentialId: older.id, modelId: "older/model" },
    });

    await rpc(app, cookie, "models/setDefault", {
      provider: "duplicate-provider",
      modelId: "newer/selected",
    });

    const preferences = await db.userModelPreference.findMany({
      where: { userId: actor.userId },
    });
    const main = await rpc<ModelRoleSettings>(app, cookie, "models/role", { role: "main" });
    expect(main.primary).toMatchObject({ modelId: "newer/selected", credentialId: older.id });
    expect(preferences.find((row) => row.credentialId === older.id)).toMatchObject({
      modelId: "newer/selected",
    });
    expect(preferences.find((row) => row.credentialId === newer.id)).toBeUndefined();
    const listed = await rpc<ModelCredential[]>(app, cookie, "models/credentials");
    expect(
      listed.filter((row) => row.provider === "duplicate-provider").map((row) => row.id),
    ).toEqual([newer.id, older.id]);
  });

  it("never hands out session tokens and asks for the password before account deletion", async () => {
    const email = `sessions-${stamp}@rakazo.test`;
    const cookie = await signup(app, email, "Sessions");
    const second = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12" }),
    });
    const { token } = (await second.json()) as { token: string };
    expect(token).toEqual(expect.any(String));

    const listed = await app.request("/api/auth/list-sessions", { headers: { cookie } });
    expect(listed.status).toBe(200);
    const text = await listed.text();
    const sessions = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(2);
    for (const session of sessions) expect(session).not.toHaveProperty("token");
    expect(text).not.toContain(token);
    const current = (await (
      await app.request("/api/auth/get-session", { headers: { cookie } })
    ).json()) as { session: Record<string, unknown> };
    expect(current.session).not.toHaveProperty("token");

    const deleted = await app.request("/api/auth/delete-user", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({}),
    });
    expect(deleted.status).toBe(400);
    expect(await handles.prisma.user.findUnique({ where: { email } })).not.toBeNull();
  });

  it("shows an organization's audit log only to its owners and admins, past deleted spaces", async () => {
    const owner = await signup(app, `audit-owner-${stamp}@rakazo.test`, "Audit Owner");
    const outsider = await signup(app, `audit-outsider-${stamp}@rakazo.test`, "Audit Outsider");
    const account = await rpc<Actor>(app, owner, "me");
    const space = await rpc<Space>(app, owner, "spaces/create", { name: "Client A" });
    await rpc(app, owner, "spaces/remove", { spaceId: space.id });

    type Page = { events: Array<{ action: string; spaceName: string | null }> };
    const actions = (page: Page) => page.events.map((event) => event.action);
    const ownLog = await rpc<Page>(app, owner, "audit/events", { spaceId: space.id });
    expect(actions(ownLog)).toEqual(["space.deleted", "space.created"]);
    expect(ownLog.events[0]?.spaceName).toBe("Client A");
    expect(actions(await rpc<Page>(app, outsider, "audit/events", { spaceId: space.id }))).toEqual(
      [],
    );
    const exported = await app.request("/api/audit-events/export", { headers: { cookie: owner } });
    expect(exported.status).toBe(200);
    expect(await exported.text()).toContain('"action":"space.created"');

    await db.member.updateMany({ where: { userId: account.userId }, data: { role: "member" } });
    await expectForbidden(app, owner, "audit/events", {});
    expect(
      (await app.request("/api/audit-events/export", { headers: { cookie: owner } })).status,
    ).toBe(403);
  });

  it("denies server administration to every app account, including a stored former owner", async () => {
    const formerOwner = await signup(app, `former-owner-${stamp}@rakazo.test`, "Test Account");
    const other = await signup(app, `ordinary-${stamp}@rakazo.test`, "Other Account");
    const account = await rpc<Actor>(app, formerOwner, "me");
    await handles.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: account.userId },
    });
    for (const cookie of [formerOwner, other]) {
      expect((await rpc<Actor>(app, cookie, "me")).isDeploymentOwner).toBe(false);
      await expectForbidden(app, cookie, "deployment/get", {});
      await expectForbidden(app, cookie, "deployment/update", { signupsEnabled: false });
      await expectForbidden(app, cookie, "security/events", {});
      await expectForbidden(app, cookie, "updater/status", {});
      await expectForbidden(app, cookie, "updater/check", {});
      await expectForbidden(app, cookie, "updater/apply", {});
      await expectForbidden(app, cookie, "integrationSetup/save", {
        provider: "composio",
        apiKey: "fake-key",
      });
    }
    expect(
      await handles.prisma.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } }),
    ).toMatchObject({ signupsEnabled: true, signupAllowlist: "" });
  });
});

function botInput(name: string) {
  return {
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  };
}

function routineInput(botId: string) {
  return {
    botId,
    name: "Owner Routine",
    prompt: "owner-only prompt",
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    notify: false,
    active: false,
  };
}

function skillPlaybookInput() {
  return {
    whenToUse: "When needed",
    inputs: ["example"],
    steps: ["Do the thing"],
    howToCheck: "Verify result",
    whatToReturn: "Summary",
    approvalBoundaries: "Ask first",
    failureHandling: "Stop and ask",
  };
}

function capabilityInput(name: string) {
  return { kind: "skill", name, source: "test://authorization", config: {} };
}

function connectionInput(displayName: string) {
  return { provider: "SLACK", displayName };
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (response.status >= 400) {
    throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  }
  return sessionCookieHeader(response);
}

async function phoneSession(app: App, email: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://" },
    body: JSON.stringify({ email, password: "password12", name: "Phone" }),
  });
  const { token, user } = (await response.json()) as { token: string; user: { id: string } };
  const cookie = sessionCookieHeader(response);
  const headers = { origin: "rakazo://", authorization: `Bearer ${token}` };
  const me = async () =>
    (
      await app.request("/rpc/me", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      })
    ).status;
  const setAuthToken = response.headers.get("set-auth-token") ?? "";
  return { headers, me, cookie, userId: user.id, token, setAuthToken };
}

async function signin(app: App, email: string, password = "password12") {
  return sessionCookieHeader(await authPost(app, "", "/sign-in/email", { email, password }));
}

async function authPost(app: App, cookie: string, path: string, body: unknown = {}) {
  const response = await app.request(`/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify(body),
  });
  if (response.status >= 400) {
    throw new Error(`${path} failed ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function raw(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body ?? {} }),
  });
}

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const response = await raw(app, cookie, procedure, body, spaceId);
  const text = await response.text();
  const payload = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || payload.error) {
    throw new Error(`${procedure} ${response.status}: ${payload.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(botIntroHarness, cookie, procedure, payload.json as T);
}

async function expectDenied(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown,
  spaceId?: string,
) {
  const response = await raw(app, cookie, procedure, body, spaceId);
  if (procedure === "threads/subscribe" && response.status === 200) {
    // Streaming transports commit the HTTP 200 before advancing the async iterator. The
    // ownership error is therefore encoded in the iterator response instead of the status.
    expect(await response.text(), procedure).toMatch(/error|forbidden|not.found|unauthorized/i);
    return;
  }
  expect(response.status, procedure).toBeGreaterThanOrEqual(400);
}

async function expectForbidden(app: App, cookie: string, procedure: string, body: unknown) {
  const response = await raw(app, cookie, procedure, body);
  expect(response.status, procedure).toBe(403);
  expect(await response.text(), procedure).toMatch(/forbidden/i);
}

interface Actor {
  userId: string;
  spaceId: string;
  isDeploymentOwner: boolean;
}

interface ModelRoleSettings {
  primary: { provider: string; modelId: string; credentialId?: string } | null;
}

interface ModelCredential {
  headerNames?: string[];
  id: string;
  provider: string;
  label: string;
  hasKey: boolean;
  isDefault: boolean;
}

interface Bot {
  id: string;
  name: string;
}

function exhaustiveProtectedCalls<
  const Calls extends ReadonlyArray<readonly [ProtectedRpcPath, unknown?]>,
>(calls: Calls & (ProtectedRpcPath extends Calls[number][0] ? unknown : never)): Calls {
  return calls;
}
