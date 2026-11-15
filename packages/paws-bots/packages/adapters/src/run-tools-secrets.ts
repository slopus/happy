import { BotSecretName, botSecretSubmissionSchema } from "@rakazo/contracts";
import { createStreamingRedactor, displayName } from "@rakazo/core";
import { runCodeKind, runLoginKind, runSecretKind, spaceIsShared } from "@rakazo/db";
import {
  completeExternalEffect,
  replaceCompletedExternalEffectResult,
  resolveDuplicateEffectGate,
  settleUncertainEffect,
  uncertainEffectResult,
} from "./approval-effect.js";
import {
  allowPrivateHttpSecretOrigins,
  botSecretToolView,
  canReplaceLoginSite,
  findBotSecret,
  findCommandVariableConflict,
  findRunLogin,
  findSiteLogin,
  forgetBotSecret,
  generateBotSecret,
  HIDDEN_ITEM,
  listBotSecrets,
  loginToolHints,
  normalizeSecretDestination,
  oneTimeCodeRedactions,
  readRunCode,
  requestedLoginFields,
  requestWithBotSecret,
  resolveRequestSecretDestination,
  sameSecretDestination,
} from "./bot-secrets.js";
import {
  addRunSecrets,
  pauseForSecret,
  persistTurnCheckpoint,
  recordVaultUse,
} from "./run-context.js";
import { recordEffect } from "./run-effects.js";
import { enqueueSteeringContinuation, renewRunLease } from "./run-lifecycle.js";
import { notifyRun, secretAskNotification } from "./run-notifications.js";
import {
  commitConsumedRunSecret,
  normalizeSecretAskPurpose,
  reconcileManagedConnection,
  resolveMissingRunSecretAction,
  tryCompleteConnectionWithCode,
} from "./run-secret.js";
import type { ToolHandlers } from "./run-tool-gate.js";

/** Saved credentials and protected input. */
export const secretTools: ToolHandlers = {
  async list_secrets(ctx) {
    const { deps, run } = ctx;
    return listBotSecrets(deps.prisma, deps.secretStore, run);
  },
  async forget_secret(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    const parsed = BotSecretName.safeParse(args.name);
    if (!parsed.success) return call.finish({ error: "A valid credential name is required." });
    // This run's unsaved login comes before a saved one of the name, as it does for fills.
    const forgotten = await deps.prisma.secret.deleteMany({
      where: { userId: run.userId, spaceId: run.spaceId, kind: runLoginKind(run.id, parsed.data) },
    });
    if (forgotten.count > 0) return call.finish({ removed: true });
    return call.finish(await forgetBotSecret(deps.prisma, run, parsed.data));
  },
  async generate_secret(ctx, call) {
    const { deps, run } = ctx;
    // Fills would type this run's unsaved login instead of the generated one.
    const held = await deps.prisma.secret.count({
      where: {
        userId: run.userId,
        spaceId: run.spaceId,
        kind: runLoginKind(run.id, String(call.args.name ?? "")),
      },
    });
    if (held > 0) {
      return call.finish({
        error: "This run holds a login under this name that wasn't saved. Use another name.",
      });
    }
    const { result, redactions } = await generateBotSecret({
      prisma: deps.prisma,
      secretStore: deps.secretStore,
      scope: run,
      args: call.args,
    });
    if (redactions) addRunSecrets(ctx, redactions);
    return call.finish(result);
  },
  async secret_request(ctx, call) {
    const { deps, run, context } = ctx;
    const { args } = call;
    try {
      const result = await requestWithBotSecret({
        prisma: deps.prisma,
        secretStore: deps.secretStore,
        scope: run,
        request: args,
        signal: context.signal,
        remote: deps.secretHttp,
        registerRedactions: (values) => addRunSecrets(ctx, values),
        recordUse: (item, site) => recordVaultUse(ctx, call.name, item, site),
      });
      return call.finish(result);
    } catch {
      return call.finish({ error: "Invalid authenticated request." });
    }
  },
  async request_secret(ctx, call) {
    const { deps, run, runId, bot, thread, context } = ctx;
    const { name, args, executionId, effectKey, applied } = call;
    const { reply } = ctx.state;
    const resolvedSecret = resolveRequestSecretDestination(args);
    if (resolvedSecret.error) return call.finish({ error: resolvedSecret.error });
    let destination = resolvedSecret.destination;
    const connectionId = resolvedSecret.connectionId;
    const codeOrigin = resolvedSecret.oneTimeCodeOrigin;
    const loginFields =
      destination?.auth.type === "login" ? requestedLoginFields(args.fields) : undefined;
    if (loginFields?.error) return call.finish({ error: loginFields.error });
    // A saved login whose site was wrong is replaced only from a card answered for this site.
    let replaces: { id: string; origin: string } | undefined;
    if (destination) {
      const found = await findBotSecret(deps.prisma, run, destination.name);
      if (found && "hidden" in found) return call.finish({ error: HIDDEN_ITEM });
      const saved = found ?? undefined;
      const existing = saved?.destination;
      // One of the login's other sites, which only its owner sets, is the same login: it is asked
      // for and saved at its own site, so a bot can't move it.
      if (
        existing &&
        saved.alsoOn.includes(destination.origin) &&
        sameSecretDestination({ ...existing, origin: destination.origin }, destination)
      )
        destination = existing;
      // A login the person chose not to save stays with this run; the bot is told so it doesn't
      // say it was saved. Field labels only, never values.
      const runLogin =
        destination.auth.type === "login"
          ? await findRunLogin(deps.prisma, deps.secretStore, run, runId, destination.name)
          : undefined;
      const held = runLogin?.origin === destination.origin ? runLogin : undefined;
      if (existing && !sameSecretDestination(existing, destination)) {
        if (!canReplaceLoginSite(existing, destination)) {
          return call.finish({
            error: "Remove the existing credential before changing its destination.",
          });
        }
        if (args.replace !== true && !held) {
          return call.finish({
            error: `A login named ${existing.name} is saved for ${existing.origin}. For a different site or account, use another name; ask again with replace true only if ${existing.origin} was the wrong site for this same account, which replaces the saved login.`,
          });
        }
        if (saved) replaces = { id: saved.id, origin: existing.origin };
      }
      const conflict = await findCommandVariableConflict(deps.prisma, run, destination);
      if (conflict) {
        return call.finish({
          error: `Invalid credential destination — name: ${conflict} is already exported as the same variable. Choose another name.`,
        });
      }
      const known = held
        ? {
            saved: false,
            ...destination,
            fields: held.fields.map(({ label, hidden }) => ({ label, hidden })),
          }
        : existing && sameSecretDestination(existing, destination)
          ? {
              saved: true,
              ...botSecretToolView(existing),
              ...(await loginToolHints(deps.prisma, deps.secretStore, run, existing.name)),
            }
          : undefined;
      const submitted = botSecretSubmissionSchema({
        allowPrivateHttpOrigin: allowPrivateHttpSecretOrigins(),
      }).safeParse(applied?.effect.result).data;
      if (
        submitted &&
        sameSecretDestination(normalizeSecretDestination(submitted.credentialSaved), destination)
      ) {
        return call.finish(known ?? { error: "The saved credential is no longer available." });
      }
      if (known && args.replace !== true) return call.finish(known);
      // A login saved for this exact site under another name is the one to fill.
      const siteLogin =
        !known && destination.auth.type === "login" && args.replace !== true
          ? await findSiteLogin(deps.prisma, run, destination.origin)
          : null;
      if (siteLogin)
        return call.finish({
          saved: true,
          ...botSecretToolView(siteLogin),
          ...(await loginToolHints(deps.prisma, deps.secretStore, run, siteLogin.name)),
        });
      // A card shows neither a login's authenticator key nor its other sites, which only its
      // owner sets, for the site it has. So a card never moves a login that has them: its
      // owner changes the site in the Vault, where both are in sight.
      if (replaces) {
        const kept = await loginToolHints(deps.prisma, deps.secretStore, run, destination.name);
        if (kept.alsoOn || kept.authenticatorCode)
          return call.finish({
            error:
              `The login ${destination.name} has an authenticator key or other sites, which ` +
              "only the user sets, so a card can't move it to another site. Ask the user to " +
              "change its site in the Vault, or use another name for a different account.",
          });
      }
      // Action approval authorizes showing the card; it is not a credential submission.
      // Return the claim to intended so the answer transaction can approve the saved value.
      if (call.claimedEffect) {
        const released = await deps.prisma.externalEffect.updateMany({
          where: { id: applied!.effect.id, status: "executing" },
          data: { status: "intended" },
        });
        if (released.count !== 1) return uncertainEffectResult(name);
        call.claimedEffect = false;
      }
    }
    const secretKind = codeOrigin ? runCodeKind(runId) : runSecretKind(runId);
    let storedSecret = await deps.prisma.secret.findFirst({
      where: {
        spaceId: run.spaceId,
        userId: run.userId,
        kind: secretKind,
      },
    });
    // A card not yet answered means a code left from an earlier one is stale, and one that cannot
    // be read is no code: ask again.
    const heldCode =
      storedSecret && codeOrigin ? await readRunCode(deps.secretStore, storedSecret) : undefined;
    if (storedSecret && codeOrigin && (!heldCode || applied?.effect.status === "intended")) {
      await deps.prisma.secret.deleteMany({ where: { id: storedSecret.id } });
      if (!heldCode && applied?.effect.status !== "intended") {
        return call.finish({
          error: "The code could not be read. Ask for it again with request_secret oneTimeCode.",
        });
      }
      storedSecret = null;
    }
    if (storedSecret) {
      const plaintext = heldCode
        ? heldCode.code
        : await deps.secretStore.load(storedSecret.ciphertext, storedSecret.id);
      ctx.secrets.push(...(heldCode ? oneTimeCodeRedactions(plaintext) : [plaintext]));
      // Keep the tail the old redactor still holds; a fresh instance drops it.
      reply.pendingProgress += reply.redactor.finish();
      reply.redactor = createStreamingRedactor(ctx.secrets);
      const purpose = String(args.purpose ?? "otp");
      if (applied && !call.claimedEffect) {
        if (applied.effect.status === "intended") {
          const early = await call.claimOrReturn("intended");
          if (early !== undefined) return early;
        } else if (applied.effect.status === "approved") {
          const early = await call.claimOrReturn("approved");
          if (early !== undefined) return early;
        }
      }
      const recordedEffect = await recordEffect(deps, run, name, effectKey, args);
      if (recordedEffect?.duplicate) {
        const gate = resolveDuplicateEffectGate(recordedEffect.effect, name);
        if (gate.action === "execute") {
          const early = await call.claimOrReturn("approved");
          if (early !== undefined) return early;
        }
      }
      // The code waits for browser_act fill_code, which deletes it once the page took it.
      if (codeOrigin) {
        return call.finish({
          ok: true,
          submitted: true,
          note: "The user entered the code. Type it with browser_act fill_code {ref}; you never see it.",
        });
      }
      // Claim executing (above), take the secret, then connector complete().
      // Retries without a secret reconcile via connectionReady / settle_attempt.
      return commitConsumedRunSecret({
        deleteSecret: async () => {
          await deps.prisma.secret.delete({
            where: { id: storedSecret.id },
          });
        },
        afterSecretTaken: async () => {
          let connectionResult: { connected: boolean; error?: string } | undefined;
          if (connectionId) {
            connectionResult = await tryCompleteConnectionWithCode(
              deps.prisma,
              deps.connectors,
              run,
              context,
              connectionId,
              plaintext,
            );
          }
          return purpose === "password" && !connectionId
            ? {
                ok: true,
                submitted: true,
                note: "The secret was not typed onto the computer. To reuse a website login, save it with auth type login and fill it with browser_act fill_secret; otherwise use request_takeover.",
              }
            : {
                ok: true,
                submitted: true,
                ...(connectionResult
                  ? {
                      connected: connectionResult.connected,
                      ...(connectionResult.error
                        ? { connectionError: connectionResult.error }
                        : {}),
                    }
                  : {}),
              };
        },
        persist: (secretResult) =>
          applied?.duplicate && applied.effect.status === "completed"
            ? replaceCompletedExternalEffectResult(deps.prisma, applied.effect.id, secretResult)
            : call.persistEffectResult(secretResult),
        onPersistFailed: uncertainEffectResult(name),
      });
    }
    const recordedForAsk = await recordEffect(deps, run, name, effectKey, args);
    const missingSecretAction = resolveMissingRunSecretAction(recordedForAsk.effect);
    if (missingSecretAction.action === "return") return missingSecretAction.result;
    if (connectionId) {
      const connectionStatus = await reconcileManagedConnection(
        deps.prisma,
        deps.connectors,
        run,
        context,
        connectionId,
      );
      if (connectionStatus === "connected") {
        const connectedResult = {
          ok: true,
          submitted: true,
          connected: true,
        };
        if (recordedForAsk.effect.status === "executing") {
          return (await completeExternalEffect(
            deps.prisma,
            recordedForAsk.effect.id,
            "executing",
            connectedResult,
          ))
            ? connectedResult
            : uncertainEffectResult(name);
        }
        return (await call.persistEffectResult(connectedResult))
          ? connectedResult
          : uncertainEffectResult(name);
      }
    }
    if (missingSecretAction.action === "settle_attempt") {
      // Secret was taken and connector may have consumed the OTP; do not re-ask.
      const failedAttempt = {
        ok: true,
        submitted: true,
        connected: false,
        connectionError: "Connection could not be completed.",
      };
      if (recordedForAsk.effect.status === "executing") {
        return (await completeExternalEffect(
          deps.prisma,
          recordedForAsk.effect.id,
          "executing",
          failedAttempt,
        ))
          ? failedAttempt
          : uncertainEffectResult(name);
      }
      return settleUncertainEffect(deps.prisma, recordedForAsk.effect.id, "request_secret");
    }
    // A code card names the site itself, so a label cannot pose as another one.
    const askText = codeOrigin
      ? `Code for ${new URL(codeOrigin).host}`
      : String(args.label ?? "Code");
    if (!(await renewRunLease(deps, runId, ctx.workerId, ctx.fence))) {
      return pauseForSecret(ctx);
    }
    await ctx.computer.checkpoint.flush();
    await persistTurnCheckpoint(ctx, executionId);
    await ctx.settleRunningHelpers();
    const paused = await deps.events.pauseRunForInput({
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId,
      attemptId: ctx.attempt.id,
      leaseOwner: ctx.workerId,
      leaseFence: ctx.fence,
      blocks: [
        {
          kind: "ask",
          text: askText,
          // The site is the server's words in the title; the bot's own label is plain detail.
          ...(codeOrigin && args.label ? { detail: String(args.label).slice(0, 200) } : {}),
          input: "secret",
          ...(destination ? { credential: destination } : {}),
          ...(codeOrigin ? { oneTimeCode: { origin: codeOrigin } } : {}),
          ...(replaces ? { replaces } : {}),
          ...(loginFields?.labels ? { loginFields: loginFields.labels } : {}),
          ...(loginFields && (await spaceIsShared(deps.prisma, run.spaceId))
            ? { sharedBrowser: true as const }
            : {}),
          purpose: codeOrigin
            ? "otp"
            : normalizeSecretAskPurpose(args.purpose ? String(args.purpose) : undefined),
          status: "pending",
        },
      ],
    });
    if (!paused) {
      throw new Error("Could not pause this run for protected input; try sending again.");
    }
    await enqueueSteeringContinuation(deps, paused.continuationRunId);
    await notifyRun(deps, run, {
      kind: "help",
      ...secretAskNotification(displayName(bot.name, "Bot"), askText, ctx.secrets),
      botId: bot.id,
      threadId: thread.id,
    });
    return pauseForSecret(ctx);
  },
};
