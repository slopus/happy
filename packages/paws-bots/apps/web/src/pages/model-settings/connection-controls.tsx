import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Button, Disclosure, Input } from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ModelPreflightFeedback,
  modelPreflightTestingLabel,
} from "../../components/ModelConnectionPreflightNotice";
import { CompatibleKeyField } from "./compatible-key-field";

import type { ModelSettingsState } from "./use-model-settings";

export function ConnectionControls({
  acceptsKey,
  accountId,
  apiKey,
  beginSelectedSubscriptionSignIn,
  busy,
  cancelOAuthAttempt,
  routingReady,
  codeCopied,
  connectKey,
  copyOAuthCode,
  credential,
  gatewayId,
  needsRouting,
  needsGateway,
  isOpenAiCompatible,
  oauth,
  oauthPending,
  pasteCode,
  pending,
  popupBlocked,
  preflightFailure,
  preflightSuccess,
  preflightTarget,
  preflightTesting,
  selected,
  setAccountId,
  setGatewayId,
  setPasteCode,
  submitOAuthCode,
  subscriptionSignIn,
  testApiKeyConnection,
  testOAuthConnection,
  updateApiKey,
}: Pick<
  ModelSettingsState,
  | "acceptsKey"
  | "accountId"
  | "apiKey"
  | "beginSelectedSubscriptionSignIn"
  | "busy"
  | "cancelOAuthAttempt"
  | "routingReady"
  | "codeCopied"
  | "connectKey"
  | "copyOAuthCode"
  | "credential"
  | "gatewayId"
  | "needsRouting"
  | "needsGateway"
  | "isOpenAiCompatible"
  | "oauth"
  | "oauthPending"
  | "pasteCode"
  | "pending"
  | "popupBlocked"
  | "preflightFailure"
  | "preflightSuccess"
  | "preflightTarget"
  | "preflightTesting"
  | "selected"
  | "setAccountId"
  | "setGatewayId"
  | "setPasteCode"
  | "submitOAuthCode"
  | "subscriptionSignIn"
  | "testApiKeyConnection"
  | "testOAuthConnection"
  | "updateApiKey"
>) {
  const { t } = useLingui();
  // Signed in with a subscription, a key is an alternative, so it stays folded until asked for.
  const [keyShownFor, setKeyShownFor] = useState<string | null>(null);
  const keyFolded =
    subscriptionSignIn &&
    credential?.authKind === "oauth" &&
    keyShownFor !== (selected?.provider ?? null);
  // Opening the fold swaps the summary for the form, so focus moves to the key field.
  useEffect(() => {
    if (keyShownFor) document.getElementById("model-api-key")?.focus();
  }, [keyShownFor]);
  return !isOpenAiCompatible ? (
    <>
      {subscriptionSignIn ? (
        <div className="mt-5 flex flex-wrap items-center gap-2 first:mt-0">
          {oauth ? (
            <div className="w-full rounded-xl border border-border px-4 py-3">
              {oauth.mode === "auth-url" ? (
                <>
                  <p className="text-body-sm leading-[1.5] text-muted-foreground">
                    <Trans>
                      Sign in at{" "}
                      <a
                        href={oauth.verificationUri}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground underline"
                      >
                        {new URL(oauth.verificationUri).hostname}
                      </a>
                      , then paste the code here.
                    </Trans>
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Input
                      value={pasteCode}
                      onChange={(e) => setPasteCode(e.target.value)}
                      aria-label={t`Authorization code`}
                      autoComplete="off"
                      spellCheck={false}
                      className="text-foreground md:text-body-sm"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!pasteCode.trim()}
                      onClick={() => void submitOAuthCode()}
                    >
                      <Trans>Submit</Trans>
                    </Button>
                  </div>
                  <p className="mt-2 text-body-sm leading-[1.5] text-muted-foreground">
                    <Plural
                      value={Math.ceil(oauth.expiresInSeconds / 60)}
                      one="Waiting for sign-in — the link expires in about # minute."
                      other="Waiting for sign-in — the link expires in about # minutes."
                    />
                  </p>
                </>
              ) : (
                <>
                  <p className="text-body-sm leading-[1.5] text-muted-foreground">
                    {popupBlocked ? (
                      <Trans>
                        Open{" "}
                        <a
                          href={oauth.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground underline"
                        >
                          {oauth.verificationUri.replace(/^https:\/\//, "")}
                        </a>{" "}
                        and enter this code:
                      </Trans>
                    ) : (
                      <Trans>
                        A sign-in tab opened at{" "}
                        <a
                          href={oauth.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground underline"
                        >
                          {oauth.verificationUri.replace(/^https:\/\//, "")}
                        </a>
                        . Enter this code there — this window keeps waiting:
                      </Trans>
                    )}
                  </p>
                  <div className="mt-2 flex items-center gap-3">
                    <p className="font-mono text-heading2 tracking-[0.2em] text-foreground">
                      {oauth.userCode}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => copyOAuthCode(oauth.userCode)}
                    >
                      {codeCopied ? (
                        <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                      ) : (
                        <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
                      )}
                      {codeCopied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                    </Button>
                  </div>
                  <p className="mt-2 text-body-sm leading-[1.5] text-muted-foreground">
                    <Plural
                      value={Math.ceil(oauth.expiresInSeconds / 60)}
                      one="Waiting for sign-in — the code expires in about # minute."
                      other="Waiting for sign-in — the code expires in about # minutes."
                    />
                  </p>
                </>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 -ml-2 text-muted-foreground"
                onClick={() => cancelOAuthAttempt()}
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => beginSelectedSubscriptionSignIn()}
            >
              {oauthPending ? (
                <Trans>Starting…</Trans>
              ) : credential?.authKind === "oauth" ? (
                <Trans>Sign in again</Trans>
              ) : (
                (selected?.oauthLabel ?? t`Sign in`)
              )}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || preflightTesting || credential?.authKind !== "oauth"}
            onClick={() => void testOAuthConnection()}
          >
            {modelPreflightTestingLabel(
              preflightTesting && preflightTarget === "sign-in",
              "sign-in",
            )}
          </Button>
          {preflightTarget === "sign-in" ? (
            <div className="w-full">
              <ModelPreflightFeedback success={preflightSuccess} failure={preflightFailure} />
            </div>
          ) : null}
        </div>
      ) : null}

      {acceptsKey && keyFolded ? (
        // Only the summary shows here; opening it swaps in the key form below.
        <Disclosure
          className="mt-5 text-body-sm leading-[1.5] text-muted-foreground"
          open={false}
          onOpenChange={() => setKeyShownFor(selected?.provider ?? null)}
          summary={<Trans>Or paste an API key</Trans>}
        >
          {null}
        </Disclosure>
      ) : acceptsKey ? (
        <div className="mt-5 first:mt-0">
          {needsRouting ? (
            <>
              <label className="block text-body text-muted-foreground" htmlFor="model-account-id">
                <Trans>Account ID</Trans>
                <Input
                  id="model-account-id"
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 h-10 text-foreground"
                />
              </label>
              {needsGateway ? (
                <label
                  className="mt-4 block text-body text-muted-foreground"
                  htmlFor="model-gateway-id"
                >
                  <Trans>Gateway ID</Trans>
                  <Input
                    id="model-gateway-id"
                    value={gatewayId}
                    onChange={(event) => setGatewayId(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2 h-10 text-foreground"
                  />
                </label>
              ) : null}
            </>
          ) : null}
          {acceptsKey ? (
            <label
              className={`block text-body text-muted-foreground ${needsRouting ? "mt-4" : ""}`}
              htmlFor="model-api-key"
            >
              {credential?.hasKey ? (
                <Trans>Replace API key</Trans>
              ) : subscriptionSignIn ? (
                <Trans>Or paste an API key</Trans>
              ) : (
                <Trans>API key</Trans>
              )}
              <Input
                id="model-api-key"
                value={apiKey}
                onChange={(event) => updateApiKey(event.target.value)}
                placeholder={credential?.hasKey ? t`Paste a replacement key` : "sk-…"}
                type="password"
                autoComplete="new-password"
                className="mt-2 h-10 text-foreground"
              />
            </label>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {acceptsKey && selected?.catalogProbe ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || preflightTesting || apiKey.trim().length < 8}
                onClick={() => void testApiKeyConnection()}
              >
                {modelPreflightTestingLabel(
                  preflightTesting && preflightTarget === "api-key",
                  "api-key",
                )}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !routingReady || apiKey.trim().length < 8}
              onClick={() => void connectKey()}
            >
              {pending === "connect" ? (
                <Trans>Saving…</Trans>
              ) : credential?.hasKey ? (
                <Trans>Replace API key</Trans>
              ) : (
                <Trans>Connect API key</Trans>
              )}
            </Button>
          </div>
          {preflightTarget === "api-key" ? (
            <ModelPreflightFeedback success={preflightSuccess} failure={preflightFailure} />
          ) : null}
        </div>
      ) : null}

      {selected?.auth === "oauth" && !subscriptionSignIn ? (
        <p className="mt-5 text-body-sm leading-[1.5] text-muted-foreground first:mt-0">
          <Trans>
            This subscription sign-in is not available in Rakazo yet. Use a deployment credential or
            choose another provider.
          </Trans>
        </p>
      ) : null}
    </>
  ) : null;
}

export function CompatibleKeyControls({
  apiKey,
  busy,
  connectKey,
  credential,
  endpointPreset,
  isOpenAiCompatible,
  openAiCompatibleReady,
  pending,
  updateApiKey,
}: Pick<
  ModelSettingsState,
  | "apiKey"
  | "busy"
  | "connectKey"
  | "credential"
  | "endpointPreset"
  | "isOpenAiCompatible"
  | "openAiCompatibleReady"
  | "pending"
  | "updateApiKey"
>) {
  const { t } = useLingui();
  return isOpenAiCompatible ? (
    <div className="mt-5">
      <CompatibleKeyField
        keyRequired={Boolean(endpointPreset)}
        className="block text-body text-muted-foreground"
      >
        <Input
          aria-label={t`API key`}
          value={apiKey}
          onChange={(event) => updateApiKey(event.target.value)}
          required={Boolean(endpointPreset)}
          placeholder={
            credential?.hasKey
              ? t`Paste a replacement key`
              : endpointPreset
                ? undefined
                : t`Optional`
          }
          type="password"
          autoComplete="new-password"
          className="mt-2 h-10 text-foreground"
        />
      </CompatibleKeyField>
      <Button
        type="button"
        variant="secondary"
        className="mt-3"
        size="sm"
        disabled={busy || !openAiCompatibleReady}
        onClick={() => void connectKey()}
      >
        {pending === "connect" ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
      </Button>
    </div>
  ) : null;
}
