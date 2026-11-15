import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { CodexLiveCatalog } from "@rakazo/adapters";
import {
  CHATGPT_OAUTH_PROVIDER,
  codexLiveModel,
  findConnectedModelCredential,
  knownModelImageInput,
  modelAcceptsImageInput,
  modelIdSupportsImages,
  parseModelSecret,
  resolveMemberMainModel,
  runModelChoice,
  runtimeModelAcceptsImages,
  selectConfiguredModel,
} from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { MODEL_IMAGE_INPUT_ERROR, MODEL_IMAGE_INPUT_UNKNOWN } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { appliedModelRole, findModelCredential, findModelCredentialById } from "@rakazo/db";

type ModelChoice = {
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};
export type ImageAdmissionRun = ModelChoice & {
  status: string;
  modelPinned?: boolean;
  trigger?: string | null;
};

/** Never refresh credentials while admitting a send. A supplied Codex catalog may answer image input. */
export async function assertThreadImageInput(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
  blocks: MessageBlock[],
  run?: ImageAdmissionRun,
  configuration?: {
    secrets: Pick<SecretStore, "load">;
    deployment: { provider: string; model: string } | null;
    hostedProvider?: string;
    codexCatalog?: CodexLiveCatalog;
  },
) {
  if (!blocks.some((block) => block.kind === "image")) return;
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  if (!bot) return;
  // A running turn has already selected its model, including any backup switch.
  const running = run?.status === "running" && run.modelProvider && run.modelId;
  const override = running ? run : run ? runModelChoice(run, bot) : bot;
  const overrideCredential =
    override.modelProvider && override.modelId
      ? configuration
        ? await findConnectedModelCredential(
            prisma,
            configuration.secrets,
            actor,
            override.modelProvider,
            override.modelId,
          )
        : await findModelCredential(prisma, actor, override.modelProvider, override.modelId)
      : null;
  const selected = selectConfiguredModel({
    override,
    overrideCredential,
    main: configuration
      ? await resolveMemberMainModel({ prisma, secretStore: configuration.secrets }, actor)
      : await mainModelWithoutSecrets(prisma, actor),
    defaults: {
      settings: await prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      deployment: configuration?.deployment ?? null,
    },
    hostedProvider: configuration?.hostedProvider,
  });
  const provider = running ? run.modelProvider : selected.provider;
  const id = running ? run.modelId : selected.id;
  if (!provider || !id) return;
  let supportsImages = knownModelImageInput(provider, id);
  if (provider === "openai-compatible" && configuration) {
    const credential = running ? overrideCredential : selected.credential;
    if (credential) {
      const row = await prisma.secret.findFirst({
        where: { id: credential.secretId, userId: actor.userId, spaceId: null },
      });
      if (row) {
        const legacy = await prisma.userModelCredential.findFirst({
          where: { id: credential.id, userId: actor.userId },
          select: { supportsImages: true },
        });
        const secret = parseModelSecret(await configuration.secrets.load(row.ciphertext, row.id));
        if (secret.kind === "openai_compatible") {
          // A custom endpoint is never known to be text-only: without image input turned on,
          // its capability is unknown, so the user is asked to configure it.
          supportsImages =
            modelAcceptsImageInput(provider, id) ||
            modelIdSupportsImages(secret.visionModelIds, id) ||
            (secret.visionModelIds === undefined &&
              credential.defaultModel?.trim() === id.trim() &&
              legacy?.supportsImages === true) ||
            undefined;
        }
      }
    }
  }
  if (provider === CHATGPT_OAUTH_PROVIDER && configuration?.codexCatalog) {
    const credential = running ? overrideCredential : selected.credential;
    if (credential) {
      try {
        const row = await prisma.secret.findFirst({
          where: { id: credential.secretId, userId: actor.userId, spaceId: null },
        });
        if (row) {
          const secret = parseModelSecret(await configuration.secrets.load(row.ciphertext, row.id));
          const live = await codexLiveModel(configuration.codexCatalog, actor.userId, secret, id, {
            waitMs: 0,
          });
          if (live?.supportsImages !== undefined) supportsImages = live.supportsImages;
        }
      } catch {
        // An unreadable secret keeps the bundled or unknown answer.
      }
    }
  }
  const unknownInput = supportsImages === undefined && !runtimeModelAcceptsImages(provider, id);
  if (supportsImages === false || unknownInput)
    throw new ORPCError("CONFLICT", {
      message: unknownInput ? MODEL_IMAGE_INPUT_UNKNOWN : MODEL_IMAGE_INPUT_ERROR,
      data: { reason: "model_image_input_unsupported" },
    });
}

/** The main model as resolveMemberMainModel picks it, without reading secrets. */
async function mainModelWithoutSecrets(prisma: PrismaClient, actor: Actor) {
  const { primary } = await appliedModelRole(prisma, actor, "main");
  if (!primary) return null;
  return {
    ...primary,
    credential: primary.credentialId
      ? await findModelCredentialById(prisma, actor, primary.credentialId, primary.provider)
      : await findModelCredential(prisma, actor, primary.provider, primary.modelId),
  };
}
