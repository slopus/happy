import { ORPCError } from "@orpc/server";
import {
  isSignInRetryRequest,
  isTransientModelError,
  SecretStoreUnavailableError,
} from "@rakazo/adapter-kit";
import type { PiOAuthPersist } from "@rakazo/adapters";
import {
  compatibleEndpointPreset,
  listPiCatalog,
  ModelSignInError,
  modelCredentialDto,
  oauthCredentialEmail,
  prepareStoredModelAuth,
  probeCatalogProviderModels,
  probeOpenAiCompatibleModels,
  providerCatalogCache,
  resolveMemberMainModel,
  selectDefaultCredentialId,
  serializeModelSecret,
  storedOpenAiCompatibleProbeHeaders,
  storedOpenAiCompatibleProbeKey,
  UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
} from "@rakazo/adapters";
import type { Actor, ModelCredential, ThinkingLevel } from "@rakazo/contracts";
import {
  backupChoiceKey,
  canonicalPiProviderId,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  usableModelId,
} from "@rakazo/contracts";
import { clampCatalogThinkingLevel } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appliedModelRole,
  comparePreferenceOrder,
  defaultModelCredentialCandidates,
  deleteUnreferencedCredentialSecret,
  findModelCredential,
  getModelRole,
  modelCredentialProviderFilter,
  modelRoleTarget,
  newestModelCredentialOrder,
  Prisma,
  runAsSystemInTransaction,
  saveModelPreference,
  updateModelRole,
  withTransactionRetry,
  writeModelRole,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { markExpectedFailure } from "@rakazo/logging/hono";
import { mayUsePrivateEndpoint } from "../mcp-servers.js";
import { firstModelConnectAnalytics } from "../model-connect-analytics.js";
import {
  modelConnectionTarget,
  persistModelCredential,
  prepareAllowedThinkingLevels,
  throwIfAborted,
} from "../model-credentials.js";
import { assertCompatibleDefaultChange } from "../model-pins.js";
import type { RouterContext } from "./context.js";

export function modelsRoutes(ctx: RouterContext) {
  const {
    deps,
    codexCatalog,
    connectModelCredential,
    refreshExpiredCredential,
    chatCatalog,
    withDeploymentDefault,
    withImageInput,
    modelRoleCatalog,
    validateRoleChoices,
    authed,
  } = ctx;
  const saveSignIn =
    (actor: Actor): PiOAuthPersist<ModelCredential> =>
    async (login) => {
      try {
        // Read before the save: it only counts a member's first connection.
        const record = await firstModelConnectAnalytics(deps, actor, "oauth");
        const target = await modelConnectionTarget(deps, actor, login.provider, login.credentialId);
        const saved = await persistModelCredential(
          deps,
          actor,
          {
            provider: login.provider,
            credentialId: target?.id ?? null,
            plaintext: serializeModelSecret({ kind: "oauth", credential: login.credential }),
            // A second account is told apart by the email it signed in with.
            label:
              oauthCredentialEmail(login.credential) ??
              login.label ??
              listPiCatalog().find((entry) => entry.provider === login.provider)?.providerName,
            modelId: login.modelId,
            thinkingLevel: login.thinkingLevel,
            makeDefault: login.makeDefault,
            scope: login.settingsScope,
            signal: login.signal,
          },
          codexCatalog,
        );
        record(login.provider, { name: "model_connected" });
        return saved;
      } catch (error) {
        // The member is told why a save was refused; anything else is reported generically.
        if (error instanceof ORPCError) throw new ModelSignInError(error.message);
        throw error;
      }
    };
  return {
    models: {
      list: authed.models.list.handler(async ({ context }) => chatCatalog(context.actor)),
      credentials: authed.models.credentials.handler(async ({ context }) => {
        const [rows, main] = await Promise.all([
          deps.prisma.userModelCredential.findMany({
            where: { userId: context.actor.userId },
            include: { userPreferences: { where: { userId: context.actor.userId } } },
            orderBy: newestModelCredentialOrder,
          }),
          resolveMemberMainModel({ prisma: deps.prisma, secretStore: deps.secrets }, context.actor),
        ]);
        const secrets = rows.length
          ? await deps.prisma.secret.findMany({
              where: {
                id: { in: rows.map((row) => row.secretId) },
                userId: context.actor.userId,
                spaceId: null,
              },
              select: { id: true, ciphertext: true },
            })
          : [];
        const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
        const preferenceRanks = new Map(
          rows
            .flatMap((row) => row.userPreferences)
            .sort(comparePreferenceOrder)
            .map((preference, index) => [preference.credentialId, index]),
        );
        return Promise.all(
          rows.map(async ({ userPreferences, ...row }) => {
            const preference = userPreferences[0];
            const own = {
              ...row,
              defaultModel: preference?.modelId ?? null,
              thinkingLevel: preference?.thinkingLevel ?? null,
            };
            const runsMain = main?.credential && main.credential.id === row.id;
            const dto = (plaintext?: string) => {
              const listed = modelCredentialDto(own, plaintext);
              // The connection running the main model shows that model, as apps read it,
              // while its own model stays enabled.
              const shown = runsMain
                ? modelCredentialDto(
                    {
                      ...row,
                      isDefault: true,
                      defaultModel: main.modelId,
                      thinkingLevel: main.thinkingLevel ?? null,
                    },
                    plaintext,
                  )
                : listed;
              return {
                ...shown,
                ...(shown.enabledModelIds
                  ? {
                      enabledModelIds: [
                        ...new Set([...shown.enabledModelIds, ...(listed.enabledModelIds ?? [])]),
                      ],
                    }
                  : {}),
                ...(preference
                  ? { preferenceRank: preferenceRanks.get(preference.credentialId) }
                  : {}),
              };
            };
            const ciphertext = ciphertextById.get(row.secretId);
            if (!ciphertext) return dto();
            try {
              return dto(await deps.secrets.load(ciphertext, row.secretId));
            } catch (error) {
              if (error instanceof SecretStoreUnavailableError)
                throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
              return dto();
            }
          }),
        );
      }),
      forRole: authed.models.forRole.handler(async ({ context, input }) =>
        modelRoleCatalog(context.actor, input.role),
      ),
      role: authed.models.role.handler(async ({ context, input }) => {
        if (input.expectedUserId && input.expectedUserId !== context.actor.userId)
          throw new ORPCError("FORBIDDEN");
        return withImageInput(
          context.actor,
          input.role,
          await withDeploymentDefault(
            input.role,
            await getModelRole(
              deps.prisma,
              await modelRoleTarget(deps.prisma, context.actor, input.scope),
              input.role,
            ),
          ),
        );
      }),
      setRole: authed.models.setRole.handler(async ({ context, input }) => {
        if (input.expectedUserId && input.expectedUserId !== context.actor.userId)
          throw new ORPCError("FORBIDDEN");
        const { role, primary, backups, scope } = input;
        await validateRoleChoices(context.actor, role, [
          ...(primary ? [primary] : []),
          ...(backups ?? []),
        ]);
        return withImageInput(
          context.actor,
          role,
          await withDeploymentDefault(
            role,
            await updateModelRole(
              deps.prisma,
              { userId: context.actor.userId, spaceId: context.actor.spaceId, scope },
              role,
              { primary, backups },
            ),
          ),
        );
      }),
      backups: authed.models.backups.handler(async ({ context }) =>
        (await appliedModelRole(deps.prisma, context.actor, "main")).backups.map(
          ({ provider, modelId }) => ({ provider, modelId }),
        ),
      ),
      setBackups: authed.models.setBackups.handler(async ({ context, input }) => {
        await validateRoleChoices(context.actor, "main", input);
        await updateModelRole(
          deps.prisma,
          { userId: context.actor.userId, spaceId: context.actor.spaceId },
          "main",
          { backups: input },
        );
        return { ok: true as const };
      }),
      connect: authed.models.connect.handler(async ({ context, input }) => {
        const record = await firstModelConnectAnalytics(deps, context.actor, "api_key");
        record(input.provider, { name: "model_connect_started" });
        try {
          const saved = await connectModelCredential(context.actor, input, context.signal);
          record(input.provider, { name: "model_connected" });
          return saved;
        } catch (error) {
          record(input.provider, { name: "model_connect_failed", error });
          throw error;
        }
      }),
      probeOpenAiCompatible: authed.models.probeOpenAiCompatible.handler(
        async ({ context, input }) => {
          let apiKey = input.apiKey;
          let headers = input.headers;
          if (!apiKey?.trim() || headers === undefined) {
            try {
              const preferred = await findModelCredential(
                deps.prisma,
                context.actor,
                OPENAI_COMPATIBLE_PROVIDER_ID,
              );
              const credentials = await deps.prisma.userModelCredential.findMany({
                where: { userId: context.actor.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              });
              const candidates = input.credentialId
                ? credentials.filter((credential) => credential.id === input.credentialId)
                : preferred
                  ? [
                      preferred,
                      ...credentials.filter((credential) => credential.id !== preferred.id),
                    ]
                  : credentials;
              const secrets = await deps.prisma.secret.findMany({
                where: {
                  id: { in: candidates.map((credential) => credential.secretId) },
                  userId: context.actor.userId,
                  spaceId: null,
                },
                select: { id: true, ciphertext: true },
              });
              const ciphertexts = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
              for (const credential of candidates) {
                const ciphertext = ciphertexts.get(credential.secretId);
                if (!ciphertext) continue;
                try {
                  const plaintext = await deps.secrets.load(ciphertext, credential.secretId);
                  const savedKey = storedOpenAiCompatibleProbeKey(input.baseUrl, plaintext);
                  const savedHeaders = storedOpenAiCompatibleProbeHeaders(input.baseUrl, plaintext);
                  if (!savedKey && savedHeaders === undefined) continue;
                  // A saved key and its routing headers are one credential. Explicit
                  // replacements may override either field, but never borrow from another row.
                  if (!apiKey?.trim()) apiKey = savedKey;
                  headers ??= savedHeaders;
                  break;
                } catch {
                  // An unreadable secret must not prevent trying the remaining credentials.
                }
              }
            } catch {
              // An unavailable saved key must not prevent a keyless probe.
            }
          }
          try {
            const models = await probeOpenAiCompatibleModels(
              { ...input, apiKey, headers },
              compatibleEndpointPreset(input.baseUrl) ? deps.modelConnectionFetch : undefined,
              context.signal,
              { allowPrivate: mayUsePrivateEndpoint(deps) },
            );
            return { models };
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not list models",
            });
          }
        },
      ),
      probeCatalog: authed.models.probeCatalog.handler(async ({ context, input }) => {
        try {
          const models = await probeCatalogProviderModels(
            { provider: input.provider, apiKey: input.apiKey },
            deps.modelConnectionFetch,
            context.signal,
          );
          return { models };
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Could not list models",
          });
        }
      }),
      beginOAuth: authed.models.beginOAuth.handler(async ({ context, input }) => {
        // An older app's sign-in renews the provider's newest connection, bound now so a
        // disconnect of that connection retires it and it never lands on another one.
        const target = await modelConnectionTarget(
          deps,
          context.actor,
          input.provider,
          input.credentialId,
        );
        const record = await firstModelConnectAnalytics(deps, context.actor, "oauth");
        record(input.provider, { name: "model_connect_started" });
        return deps.oauthLogins
          .begin({
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            provider: input.provider,
            credentialId: target?.id ?? null,
            modelId: input.modelId,
            thinkingLevel: input.thinkingLevel,
            makeDefault: input.makeDefault,
            settingsScope: input.scope,
            label: input.label,
            codePage: input.codePage,
            signal: context.signal,
            persist: saveSignIn(context.actor),
          })
          .catch((error: unknown) => {
            record(input.provider, { name: "model_connect_failed", error });
            // The provider's sign-in service is down or overloaded; the user tries again later.
            if (isTransientModelError(error) || isSignInRetryRequest(error)) {
              getLogger().warn("rpc models/beginOAuth provider unavailable", {
                reason: error instanceof Error ? error.message : String(error),
              });
              markExpectedFailure();
              throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
            }
            throw error;
          });
      }),
      submitOAuthCode: authed.models.submitOAuthCode.handler(async ({ context, input }) => {
        return deps.oauthLogins
          .submit(input.loginId, context.actor, input.code, saveSignIn(context.actor))
          .catch((error: unknown) => {
            if (error instanceof ModelSignInError)
              throw new ORPCError("BAD_REQUEST", { message: error.message, cause: error });
            throw error;
          });
      }),
      completeOAuth: authed.models.completeOAuth.handler(async ({ context, input }) => {
        const result = await deps.oauthLogins.complete(input.loginId, context.actor);
        if (result.status === "error") {
          const record = await firstModelConnectAnalytics(deps, context.actor, "oauth");
          record(result.provider, { name: "model_connect_failed", error: new Error(result.error) });
          return { status: "error" as const, error: result.error };
        }
        return result.status === "connected" ? { status: "ready" as const } : result;
      }),
      finishOAuth: authed.models.finishOAuth.handler(async ({ context, input }) => {
        throwIfAborted(context.signal);
        const result = await deps.oauthLogins.finish(input.loginId, context.actor);
        if (result.status === "pending") {
          throw new ORPCError("CONFLICT", { message: "Sign-in has not finished yet." });
        }
        if (result.status === "error") {
          const record = await firstModelConnectAnalytics(deps, context.actor, "oauth");
          record(result.provider, { name: "model_connect_failed", error: new Error(result.error) });
          throw new ORPCError("NOT_FOUND", { message: result.error });
        }
        // The save already counted the connection.
        return result.value;
      }),
      cancelOAuth: authed.models.cancelOAuth.handler(async ({ context, input }) => {
        await deps.oauthLogins.cancel(input.loginId, context.actor);
        return { ok: true as const };
      }),
      setDefault: authed.models.setDefault.handler(async ({ context, input }) => {
        const modelId = usableModelId(input.modelId);
        if (!modelId) throw new ORPCError("BAD_REQUEST", { message: "Choose a model" });
        // An omitted level keeps the one this model already has in the main list: on the
        // chosen connection first, then on another, as writeModelRole does.
        const savedChoices = async (
          client: Pick<
            PrismaClient,
            "spaceModelRoleChoice" | "userModelRoleChoice" | "spaceSettingOverride"
          >,
        ) => {
          const main = await appliedModelRole(client, context.actor, "main");
          const key = backupChoiceKey({ provider: input.provider, modelId });
          return [...(main.primary ? [main.primary] : []), ...main.backups].filter(
            (choice) => backupChoiceKey(choice) === key,
          );
        };
        const loadModelState = async (
          client: Pick<PrismaClient, "userModelPreference" | "userModelCredential">,
        ) => {
          const [preferences, credentials] = await Promise.all([
            client.userModelPreference.findMany({
              where: {
                userId: context.actor.userId,
                credential: { provider: modelCredentialProviderFilter(input.provider) },
              },
              include: { credential: true },
            }),
            client.userModelCredential.findMany({
              where: {
                userId: context.actor.userId,
                provider: modelCredentialProviderFilter(input.provider),
              },
            }),
          ]);
          return {
            preferences,
            candidates: defaultModelCredentialCandidates({
              provider: input.provider,
              modelId: input.modelId,
              preferences,
              credentials,
            }),
          };
        };
        await withTransactionRetry(async () => {
          const preparedState = await loadModelState(deps.prisma);
          const preparedAuth = new Map(
            await Promise.all(
              preparedState.candidates.map(
                async (candidate) =>
                  [
                    candidate.secretId,
                    await prepareStoredModelAuth(
                      deps.prisma,
                      deps.secrets,
                      context.actor.userId,
                      candidate.secretId,
                      input.provider,
                      input.modelId,
                      codexCatalog,
                      {
                        onExpiredToken: () =>
                          refreshExpiredCredential(
                            context.actor,
                            candidate.secretId,
                            input.provider,
                          ),
                      },
                    ),
                  ] as const,
              ),
            ),
          );
          const needsThinking =
            input.thinkingLevel === undefined
              ? (await savedChoices(deps.prisma)).some((choice) => Boolean(choice.thinkingLevel))
              : Boolean(input.thinkingLevel);
          const compatible = input.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
          // Compatible defaults always load the secret so the transaction rechecks it.
          const thinking =
            needsThinking || compatible
              ? await prepareAllowedThinkingLevels(
                  deps,
                  context.actor,
                  input.provider,
                  input.modelId,
                )
              : { allowed: undefined, secret: undefined };
          if (compatible) {
            await assertCompatibleDefaultChange(deps, context.actor, modelId, thinking);
          }
          return deps.prisma.$transaction(
            async (tx) => {
              const { preferences, candidates } = await loadModelState(tx);
              if (candidates.length === 0) {
                throw new ORPCError("NOT_FOUND", {
                  message: `No model credential is connected for ${input.provider}.`,
                });
              }
              if (thinking.secret) {
                const current = await tx.secret.findFirst({
                  where: { id: thinking.secret.id, userId: context.actor.userId, spaceId: null },
                  select: { ciphertext: true },
                });
                if (current?.ciphertext !== thinking.secret.ciphertext) {
                  throw new ORPCError("CONFLICT", { message: "Model credentials changed; retry." });
                }
              }
              const savedModelId = new Map(
                preferences.map((preference) => [preference.credential.id, preference.modelId]),
              );
              const readyIds: string[] = [];
              let authFailure: string | undefined;
              let sawReadable = false;
              for (const candidate of candidates) {
                const prepared = preparedAuth.get(candidate.secretId);
                const current = await tx.secret.findFirst({
                  where: { id: candidate.secretId, userId: context.actor.userId, spaceId: null },
                  select: { id: true, ciphertext: true },
                });
                if (!prepared || (current?.ciphertext ?? null) !== prepared.ref) {
                  throw new ORPCError("CONFLICT", { message: "Model credentials changed; retry." });
                }
                const auth = prepared.auth;
                if (auth.status === "unreadable") continue;
                sawReadable = true;
                if (auth.status === "rejected") {
                  authFailure ??= auth.message;
                  continue;
                }
                // The enabled-list check and execution must use the same connection.
                if (compatible && thinking.secret && candidate.secretId !== thinking.secret.id)
                  continue;
                readyIds.push(candidate.id);
              }
              const chosenId = selectDefaultCredentialId({
                provider: input.provider,
                modelId: input.modelId,
                orderedIds: candidates.map((candidate) => candidate.id),
                readyIds,
                savedModelId: (credentialId) => savedModelId.get(credentialId),
              });
              const fallbackId = !sawReadable ? candidates[0]?.id : undefined;
              const credentialId = chosenId ?? fallbackId;
              if (!credentialId) {
                throw new ORPCError("BAD_REQUEST", {
                  message: authFailure ?? UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
                });
              }
              const saved = input.thinkingLevel === undefined ? await savedChoices(tx) : [];
              let thinkingLevel: string | null =
                input.thinkingLevel === undefined
                  ? ((saved.find((choice) => choice.credentialId === credentialId) ?? saved[0])
                      ?.thinkingLevel ?? null)
                  : input.thinkingLevel;
              if (thinkingLevel) {
                if (!needsThinking) {
                  throw new ORPCError("CONFLICT", { message: "Model preferences changed; retry." });
                }
                thinkingLevel = clampCatalogThinkingLevel(thinkingLevel, thinking.allowed);
              }
              await writeModelRole(tx, await modelRoleTarget(tx, context.actor), "main", {
                primary: {
                  provider: input.provider,
                  modelId,
                  thinkingLevel: thinkingLevel as ThinkingLevel | null,
                  credentialId,
                },
              });
              // Older apps edit one model per connection here, so it becomes the connection's own.
              await saveModelPreference(tx, context.actor, credentialId, modelId, thinkingLevel);
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        }).catch((error: unknown) => {
          if (error instanceof SecretStoreUnavailableError)
            throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
          throw error;
        });
        return { ok: true as const };
      }),
      rename: authed.models.rename.handler(async ({ context, input }) => {
        const renamed = await deps.prisma.userModelCredential.updateMany({
          where: { id: input.credentialId, userId: context.actor.userId },
          data: { label: input.label },
        });
        if (renamed.count === 0)
          throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
        return { ok: true as const };
      }),
      disconnect: authed.models.disconnect.handler(async ({ context, input }) => {
        // Retire pending sign-ins in every space first — the credentials are
        // account-wide, so a finishing OAuth session anywhere could otherwise
        // re-persist a credential the delete below just removed. Removing one
        // connection leaves sign-ins that add another account running.
        await deps.oauthLogins.cancelProvider({
          userId: context.actor.userId,
          provider: input.provider,
          credentialId: input.credentialId,
        });
        await withTransactionRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const provider = modelCredentialProviderFilter(input.provider);
              const connections = await tx.userModelCredential.findMany({
                where: { userId: context.actor.userId, provider },
              });
              // Older apps disconnect every connection of the provider.
              const existing = input.credentialId
                ? connections.filter((row) => row.id === input.credentialId)
                : connections;
              if (input.credentialId && existing.length === 0) return;
              const ids = existing.map((row) => row.id);
              const lastConnection = existing.length === connections.length;
              const roleRows = {
                userId: context.actor.userId,
                provider,
                OR: [
                  { credentialId: { in: ids } },
                  // Rows that name no connection ran on the provider's last one.
                  ...(lastConnection ? [{ credentialId: null }] : []),
                ],
              };
              // Its models leave every purpose in the account's models and every Space's,
              // like the connection itself; the tenant scope would otherwise limit the
              // Space deletes to the active Space.
              await tx.userModelRoleChoice.deleteMany({ where: roleRows });
              await runAsSystemInTransaction(
                tx,
                "disconnect a model connection from every Space",
                async () => {
                  await tx.spaceModelRoleChoice.deleteMany({ where: roleRows });
                },
              );
              if (existing.length === 0) return;
              // Credentials are account-wide, so disconnecting removes them from every Space.
              await tx.userModelCredential.deleteMany({
                where: { userId: context.actor.userId, id: { in: ids } },
              });
              for (const row of existing) {
                await deleteUnreferencedCredentialSecret(tx, {
                  credentialKind: "model",
                  credentialId: row.id,
                  secretId: row.secretId,
                });
              }
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        (deps.providerCatalog ?? providerCatalogCache).invalidate(
          canonicalPiProviderId(input.provider),
        );
        return { ok: true as const };
      }),
    },
  };
}
