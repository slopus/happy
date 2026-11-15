import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  aiRecipient,
  cloudAgentForActor,
  cloudAgentsEnabled,
  cloudAgentsForActor,
  parseModelSecret,
  resolveMemberMainModel,
  selectConfiguredModel,
  toStringRecord,
} from "@rakazo/adapters";
import type {
  Actor,
  AiConsentQuery,
  AiConsentStatus,
  AiRecipient,
  SettingsScope,
} from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION, AI_PRIVACY_URL } from "@rakazo/contracts";
import {
  findDefaultVoiceCredential,
  findModelCredential,
  findModelCredentialById,
  listModelRoleChoices,
  listVoicePreferences,
  modelRoleTarget,
  voicePreferenceTarget,
} from "@rakazo/db";
import type { RouterDeps } from "./router.js";
import { resolveThreadTarget } from "./thread-target.js";
import { voiceCredentialServer } from "./voice.js";

export async function aiConsentStatus(
  deps: RouterDeps,
  actor: Actor,
  query: AiConsentQuery = {},
): Promise<AiConsentStatus> {
  const uses = query.uses ?? ["model", "memory", "voice"];
  const modelsEnabled = uses.includes("model") && deps.env.agentRuntime !== "scripted";
  const target =
    query.botId || query.groupId ? await resolveThreadTarget(deps.prisma, actor, query) : null;
  const botIds = target
    ? target.kind === "bot"
      ? [target.botId]
      : target.memberBotIds
    : undefined;
  const [preferences, roleChoices, main, bots, routines, voices, memory, settings, consents] =
    await Promise.all([
      modelsEnabled
        ? deps.prisma.userModelPreference.findMany({
            where: { userId: actor.userId },
            include: { credential: true },
          })
        : [],
      modelsEnabled
        ? modelRoleTarget(deps.prisma, actor).then((roles) =>
            listModelRoleChoices(deps.prisma, roles),
          )
        : [],
      modelsEnabled
        ? resolveMemberMainModel({ prisma: deps.prisma, secretStore: deps.secrets }, actor)
        : null,
      modelsEnabled
        ? // Any bot in the space runs on this member's credentials when they message it.
          deps.prisma.bot.findMany({
            where: {
              spaceId: actor.spaceId,
              archivedAt: null,
              ...(botIds ? { id: { in: botIds } } : {}),
            },
            select: { modelProvider: true, modelId: true, thinkingLevel: true },
          })
        : [],
      // An active routine with its own model is another recipient for this bot.
      // A paused routine is included only when this check is for that routine,
      // so it does not block an ordinary chat message.
      modelsEnabled
        ? deps.prisma.routine.findMany({
            where: {
              userId: actor.userId,
              spaceId: actor.spaceId,
              modelProvider: { not: null },
              modelId: { not: null },
              bot: { archivedAt: null },
              ...(botIds ? { botId: { in: botIds } } : {}),
              OR: query.routineId
                ? [{ active: true }, { id: query.routineId }]
                : [{ active: true }],
            },
            select: { modelProvider: true, modelId: true, thinkingLevel: true },
          })
        : [],
      uses.includes("voice")
        ? query.uses
          ? findDefaultVoiceCredential(deps.prisma, actor, query.settingsScope).then(
              (credential) => (credential ? [{ credential }] : []),
            )
          : voicePreferenceTarget(deps.prisma, actor, query.settingsScope).then((target) =>
              listVoicePreferences(deps.prisma, target),
            )
        : [],
      uses.includes("memory")
        ? deps.prisma.spaceMemoryConfig.findUnique({ where: { spaceId: actor.spaceId } })
        : null,
      modelsEnabled
        ? deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } })
        : null,
      deps.prisma.aiDataConsent.findMany({
        where: { userId: actor.userId, spaceId: actor.spaceId, version: AI_DISCLOSURE_VERSION },
      }),
    ]);
  const allowed = new Set(consents.map((row) => row.recipientKey));
  const recipients = new Map<string, AiRecipient>();
  const add = (recipient: ReturnType<typeof aiRecipient>) => {
    if (recipient)
      recipients.set(recipient.key, { ...recipient, allowed: allowed.has(recipient.key) });
  };
  if (modelsEnabled) {
    const deployment = deps.env.deploymentModelConfigured
      ? { provider: deps.env.defaultProvider, model: deps.env.defaultModel }
      : null;
    const selected = await Promise.all(
      (target ? [...bots, ...routines] : [null, ...bots, ...routines]).map(async (override) => {
        const overrideCredential =
          override?.modelProvider && override.modelId
            ? await findModelCredential(
                deps.prisma,
                actor,
                override.modelProvider,
                override.modelId,
              )
            : null;
        return selectConfiguredModel({
          override,
          overrideCredential,
          main,
          hostedProvider: deps.billing?.modelCreditsEnabled ? deps.env.defaultProvider : undefined,
          defaults: { settings, deployment },
        });
      }),
    );
    // Connected models remain reachable by helpers during a targeted bot run.
    for (const preference of preferences)
      selected.push({
        provider: preference.credential.provider,
        id: preference.modelId ?? "",
        credential: {
          ...preference.credential,
          defaultModel: preference.modelId,
          thinkingLevel: preference.thinkingLevel,
        },
        thinkingLevel: null,
      });
    // Every purpose's models, fallbacks included, can receive a run's content.
    const roleModels = await Promise.all(
      roleChoices.map(async (choice) => {
        const credential = choice.credentialId
          ? await findModelCredentialById(deps.prisma, actor, choice.credentialId)
          : await findModelCredential(deps.prisma, actor, choice.provider, choice.modelId);
        return credential
          ? { provider: choice.provider, id: choice.modelId, credential, thinkingLevel: null }
          : null;
      }),
    );
    selected.push(...roleModels.filter((model) => model !== null));
    if (deps.env.teamChatJudgeProvider && deps.env.teamChatJudgeModel) {
      selected.push({
        provider: deps.env.teamChatJudgeProvider,
        id: deps.env.teamChatJudgeModel,
        credential: await findModelCredential(
          deps.prisma,
          actor,
          deps.env.teamChatJudgeProvider,
          deps.env.teamChatJudgeModel,
        ),
        thinkingLevel: null,
      });
    }
    const models = [
      ...new Map(
        selected
          .filter((model) => model.provider)
          .map((model) => [
            JSON.stringify([model.provider, model.id, model.credential?.secretId]),
            model,
          ]),
      ).values(),
    ];
    const secrets = models.length
      ? await deps.prisma.secret.findMany({
          where: {
            userId: actor.userId,
            spaceId: null,
            id: {
              in: models.flatMap((model) => (model.credential ? [model.credential.secretId] : [])),
            },
          },
        })
      : [];
    const baseUrls = new Map(
      await Promise.all(
        secrets.map(async (secret): Promise<[string, string | undefined]> => {
          try {
            const parsed = parseModelSecret(await deps.secrets.load(secret.ciphertext, secret.id));
            return [secret.id, parsed.kind === "openai_compatible" ? parsed.baseUrl : undefined];
          } catch {
            // Unreadable credentials still disclose by provider; the base URL is unknown.
            return [secret.id, undefined];
          }
        }),
      ),
    );
    for (const model of models) {
      add(
        aiRecipient({
          provider: model.provider!,
          modelId: model.id!,
          baseUrl: model.credential ? baseUrls.get(model.credential.secretId) : undefined,
          use: "model",
        }),
      );
    }
  }
  for (const voice of voices) {
    // A self-hosted server is disclosed by its own origin, like a custom model endpoint.
    const endpoint = (await voiceCredentialServer(deps, actor, voice.credential))?.endpoint;
    add(
      aiRecipient({
        provider: voice.credential.provider,
        use: "voice",
        ...(endpoint ? { baseUrl: endpoint } : {}),
      }),
    );
  }
  if (memory)
    add(
      aiRecipient({
        provider: memory.provider,
        use: "memory",
        baseUrl: toStringRecord(memory.settings).baseUrl,
      }),
    );
  // Each target agent's own connection and the deployment's, which takes over once that one
  // stops answering; without a target, every one any agent may use, so allowing what a
  // targeted check showed always finds it.
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  const cloudAgents = !uses.includes("model")
    ? []
    : botIds
      ? [
          ...(await Promise.all(
            botIds.map((botId) => cloudAgentForActor(deps, { ...owner, botIds: [botId] })),
          )),
          cloudAgentsEnabled(deps.cloudAgent, actor.spaceId) ? deps.cloudAgent : null,
        ]
      : await cloudAgentsForActor(deps, owner);
  for (const cloudAgent of cloudAgents) {
    if (!cloudAgent || cloudAgent.provider.describe().capabilities.offline) continue;
    add(
      aiRecipient({
        provider: cloudAgent.provider.describe().id,
        use: "model",
        baseUrl: cloudAgent.baseUrl,
      }),
    );
  }
  return {
    scope: createHash("sha256")
      .update(JSON.stringify([actor.userId, actor.spaceId]))
      .digest("hex"),
    version: AI_DISCLOSURE_VERSION,
    privacyUrl: deps.env.privacyPolicyUrl ?? AI_PRIVACY_URL,
    recipients: [...recipients.values()],
  };
}

export async function allowAiConsent(
  deps: RouterDeps,
  actor: Actor,
  input: { scope: string; version: string; keys: string[]; settingsScope?: SettingsScope },
) {
  // Checked against the same settings copy the member reviewed.
  const current = await aiConsentStatus(
    deps,
    actor,
    input.settingsScope ? { settingsScope: input.settingsScope } : {},
  );
  const known = new Set(current.recipients.map((recipient) => recipient.key));
  if (
    input.scope !== current.scope ||
    input.version !== current.version ||
    input.keys.some((key) => !known.has(key))
  ) {
    throw new ORPCError("CONFLICT", { message: "AI data sharing changed. Review it again." });
  }
  // Interactive rather than a batch: a batch cannot carry the request's database context.
  await deps.prisma.$transaction(async (tx) => {
    for (const recipientKey of input.keys)
      await tx.aiDataConsent.upsert({
        where: {
          userId_spaceId_recipientKey: {
            userId: actor.userId,
            spaceId: actor.spaceId,
            recipientKey,
          },
        },
        create: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          recipientKey,
          version: current.version,
        },
        update: { version: current.version, grantedAt: new Date() },
      });
  });
  return {
    ...current,
    recipients: current.recipients.map((recipient) =>
      input.keys.includes(recipient.key) ? { ...recipient, allowed: true } : recipient,
    ),
  };
}
